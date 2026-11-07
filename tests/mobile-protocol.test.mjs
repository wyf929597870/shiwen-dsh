import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {CoordinatorProbe} from './support/mobile/coordinator.mjs';
import {createOperation} from './support/mobile/operations.mjs';
import {fingerprint, sha256} from '../plugins/library/src/sync/canonical.mjs';
function fixture(t, opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'shiwen-mobile-protocol-')), path = join(dir, 'probe.sqlite');
  const db = new CoordinatorProbe(path, opts);
  t.after(() => { db.close(); rmSync(dir, {recursive: true, force: true}); });
  const target = db.identity(), ctx = {authenticated: true, isOwner: true, ownerId: 'test-owner',
    deviceId: randomUUID(), libraryId: target.library, epoch: target.epoch};
  return {db, ctx, path};
}
const code = name => error => error.code === name;
const counts = db => Object.fromEntries(['records', 'activities', 'events', 'receipts'].map(name =>
  [name, db.db.prepare(`SELECT count(*) AS n FROM ${name}`).get().n]));
function setupRequest(snapshot, target, libraryId = randomUUID()) {
  return {setupId: randomUUID(), mode: target.library ? 'recover' : 'initialize', libraryId,
    targetGeneration: target.generation, expectedLibraryId: target.library, expectedEpoch: target.epoch,
    sourceEpoch: null, manifestDigest: fingerprint(snapshot)};
}

test('ACK loss and a new process find the exact committed version without duplicate activities', t => {
  const {db, ctx, path} = fixture(t), op = createOperation(ctx.deviceId);
  const saved = db.push(ctx, op), reopened = new CoordinatorProbe(path);
  try {
    assert.deepEqual(reopened.receipt(ctx, op.operationId), saved);
    assert.deepEqual(reopened.push(ctx, op), saved);
    assert.deepEqual(counts(reopened), {records: 1, activities: 1, events: 1, receipts: 1});
    assert.throws(() => reopened.push(ctx, {...op, localGeneration: 2}), code('OPERATION_REUSED'));
  } finally { reopened.close(); }
});

test('record, activity, journal and receipt roll back together on commit failure', t => {
  let fail = true;
  const {db, ctx} = fixture(t, {fault: point => {if (fail && point === 'before-commit') throw Error('power lost');}});
  const op = createOperation(ctx.deviceId);
  assert.throws(() => db.push(ctx, op), /power lost/);
  assert.deepEqual(counts(db), {records: 0, activities: 0, events: 0, receipts: 0});
  assert.equal(db.receipt(ctx, op.operationId).status, 'unknown');
  fail = false; assert.equal(db.push(ctx, op).status, 'applied');
});

test('temporarily missing attachments do not leave terminal receipts; original operation can resume', t => {
  const {db, ctx} = fixture(t), op = createOperation(ctx.deviceId), bytes = Buffer.from('original attachment');
  op.payload.attachmentDescriptors = [{id: randomUUID(), hash: sha256(bytes), byteLength: bytes.length, name: 'source.txt'}];
  assert.equal(db.push(ctx, op).status, 'blocked-dependency');
  assert.deepEqual(counts(db), {records: 0, activities: 0, events: 0, receipts: 0});
  assert.equal(db.receipt(ctx, op.operationId).status, 'unknown');
  const altered = structuredClone(op); altered.payload.title = 'tampered';
  assert.throws(() => db.push(ctx, altered), code('OPERATION_REUSED'));
  const independent = createOperation(ctx.deviceId); assert.equal(db.push(ctx, independent).status, 'applied');
  db.putBlob(bytes); assert.equal(db.push(ctx, op).status, 'applied');
  assert.equal(db.record(op.recordId).revision, 1);
});

test('same-epoch phone replacement preserves change/activity identity without impersonating the old device', t => {
  const {db, ctx} = fixture(t), oldOp = createOperation(ctx.deviceId);
  db.push(ctx, oldOp); // Response lost; backup still contains old outbox.
  const replacement = {...ctx, deviceId: randomUUID()};
  assert.equal(db.receipt(replacement, oldOp.operationId).status, 'unknown');
  const newEnvelope = {...oldOp, operationId: randomUUID()};
  assert.throws(() => db.push(replacement, newEnvelope), code('PERMISSION_DENIED'));
  const task = db.restoreTask(replacement, [oldOp]);
  assert.equal(db.push(replacement, newEnvelope, {restoreTaskId: task}).status, 'applied');
  assert.equal(db.push(ctx, oldOp).status, 'applied'); // Old phone returns later.
  assert.deepEqual(counts(db), {records: 1, activities: 1, events: 1, receipts: 2});
  const row = db.db.prepare('SELECT payload FROM activities').get();
  assert.equal(JSON.parse(row.payload).originDeviceId, ctx.deviceId);
  const unrelated = createOperation(ctx.deviceId);
  assert.throws(() => db.push(replacement, unrelated, {restoreTaskId: task}), code('PERMISSION_DENIED'));
  assert.throws(() => db.restoreTask({...replacement, isOwner: false}, [oldOp]), code('PERMISSION_DENIED'));
});

