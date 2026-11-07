import test from 'node:test';
import assert from 'node:assert/strict';
import {SessionController} from '@deepseek-ai/dsh-api-session-controller';
import {createMobileSessionAdapter, MemorySessionLedger} from '../plugins/mobile/src/session-adapter.mjs';

const prompt = (text = 'hello') => ({requestId: 'mobile-request-1', sessionId: 'session-a', mode: 'queue', content: [{type: 'text', text}]});
const event = (seq, rpcId) => ({type: 'event', event: {type: 'user/message', seq, time: 1, data: {source: {rpcId}, text: 'hello'}}});

function makeFixture({promptResult, promptError, state, pages} = {}) {
  const seen = [];
  const calls = {prompt: 0, state: 0, events: 0, cancel: 0};
  const controller = Object.create(SessionController.prototype);
  controller.ctx = {invocation: undefined};
  controller.commands = {prompt: async (request, source) => {
    calls.prompt++;
    seen.push({request, source});
    if (promptError) throw promptError;
    return promptResult ?? {accepted: true};
  }};
  controller.state = async () => { calls.state++; return state ?? {cursor: 1, active: true, running: true, queue: [], pendingInput: []}; };
  controller.events = async request => { calls.events++; return pages?.shift() ?? {cursor: 1, records: [event(1, 'mobile-request-1')], hasMore: false}; };
  controller.cancel = async () => { calls.cancel++; return {accepted: true}; };
  const ledger = new MemorySessionLedger();
  return {controller, ledger, adapter: createMobileSessionAdapter({controller, ledger}), calls, seen};
}

test('uses the fixed DSH SessionController prompt wrapper and correlates requestId as rpcId', async () => {
  const f = makeFixture();
  const sent = await f.adapter.send(prompt());
  assert.equal(sent.status, 'accepted');
  assert.equal(f.seen.length, 1);
  assert.equal(f.seen[0].source.rpcId, prompt().requestId);
  assert.equal(f.seen[0].source.kind, 'user');
  // A second identical submission is served from the local ledger and does not invoke DSH again.
  await f.adapter.send(prompt());
  assert.equal(f.calls.prompt, 1);
});

test('rejects a reused requestId with changed content before invoking DSH', async () => {
  const f = makeFixture();
  await f.adapter.send(prompt('first'));
  await assert.rejects(f.adapter.send(prompt('changed')), {code: 'REQUEST_ID_REUSED'});
  assert.equal(f.calls.prompt, 1);
});

test('lost acknowledgement becomes unknown; passive reconciliation never prompts again', async () => {
  const f = makeFixture({promptError: new Error('simulated carrier loss')});
  const submitted = await f.adapter.send(prompt());
  assert.equal(submitted.status, 'unknown');
  const reconciled = await f.adapter.reconcile(prompt().requestId);
  assert.equal(reconciled.observed, 'event');
  assert.equal(reconciled.request.status, 'accepted');
  await f.adapter.send(prompt());
  assert.equal(f.calls.prompt, 1);
  assert.equal(f.calls.state, 1);
  assert.equal(f.calls.events, 1);
});

test('raw event sequence cursor deduplicates replay and flags a gap without discarding payload', () => {
  const f = makeFixture();
  assert.deepEqual(f.adapter.acceptEvent('session-a', event(4, 'r4')), {accepted: true, cursor: 4, entry: event(4, 'r4')});
  assert.deepEqual(f.adapter.acceptEvent('session-a', event(4, 'r4')), {accepted: false, duplicate: true, cursor: 4});
  assert.deepEqual(f.adapter.acceptEvent('session-a', event(6, 'r6')), {accepted: false, gap: true, expectedSeq: 5, receivedSeq: 6, cursor: 4});
  assert.equal(f.ledger.getCursor('session-a'), 4);
});

test('cancel acknowledgement remains cancel-requested and does not infer stopped state', async () => {
  const f = makeFixture({state: {cursor: 2, active: true, running: true, queue: [], pendingInput: []}});
  assert.deepEqual(await f.adapter.cancel('session-a'), {status: 'cancel-requested'});
  const state = await f.controller.state({sessionId: 'session-a'});
  assert.equal(state.running, true);
  assert.equal(f.calls.cancel, 1);
});

test('pending approval or question is exposed as user work and never auto-approved', () => {
  const f = makeFixture();
  const policy = f.adapter.interactionPolicy({pendingInput: ['approval', 'question', 'other']});
  assert.deepEqual(policy.pending, ['approval', 'question', 'other']);
  assert.equal(policy.requiresUser, true);
  assert.equal(policy.autoApprove, false);
  assert.equal('approve' in f.adapter, false);
});
