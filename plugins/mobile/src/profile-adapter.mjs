import {createHash} from 'node:crypto';
import {personalContext} from '../../personal-context/src/index.mjs';

const PROFILE_VERSION = 1;
const MAX_CONTEXT_UTF16 = 32_000;
const MAX_SNAPSHOT_BYTES = 256 * 1024;

/** Build the mobile-safe snapshot from shiwenLibrary.agentState() output. */
export function createProfileSnapshot(state, {agentId = 'shiwen'} = {}) {
  if (!state || typeof state !== 'object') throw new TypeError('agentState is required');
  if (agentId !== 'shiwen') {
    throw Object.assign(new TypeError('This profile adapter only supports the shiwen agent'), {code: 'PROFILE_UNSUPPORTED_AGENT'});
  }
  if (!state.identity || typeof state.identity.body !== 'string' || !state.soul || typeof state.soul.body !== 'string') {
    throw new TypeError('agentState identity and soul documents are required');
  }
  const systemContext = personalContext(state);
  if (systemContext.length > MAX_CONTEXT_UTF16) {
    throw Object.assign(new RangeError(`Profile context exceeds ${MAX_CONTEXT_UTF16} UTF-16 code units`), {
      code: 'PROFILE_TOO_LARGE', actualUtf16: systemContext.length, maxUtf16: MAX_CONTEXT_UTF16,
    });
  }
  const documents = [
    {name: 'IDENTITY.md', body: state.identity.body, revision: safeRevision(state.identity.revision)},
    {name: 'SOUL.md', body: state.soul.body, revision: safeRevision(state.soul.revision)},
  ];
  const memories = (Array.isArray(state.memories) ? state.memories : [])
    .filter(memory => memory && memory.status === 'active' && memory.scope === 'global'
      && ['user', 'memory'].includes(memory.category) && typeof memory.body === 'string' && memory.body.trim())
    .map(memory => ({id: requiredString(memory.id, 'memory.id'), body: memory.body, category: memory.category,
      revision: safeRevision(memory.revision), updated: typeof memory.updated === 'string' ? memory.updated : ''}))
    .sort((a, b) => a.id.localeCompare(b.id));
  const memoryContextEntries = countMemoryContextEntries(state);
  const included = {globalActiveMemories: memories.length, memoryContextEntries,
    memoryContextOmitted: Math.max(0, memories.length - memoryContextEntries)};
  const snapshot = {version: PROFILE_VERSION, agentId, systemContext, documents, memories, included};
  snapshot.revision = createHash('sha256').update(stableJson(snapshot)).digest('hex');
  const bytes = Buffer.byteLength(JSON.stringify(snapshot));
  if (bytes > MAX_SNAPSHOT_BYTES) {
    throw Object.assign(new RangeError(`Profile snapshot is ${bytes} bytes; maximum is ${MAX_SNAPSHOT_BYTES}`), {
      code: 'PROFILE_TOO_LARGE', actualBytes: bytes, maxBytes: MAX_SNAPSHOT_BYTES,
    });
  }
  return Object.freeze(snapshot);
}
function countMemoryContextEntries(state) {
  let budget = 1800, count = 0;
  for (const memory of (Array.isArray(state.memories) ? state.memories : []).filter(row => row.status === 'active' && row.scope === 'global')) {
    const text = String(memory.body).trim();
    if (!text || text.length > budget) continue;
    count++;
    budget -= text.length;
  }
  return count;
}
function requiredString(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${field} is required`);
  return value;
}
function safeRevision(value) { return Number.isSafeInteger(value) && value >= 0 ? value : 0; }
function stableJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  throw new TypeError('Profile snapshot must contain plain JSON values');
}
