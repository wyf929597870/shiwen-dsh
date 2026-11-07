// P0 executable protocol model, intentionally not imported by production plugins.
// Every test owns a temporary SQLite file; no HTTP or user-library migration here.
import {randomUUID} from 'node:crypto';
import Database from '../../../plugins/library/legacy/sqlite.mjs';
import {parseOperation, setup as setupSchema, fail} from '../../../contracts/mobile/v1/schema.mjs';
import {fingerprint, businessFingerprint, contentHash, sha256} from '../../../plugins/library/src/sync/canonical.mjs';

export class CoordinatorProbe {
  constructor(path, {libraryId = randomUUID(), epoch = randomUUID(), now = Date.now, fault = () => {}} = {}) {
    this.db = new Database(path); this.now = now; this.fault = fault;
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS target(id INTEGER PRIMARY KEY CHECK(id=1), generation INTEGER NOT NULL,
        library TEXT, epoch TEXT, fence INTEGER NOT NULL, holder TEXT, expires INTEGER, snapshot TEXT);
      CREATE TABLE IF NOT EXISTS records(id TEXT PRIMARY KEY, revision INTEGER NOT NULL, version TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS changes(id TEXT PRIMARY KEY, version TEXT UNIQUE NOT NULL, hash TEXT NOT NULL, result TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS receipts(epoch TEXT, device TEXT, op TEXT, hash TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(epoch,device,op));
      CREATE TABLE IF NOT EXISTS attempts(epoch TEXT, device TEXT, op TEXT, hash TEXT NOT NULL, PRIMARY KEY(epoch,device,op));
      CREATE TABLE IF NOT EXISTS activities(id TEXT PRIMARY KEY, record TEXT NOT NULL, hash TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT, change_id TEXT UNIQUE NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS blobs(hash TEXT PRIMARY KEY, bytes BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS setups(id TEXT PRIMARY KEY, owner TEXT NOT NULL, hash TEXT NOT NULL, request TEXT NOT NULL,
        fence INTEGER NOT NULL, state TEXT NOT NULL, snapshot TEXT, result TEXT);
      CREATE TABLE IF NOT EXISTS restores(id TEXT PRIMARY KEY, owner TEXT NOT NULL, device TEXT NOT NULL, epoch TEXT NOT NULL, manifest TEXT NOT NULL);
    `);
    this.db.prepare('INSERT OR IGNORE INTO target VALUES(1,0,?,?,0,NULL,0,NULL)').run(libraryId, epoch);
  }
  close() { this.db.close(); }
  tx(fn) { return this.db.transaction(fn)(); }
  identity() { return {...this.db.prepare('SELECT * FROM target WHERE id=1').get()}; }
  authorize(ctx) {
    if (!ctx?.authenticated || !ctx.deviceId || !ctx.ownerId) fail('AUTH_REQUIRED');
    const target = this.identity();
    if (ctx.libraryId !== target.library) fail('LIBRARY_MISMATCH');
    if (ctx.epoch !== target.epoch) fail('EPOCH_CHANGED');
  }
  receipt(ctx, operationId) {
    this.authorize(ctx);
    const row = this.db.prepare('SELECT result FROM receipts WHERE epoch=? AND device=? AND op=?')
      .get(ctx.epoch, ctx.deviceId, operationId);
    return row ? JSON.parse(row.result) : {status: 'unknown'};
  }
  record(id) {
    const row = this.db.prepare('SELECT * FROM records WHERE id=?').get(id);
    return row ? {...row, payload: JSON.parse(row.payload)} : null;
  }
  putBlob(bytes, expectedHash = sha256(bytes)) {
    if (sha256(bytes) !== expectedHash) fail('MANIFEST_MISMATCH');
    this.db.prepare('INSERT OR IGNORE INTO blobs VALUES(?,?)').run(expectedHash, bytes);
    return expectedHash;
  }
  restoreTask(ctx, operations) {
    this.authorize(ctx);
    if (!ctx.isOwner) fail('PERMISSION_DENIED');
    const id = randomUUID();
    const manifest = operations.map(raw => {
      const op = parseOperation(raw);
      return {changeId: op.changeId, hash: businessFingerprint(op)};
    });
    this.db.prepare('INSERT INTO restores VALUES(?,?,?,?,?)').run(id, ctx.ownerId, ctx.deviceId, ctx.epoch, JSON.stringify(manifest));
    return id;
  }
  hasRestoreGrant(ctx, taskId, op) {
    const task = this.db.prepare('SELECT * FROM restores WHERE id=?').get(taskId ?? '');
    return task && task.owner === ctx.ownerId && task.device === ctx.deviceId && task.epoch === ctx.epoch
      && JSON.parse(task.manifest).some(item => item.changeId === op.changeId && item.hash === businessFingerprint(op));
  }
  push(ctx, input, {restoreTaskId} = {}) {
    this.authorize(ctx);
    const op = parseOperation(input), hash = fingerprint(op), businessHash = businessFingerprint(op);
    if (op.originDeviceId !== ctx.deviceId && !this.hasRestoreGrant(ctx, restoreTaskId, op)) fail('PERMISSION_DENIED');
    const key = [ctx.epoch, ctx.deviceId, op.operationId];
    return this.tx(() => {
      const prior = this.db.prepare('SELECT * FROM receipts WHERE epoch=? AND device=? AND op=?').get(...key);
      if (prior) { if (prior.hash !== hash) fail('OPERATION_REUSED'); return JSON.parse(prior.result); }
      const attempt = this.db.prepare('SELECT hash FROM attempts WHERE epoch=? AND device=? AND op=?').get(...key);
      if (attempt && attempt.hash !== hash) fail('OPERATION_REUSED');
      this.db.prepare('INSERT OR IGNORE INTO attempts VALUES(?,?,?,?)').run(...key, hash);
      const finish = result => {
        this.db.prepare('INSERT INTO receipts VALUES(?,?,?,?,?)').run(...key, hash, JSON.stringify(result));
        this.fault('before-commit'); return result;
      };
      const applied = this.db.prepare('SELECT * FROM changes WHERE id=?').get(op.changeId);
      if (applied) {
        if (applied.hash !== businessHash) return finish({status: 'rejected', code: 'OPERATION_REUSED'});
        return finish({...JSON.parse(applied.result), operationId: op.operationId, acceptedGeneration: op.localGeneration});
      }
      if (this.db.prepare('SELECT 1 FROM changes WHERE version=?').get(op.versionId))
        return finish({status: 'rejected', code: 'OPERATION_REUSED'});
      const old = this.record(op.recordId);
      if (op.action === 'create' ? !!old : !old || old.revision !== op.baseRevision || old.version !== op.baseVersionId)
        return finish({status: 'conflict', code: 'REVISION_CONFLICT', remote: old});
      if (old && (['restore', 'restore-and-update'].includes(op.action) ? !old.payload.deleted : old.payload.deleted))
        return finish({status: 'conflict', code: 'REVISION_CONFLICT', remote: old});
      const missing = op.payload.attachmentDescriptors.filter(a => !this.db.prepare('SELECT 1 FROM blobs WHERE hash=?').get(a.hash));
      if (missing.length) return {status: 'blocked-dependency', code: 'DEPENDENCY_MISSING', missingDependencies: missing.map(a => a.hash)};
      for (const a of op.payload.attachmentDescriptors) {
        const row = this.db.prepare('SELECT length(bytes) AS size FROM blobs WHERE hash=?').get(a.hash);
        if (row.size !== a.byteLength) return finish({status: 'rejected', code: 'VALIDATION_ERROR'});
      }
      let before = contentHash(old?.payload.markdown ?? '', old?.payload.sources ?? []);
      for (const a of op.activities) {
        if (a.beforeHash !== before || a.afterHash !== contentHash(a.afterSegments.map(s => s.text).join(''), a.afterSegments)
          || a.originDeviceId !== op.originDeviceId)
          return finish({status: 'rejected', code: 'VALIDATION_ERROR'});
        const existing = this.db.prepare('SELECT * FROM activities WHERE id=?').get(a.activityId);
        if (existing && (existing.hash !== fingerprint(a) || existing.record !== op.recordId)) return finish({status: 'rejected', code: 'OPERATION_REUSED'});
        before = a.afterHash;
      }
      if (op.activities.length && before !== contentHash(op.payload.markdown, op.payload.sources))
        return finish({status: 'rejected', code: 'VALIDATION_ERROR'});
      const revision = (old?.revision ?? 0) + 1;
      this.db.prepare('INSERT INTO records VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,version=excluded.version,payload=excluded.payload')
        .run(op.recordId, revision, op.versionId, JSON.stringify(op.payload));
      for (const a of op.activities) this.db.prepare('INSERT OR IGNORE INTO activities VALUES(?,?,?,?)').run(a.activityId, op.recordId, fingerprint(a), JSON.stringify(a));
      const event = this.db.prepare('INSERT INTO events(change_id,payload) VALUES(?,?)').run(op.changeId, JSON.stringify(op));
      const result = {status: 'applied', operationId: op.operationId, acceptedGeneration: op.localGeneration,
        revision, versionId: op.versionId, seq: Number(event.lastInsertRowid), canonicalRecord: op.payload};
      this.db.prepare('INSERT INTO changes VALUES(?,?,?,?)').run(op.changeId, op.versionId, businessHash, JSON.stringify(result));
      return finish(result);
    });
  }
  createSetup(ctx, raw) {
    if (!ctx?.authenticated) fail('AUTH_REQUIRED');
    if (!ctx.isOwner) fail('PERMISSION_DENIED');
    const request = setupSchema.parse(raw), hash = fingerprint(request);
    return this.tx(() => {
      const old = this.db.prepare('SELECT * FROM setups WHERE id=?').get(request.setupId);
      if (old) {
        if (old.owner !== ctx.ownerId) fail('PERMISSION_DENIED');
        if (old.hash !== hash) fail('OPERATION_REUSED');
        return {...old};
      }
      const target = this.identity();
      if (target.holder && target.expires > this.now()) fail('SETUP_TARGET_BUSY');
      if (target.generation !== request.targetGeneration || target.library !== request.expectedLibraryId
        || target.epoch !== request.expectedEpoch) fail('SETUP_TARGET_CHANGED');
      if (request.mode === 'initialize' ? target.library !== null : target.library !== request.libraryId || !ctx.maintenance)
        fail('SETUP_TARGET_CHANGED');
      const fence = target.fence + 1;
      this.db.prepare('INSERT INTO setups VALUES(?,?,?,?,?,?,NULL,NULL)').run(request.setupId, ctx.ownerId, hash, JSON.stringify(request), fence, 'receiving');
      this.db.prepare('UPDATE target SET holder=?,fence=?,expires=? WHERE id=1').run(request.setupId, fence, this.now() + 60_000);
      return {id: request.setupId, fence, state: 'receiving'};
    });
  }
  getSetup(ctx, id) {
    const row = this.db.prepare('SELECT * FROM setups WHERE id=?').get(id);
    if (!ctx?.authenticated || !row || row.owner !== ctx.ownerId || !ctx.isOwner) fail('PERMISSION_DENIED');
    return row;
  }
  checkLease(ctx, id, fence) {
    const task = this.getSetup(ctx, id), target = this.identity();
    if (target.holder !== id || target.fence !== fence || task.fence !== fence || target.expires <= this.now())
      fail('SETUP_LEASE_EXPIRED');
    const request = JSON.parse(task.request);
    if (target.generation !== request.targetGeneration || target.library !== request.expectedLibraryId || target.epoch !== request.expectedEpoch)
      fail('SETUP_TARGET_CHANGED');
    return task;
  }
  renewSetup(ctx, id) {
    return this.tx(() => {
      const task = this.getSetup(ctx, id), target = this.identity(), request = JSON.parse(task.request);
      if (task.state === 'committed') return JSON.parse(task.result);
      if (task.state === 'aborted') fail('SETUP_NOT_READY');
      if (target.holder && target.holder !== id && target.expires > this.now()) fail('SETUP_TARGET_BUSY');
      if (target.generation !== request.targetGeneration || target.library !== request.expectedLibraryId || target.epoch !== request.expectedEpoch)
        fail('SETUP_TARGET_CHANGED');
      const fence = target.fence + 1;
      this.db.prepare('UPDATE setups SET fence=? WHERE id=?').run(fence, id);
      this.db.prepare('UPDATE target SET holder=?,fence=?,expires=? WHERE id=1').run(id, fence, this.now() + 60_000);
      return {id, fence};
    });
  }
  stage(ctx, id, fence, snapshot) {
    return this.tx(() => {
      const task = this.checkLease(ctx, id, fence);
      if (task.state === 'aborted' || task.state === 'committed') fail('SETUP_NOT_READY');
      if (fingerprint(snapshot) !== JSON.parse(task.request).manifestDigest) fail('MANIFEST_MISMATCH');
      this.db.prepare('UPDATE setups SET snapshot=? WHERE id=?').run(JSON.stringify(snapshot), id);
    });
  }
  commitSetup(ctx, id, fence) {
    return this.tx(() => {
      const task = this.getSetup(ctx, id);
      if (task.state === 'committed') return JSON.parse(task.result);
      this.checkLease(ctx, id, fence);
      if (!task.snapshot || task.state === 'aborted') fail('SETUP_NOT_READY');
      const snapshot = JSON.parse(task.snapshot), request = JSON.parse(task.request);
      for (const hash of snapshot.blobs) if (!this.db.prepare('SELECT 1 FROM blobs WHERE hash=?').get(hash)) fail('SETUP_NOT_READY');
      const result = {libraryId: request.libraryId, epoch: randomUUID(), generation: request.targetGeneration + 1,
        manifestDigest: request.manifestDigest};
      const changed = this.db.prepare('UPDATE target SET library=?,epoch=?,generation=?,snapshot=?,holder=NULL,expires=0 WHERE id=1 AND generation=? AND holder=? AND fence=?')
        .run(result.libraryId, result.epoch, result.generation, task.snapshot, request.targetGeneration, id, fence).changes;
      if (changed !== 1) fail('SETUP_TARGET_CHANGED');
      this.db.prepare("UPDATE setups SET state='committed',result=? WHERE id=?").run(JSON.stringify(result), id);
      this.fault('before-setup-commit'); return result;
    });
  }
  abortSetup(ctx, id, fence) {
    return this.tx(() => {
      const task = this.getSetup(ctx, id);
      if (task.state === 'committed') return JSON.parse(task.result);
      this.checkLease(ctx, id, fence);
      this.db.prepare("UPDATE setups SET state='aborted' WHERE id=?").run(id);
      this.db.prepare('UPDATE target SET holder=NULL,expires=0 WHERE id=1 AND holder=? AND fence=?').run(id, fence);
      return {status: 'aborted'}; // Candidate intentionally retained.
    });
  }
}
