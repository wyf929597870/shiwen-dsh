import {createHash} from 'node:crypto';

const hash = value => createHash('sha256').update(stableJson(value)).digest('hex');
function stableJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  throw new TypeError('Session request must contain plain JSON values');
}

/** Test-only in-memory ledger. Production durability and routing are deliberately out of scope. */
export class MemorySessionLedger {
  #requests = new Map();
  #cursors = new Map();
  getRequest(requestId) { return this.#requests.get(requestId); }
  putRequest(request) { this.#requests.set(request.requestId, structuredClone(request)); }
  getCursor(sessionId) { return this.#cursors.get(sessionId) ?? -1; }
  putCursor(sessionId, cursor) { this.#cursors.set(sessionId, cursor); }
}

/**
 * Isolated mobile-to-DSH session adapter prototype. It requires an injected DSH controller
 * and ledger; it does not create a server, route, subprocess, or model request itself.
 */
export function createMobileSessionAdapter({controller, ledger}) {
  if (!controller || !ledger) throw new TypeError('controller and ledger are required');
  const inflight = new Map();

  async function send(request) {
    validatePromptRequest(request);
    const requestHash = hash({sessionId: request.sessionId, mode: request.mode, content: request.content,
      ...(request.clientTimeZone === undefined ? {} : {clientTimeZone: request.clientTimeZone})});
    const prior = ledger.getRequest(request.requestId);
    if (prior) {
      if (prior.hash !== requestHash) throw codedError('REQUEST_ID_REUSED', 'requestId already identifies different prompt content');
      return publicRequest(prior);
    }
    if (inflight.has(request.requestId)) return inflight.get(request.requestId);

    const operation = (async () => {
      const record = {requestId: request.requestId, sessionId: request.sessionId, hash: requestHash, status: 'prepared'};
      ledger.putRequest(record);
      try {
        const result = await controller.prompt(request, new AbortController().signal);
        record.status = result?.accepted === true ? 'accepted' : 'unknown';
      } catch {
        // A transport error can happen after Host admission. Never infer rejection and resend.
        record.status = 'unknown';
      }
      ledger.putRequest(record);
      return publicRequest(record);
    })();
    inflight.set(request.requestId, operation);
    try { return await operation; }
    finally { inflight.delete(request.requestId); }
  }

  async function reconcile(requestId, {maxPages = 8, maxMessages = 50} = {}) {
    const request = ledger.getRequest(requestId);
    if (!request) throw codedError('REQUEST_NOT_FOUND', 'No local request record exists');
    const state = await controller.state({sessionId: request.sessionId});
    let cursor = state.cursor;
    let beforeSeq;
    let observed = false;
    let pagesRead = 0;
    while (pagesRead < maxPages) {
      const page = await controller.events({address: {kind: 'session', sessionId: request.sessionId},
        ...(cursor >= 0 ? {throughSeq: cursor} : {}), ...(beforeSeq === undefined ? {} : {beforeSeq}), maxMessages});
      pagesRead++;
      for (const entry of page.records ?? []) {
        if (entry?.type === 'event' && entry.event?.type === 'user/message' && entry.event.data?.source?.rpcId === requestId) observed = true;
      }
      if (!page.hasMore || !page.records?.length) break;
      const firstSeq = page.records.reduce((min, entry) => Math.min(min, entry.event?.seq ?? Infinity), Infinity);
      if (!Number.isSafeInteger(firstSeq) || firstSeq >= (beforeSeq ?? Infinity)) break;
      beforeSeq = firstSeq;
    }
    const inQueue = Array.isArray(state.queue) && state.queue.some(item => item.rpcId === requestId);
    if (observed || inQueue) {
      request.status = 'accepted';
      ledger.putRequest(request);
    }
    return {request: publicRequest(request), state, observed: observed ? 'event' : inQueue ? 'queue' : 'not-observed-within-window',
      pagesRead};
  }

  async function cancel(sessionId) {
    const result = await controller.cancel({sessionId});
    return {status: result?.accepted === true ? 'cancel-requested' : 'unknown'};
  }

  /** Preserve the host's raw event payload and sequence while accepting a resumed stream. */
  function acceptEvent(sessionId, entry) {
    if (entry?.type !== 'event' || !Number.isSafeInteger(entry.event?.seq) || entry.event.seq < 0) {
      throw codedError('INVALID_EVENT', 'Expected a raw DSH event with a non-negative seq');
    }
    const cursor = ledger.getCursor(sessionId);
    if (entry.event.seq <= cursor) return {accepted: false, duplicate: true, cursor};
    if (cursor >= 0 && entry.event.seq !== cursor + 1) return {accepted: false, gap: true, expectedSeq: cursor + 1, receivedSeq: entry.event.seq, cursor};
    ledger.putCursor(sessionId, entry.event.seq);
    return {accepted: true, cursor: entry.event.seq, entry};
  }

  function interactionPolicy(state) {
    const pending = state?.pendingInput ?? [];
    return {pending: [...pending], requiresUser: pending.length > 0, autoApprove: false,
      message: pending.length ? 'Pending interaction requires a user decision' : undefined};
  }

  return Object.freeze({send, reconcile, cancel, acceptEvent, interactionPolicy});
}

function publicRequest(record) {
  return {requestId: record.requestId, sessionId: record.sessionId, status: record.status, hash: record.hash};
}
function validatePromptRequest(request) {
  if (!request || typeof request.requestId !== 'string' || !request.requestId || typeof request.sessionId !== 'string' || !request.sessionId) {
    throw new TypeError('requestId and sessionId are required');
  }
  if (!['queue', 'steer'].includes(request.mode) || !Array.isArray(request.content) || request.content.length === 0) {
    throw new TypeError('mode and non-empty content are required');
  }
}
function codedError(code, message) { return Object.assign(new Error(message), {code}); }
