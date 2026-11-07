import test from 'node:test';
import assert from 'node:assert/strict';
import {createProfileSnapshot} from '../plugins/mobile/src/profile-adapter.mjs';
import {personalContext} from '../plugins/personal-context/src/index.mjs';

function sampleState() {
  return {
    identity: {name: 'IDENTITY.md', body: '拾文助手', revision: 3, scope: 'global'},
    soul: {name: 'SOUL.md', body: '温和、直接，帮助整理思路。', revision: 7, scope: 'global'},
    policy: {name: 'policy', body: '{"apiKey":"must-not-leak"}', revision: 5},
    documents: [{name: 'PROJECT.md', body: 'project secret', scope: 'article-1'}],
    memories: [
      {id: 'confirmed-1', category: 'memory', status: 'active', scope: 'global', body: '用户喜欢先看结论。', revision: 4, evidence: 'private evidence', source: 'manual'},
      {id: 'pending-1', category: 'memory', status: 'pending', scope: 'global', body: 'unconfirmed', revision: 1},
      {id: 'project-1', category: 'project', status: 'active', scope: 'article-1', body: 'article requirement', revision: 2},
      {id: 'deleted-1', category: 'user', status: 'deleted', scope: 'global', body: 'deleted memory', revision: 3},
    ],
    events: [{id: 'event', before_json: 'provider-secret', after_json: 'user-secret'}],
  };
}

test('snapshot exports the exact bounded Shiwen system context and a stable hash', () => {
  const state = sampleState();
  const snapshot = createProfileSnapshot(state, {agentId: 'shiwen'});
  assert.equal(snapshot.agentId, 'shiwen');
  assert.equal(snapshot.systemContext, personalContext(state));
  assert.deepEqual(Object.keys(snapshot).sort(), ['agentId', 'documents', 'included', 'memories', 'revision', 'systemContext', 'version']);
  assert.equal(snapshot.revision, createProfileSnapshot(state, {agentId: 'shiwen'}).revision);
  assert.deepEqual(snapshot.memories, [{id: 'confirmed-1', body: '用户喜欢先看结论。', category: 'memory', revision: 4, updated: ''}]);
  assert.deepEqual(snapshot.documents.map(document => document.name), ['IDENTITY.md', 'SOUL.md']);
  assert.equal(snapshot.included.globalActiveMemories, 1);
  assert.equal(snapshot.included.memoryContextOmitted, 0);
  for (const excluded of ['apiKey', 'project secret', 'unconfirmed', 'private evidence', 'provider-secret', 'user-secret']) {
    assert.equal(JSON.stringify(snapshot).includes(excluded), false);
  }
});

test('snapshot hash changes with confirmed content and rejects relabeling as another agent', () => {
  const state = sampleState();
  const baseline = createProfileSnapshot(state, {agentId: 'shiwen'});
  assert.throws(() => createProfileSnapshot(state, {agentId: 'other'}), {code: 'PROFILE_UNSUPPORTED_AGENT'});
  state.memories[0].body = '用户喜欢看到简洁结论。';
  assert.notEqual(baseline.revision, createProfileSnapshot(state, {agentId: 'shiwen'}).revision);
});

test('pending, deleted, rejected, and project memories are not injected', () => {
  const snapshot = createProfileSnapshot(sampleState());
  assert.ok(snapshot.systemContext.includes('用户喜欢先看结论。'));
  for (const excluded of ['unconfirmed', 'article requirement', 'deleted memory']) assert.equal(snapshot.systemContext.includes(excluded), false);
});

test('transports every confirmed global memory beyond prompt injection budget and reports omissions', () => {
  const state = sampleState();
  state.memories = [
    {id: 'a', category: 'memory', status: 'active', scope: 'global', body: 'A'.repeat(1_200), revision: 1, updated: '2026-01-01'},
    {id: 'b', category: 'user', status: 'active', scope: 'global', body: 'B'.repeat(1_200), revision: 2, updated: '2026-01-02'},
  ];
  const snapshot = createProfileSnapshot(state);
  assert.equal(snapshot.memories.length, 2);
  assert.equal(snapshot.included.globalActiveMemories, 2);
  assert.equal(snapshot.included.memoryContextEntries, 1);
  assert.equal(snapshot.included.memoryContextOmitted, 1);
  assert.ok(snapshot.memories.some(memory => memory.id === 'b'));
});

test('oversized profile returns a diagnostic instead of silently truncating', () => {
  const state = sampleState();
  state.memories.push({id: 'huge', category: 'memory', status: 'active', scope: 'global', body: 'm'.repeat(270_000), revision: 1});
  assert.throws(() => createProfileSnapshot(state), {code: 'PROFILE_TOO_LARGE', maxBytes: 256 * 1024});
});