test('library/epoch/actor authorization cannot be bypassed using a known operation ID', t => {
  const {db, ctx} = fixture(t), op = createOperation(ctx.deviceId); db.push(ctx, op);
  assert.throws(() => db.push({...ctx, libraryId: randomUUID()}, op), code('LIBRARY_MISMATCH'));
  assert.throws(() => db.receipt({...ctx, epoch: randomUUID()}, op.operationId), code('EPOCH_CHANGED'));
  assert.throws(() => db.receipt({...ctx, authenticated: false}, op.operationId), code('AUTH_REQUIRED'));
});

test('two connections cannot publish competing initial snapshots to the same target generation', t => {
  const {db, ctx, path} = fixture(t, {libraryId: null, epoch: null}), snapshot = {blobs: [], records: ['one']};
  const a = setupRequest(snapshot, db.identity()), b = setupRequest({...snapshot, records: ['two']}, db.identity());
  const other = new CoordinatorProbe(path);
  try {
    const task = db.createSetup(ctx, a);
    assert.throws(() => other.createSetup(ctx, b), code('SETUP_TARGET_BUSY'));
    db.stage(ctx, task.id, task.fence, snapshot);
    const result = db.commitSetup(ctx, task.id, task.fence);
    assert.deepEqual(other.commitSetup(ctx, task.id, task.fence), result);
    assert.deepEqual(other.abortSetup(ctx, task.id, task.fence), result);
    assert.throws(() => other.createSetup(ctx, b), code('SETUP_TARGET_CHANGED'));
    assert.equal(other.identity().library, a.libraryId);
  } finally { other.close(); }
});

test('expired lease fences late commit/abort and cannot release the replacement task', t => {
  let now = 1000;
  const {db, ctx} = fixture(t, {libraryId: null, epoch: null, now: () => now}), snapshot = {blobs: []};
  const a = db.createSetup(ctx, setupRequest(snapshot, db.identity())); db.stage(ctx, a.id, a.fence, snapshot);
  now += 60_001;
  const b = db.createSetup(ctx, setupRequest(snapshot, db.identity()));
  assert.ok(b.fence > a.fence);
  assert.throws(() => db.commitSetup(ctx, a.id, a.fence), code('SETUP_LEASE_EXPIRED'));
  assert.throws(() => db.abortSetup(ctx, a.id, a.fence), code('SETUP_LEASE_EXPIRED'));
  assert.equal(db.identity().holder, b.id);
});

test('renewed task gets a new fence; publication rollback retains the prior pointer', t => {
  let now = 0, fail = true;
  const {db, ctx} = fixture(t, {libraryId: null, epoch: null, now: () => now,
    fault: point => {if (point === 'before-setup-commit' && fail) throw Error('power lost');}});
  const snapshot = {blobs: []}, a = db.createSetup(ctx, setupRequest(snapshot, db.identity()));
  db.stage(ctx, a.id, a.fence, snapshot); now = 61_000;
  const renewed = db.renewSetup(ctx, a.id);
  assert.throws(() => db.commitSetup(ctx, a.id, a.fence), code('SETUP_LEASE_EXPIRED'));
  assert.throws(() => db.commitSetup(ctx, a.id, renewed.fence), /power lost/);
  assert.equal(db.identity().library, null); assert.equal(db.identity().generation, 0);
  fail = false; assert.equal(db.commitSetup(ctx, a.id, renewed.fence).generation, 1);
});

test('incomplete recovery never publishes; cancel preserves its rescue candidate', t => {
  const {db, ctx} = fixture(t, {libraryId: null, epoch: null});
  const snapshot = {blobs: [sha256('not uploaded')], records: ['rescued text']};
  const task = db.createSetup(ctx, setupRequest(snapshot, db.identity())); db.stage(ctx, task.id, task.fence, snapshot);
  assert.throws(() => db.commitSetup(ctx, task.id, task.fence), code('SETUP_NOT_READY'));
  assert.equal(db.identity().library, null);
  db.abortSetup(ctx, task.id, task.fence);
  assert.deepEqual(JSON.parse(db.getSetup(ctx, task.id).snapshot), snapshot);
  assert.throws(() => db.commitSetup(ctx, task.id, task.fence), code('SETUP_LEASE_EXPIRED'));
});

test('recovery requires the same library and explicit maintenance; different library cannot overwrite', t => {
  const {db, ctx} = fixture(t), snapshot = {blobs: []}, target = db.identity();
  const request = setupRequest(snapshot, target, target.library);
  assert.throws(() => db.createSetup(ctx, request), code('SETUP_TARGET_CHANGED'));
  assert.throws(() => db.createSetup({...ctx, maintenance: true}, {...request, libraryId: randomUUID()}), code('SETUP_TARGET_CHANGED'));
  const task = db.createSetup({...ctx, maintenance: true}, request);
  db.stage(ctx, task.id, task.fence, snapshot);
  const result = db.commitSetup(ctx, task.id, task.fence);
  assert.equal(result.libraryId, target.library); assert.notEqual(result.epoch, target.epoch);
});

test('immutable version and activity IDs cannot be reassigned to different records', t => {
  const {db, ctx} = fixture(t), first = createOperation(ctx.deviceId);
  db.push(ctx, first);
  const versionReuse = createOperation(ctx.deviceId); versionReuse.versionId = first.versionId;
  assert.equal(db.push(ctx, versionReuse).status, 'rejected');
  const activityReuse = createOperation(ctx.deviceId); activityReuse.activities = first.activities;
  assert.equal(db.push(ctx, activityReuse).status, 'rejected');
  assert.equal(counts(db).records, 1); assert.equal(counts(db).activities, 1);
});
