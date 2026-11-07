import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ChunkStore} from '../plugins/library/src/sync/chunks.mjs';
import {canonicalJSON, fingerprint, sha256} from '../plugins/library/src/sync/canonical.mjs';
import {createOperation} from './support/mobile/operations.mjs';
function fixture(t, options) {
  const directory = mkdtempSync(join(tmpdir(), 'shiwen-chunks-'));
  const store = new ChunkStore(directory, options), ctx = {authenticated: true, libraryId: randomUUID(), ownerId: 'owner'};
  t.after(() => {store.close(); rmSync(directory, {recursive: true, force: true});});
  return {store, ctx, directory};
}
async function collect(stream) { const chunks = []; for await (const bytes of stream) chunks.push(bytes); return Buffer.concat(chunks); }
function upload(store, ctx, bytes, kind = 'operation') {
  const task = store.begin(ctx, {kind, byteLength: bytes.length, digest: sha256(bytes)});
  for (let part = 0; part * task.partBytes < bytes.length; part++) {
    const chunk = bytes.subarray(part * task.partBytes, (part + 1) * task.partBytes);
    store.putPart(ctx, task.uploadId, part, chunk, sha256(chunk));
  }
  return task;
}
test('large canonical payload resumes on another connection and retains its exact request identity', async t => {
  const {store, ctx, directory} = fixture(t), operation = createOperation(randomUUID(), '文'.repeat(1_000_000));
  const bytes = Buffer.from(canonicalJSON(operation));
  const task = store.begin(ctx, {kind: 'operation', byteLength: bytes.length, digest: sha256(bytes)});
  const first = bytes.subarray(0, task.partBytes); store.putPart(ctx, task.uploadId, 0, first, sha256(first));
  const restarted = new ChunkStore(directory);
  try {
    assert.ok(!restarted.status(ctx, task.uploadId).missingParts.includes(0));
    assert.throws(() => restarted.commit(ctx, task.uploadId), /DEPENDENCY_MISSING/);
    for (const part of restarted.status(ctx, task.uploadId).missingParts) {
      const chunk = bytes.subarray(part * task.partBytes, (part + 1) * task.partBytes);
      restarted.putPart(ctx, task.uploadId, part, chunk, sha256(chunk));
    }
    const reference = restarted.commit(ctx, task.uploadId);
    const result = await collect(restarted.read(ctx, reference.payloadRef, {kind: 'operation'}));
    assert.equal(fingerprint(JSON.parse(result.toString('utf8'))), reference.digest);
    assert.equal(reference.digest, fingerprint(operation));
  } finally { restarted.close(); }
});
test('payload publication crash is recoverable and does not expose an uncommitted object', async t => {
  let crash = true;
  const {store, ctx} = fixture(t, {partBytes: 3, fault: point => {if (crash && point === 'payload-published') throw Error('power lost');}});
  const bytes = Buffer.from('🌱文字'), task = upload(store, ctx, bytes);
  assert.throws(() => store.commit(ctx, task.uploadId), /power lost/);
  assert.throws(() => store.read(ctx, task.uploadId, {kind: 'operation'}), /DEPENDENCY_MISSING/);
  crash = false;
  const ready = store.commit(ctx, task.uploadId);
  assert.deepEqual(store.commit(ctx, task.uploadId), ready);
  assert.deepEqual(await collect(store.read(ctx, ready.payloadRef, {kind: 'operation'})), bytes);
});
test('part retry cannot overwrite different bytes, cross-library reads and kind confusion are denied', t => {
  const {store, ctx} = fixture(t, {partBytes: 3}), bytes = Buffer.from('abc'), task = upload(store, ctx, bytes, 'blob');
  assert.throws(() => store.putPart(ctx, task.uploadId, 0, Buffer.from('xyz'), sha256('xyz')), /OPERATION_REUSED/);
  assert.throws(() => store.putPart(ctx, task.uploadId, 1, bytes, sha256(bytes)), /VALIDATION_ERROR/);
  store.commit(ctx, task.uploadId);
  assert.throws(() => store.read({...ctx, libraryId: randomUUID()}, task.uploadId, {kind: 'blob'}), /PERMISSION_DENIED/);
  assert.throws(() => store.read(ctx, task.uploadId, {kind: 'operation'}), /PERMISSION_DENIED/);
  assert.throws(() => store.status({...ctx, authenticated: false}, task.uploadId), /AUTH_REQUIRED/);
});
test('corrupted part never becomes a ready payload; same original part repairs it', async t => {
  const {store, ctx, directory} = fixture(t), bytes = Buffer.from('original'), task = upload(store, ctx, bytes);
  writeFileSync(join(directory, task.uploadId, '0.part'), 'tampered');
  assert.throws(() => store.commit(ctx, task.uploadId), /MANIFEST_MISMATCH/);
  assert.equal(store.status(ctx, task.uploadId).ready, false);
  store.putPart(ctx, task.uploadId, 0, bytes, sha256(bytes)); store.commit(ctx, task.uploadId);
  assert.deepEqual(await collect(store.read(ctx, task.uploadId, {kind: 'operation', start: 2, end: 4})), bytes.subarray(2, 5));
});
