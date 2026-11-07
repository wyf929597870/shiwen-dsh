import {mkdirSync, existsSync, openSync, closeSync, readSync, writeSync, fsyncSync, renameSync, unlinkSync, statSync, readFileSync} from 'node:fs';
import {createReadStream} from 'node:fs';
import {join} from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import Database from '../../legacy/sqlite.mjs';
import {fail, limits} from '../../../../contracts/mobile/v1/schema.mjs';
import {sha256} from './canonical.mjs';

// P0 durable transfer primitive. Not exposed by a plugin until the host's
// authentication, quota and semantic-validation adapters have been integrated.
// Callers supply a trusted actor, never copy this from a request JSON body.
export class ChunkStore {
  constructor(directory, {partBytes = limits.maxPartBytes, fault = () => {}} = {}) {
    if (!Number.isSafeInteger(partBytes) || partBytes < 1 || partBytes > limits.maxPartBytes) throw Error('Invalid partBytes');
    mkdirSync(directory, {recursive: true, mode: 0o700});
    this.directory = directory; this.partBytes = partBytes; this.fault = fault;
    this.db = new Database(join(directory, 'transfers.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS transfers(id TEXT PRIMARY KEY, library TEXT NOT NULL, owner TEXT NOT NULL,
        kind TEXT NOT NULL, bytes INTEGER NOT NULL, hash TEXT NOT NULL, part_bytes INTEGER NOT NULL, ready INTEGER NOT NULL DEFAULT 0,
        metadata TEXT NOT NULL DEFAULT '{}');
      CREATE TABLE IF NOT EXISTS parts(transfer TEXT NOT NULL, part INTEGER NOT NULL, bytes INTEGER NOT NULL,
        hash TEXT NOT NULL, PRIMARY KEY(transfer,part));`);
    if(!this.db.prepare('PRAGMA table_info(transfers)').all().some(row=>row.name==='metadata'))this.db.exec("ALTER TABLE transfers ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}'");
  }
  close() { this.db.close(); }
  authorize(ctx) { if (!ctx?.authenticated || !ctx.ownerId || !ctx.libraryId) fail('AUTH_REQUIRED'); }
  task(ctx, id) {
    this.authorize(ctx);
    const row = this.db.prepare('SELECT * FROM transfers WHERE id=?').get(id);
    if (!row || row.library !== ctx.libraryId || row.owner !== ctx.ownerId) fail('PERMISSION_DENIED');
    return row;
  }
  folder(id) { return join(this.directory, id); }
  begin(ctx, {uploadId = randomUUID(), kind, byteLength, digest, metadata = {}}) {
    this.authorize(ctx);
    if (!/^[a-f0-9-]{36}$/.test(uploadId) || !['operation', 'blob', 'payload'].includes(kind)
      || !Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > limits.maxCanonicalOperationBytes
      || !/^[a-f0-9]{64}$/.test(digest)||!metadata||typeof metadata!=='object'||Array.isArray(metadata)) fail('VALIDATION_ERROR');
    return this.db.transaction(() => {
      const old = this.db.prepare('SELECT * FROM transfers WHERE id=?').get(uploadId);
      if (old) {
        this.task(ctx, uploadId);
        if (old.kind !== kind || old.bytes !== byteLength || old.hash !== digest || JSON.stringify(sortObject(JSON.parse(old.metadata)))!==JSON.stringify(sortObject(metadata))) fail('OPERATION_REUSED');
      } else {
        mkdirSync(this.folder(uploadId), {recursive: true, mode: 0o700});
        this.db.prepare('INSERT INTO transfers(id,library,owner,kind,bytes,hash,part_bytes,metadata) VALUES(?,?,?,?,?,?,?,?)')
          .run(uploadId, ctx.libraryId, ctx.ownerId, kind, byteLength, digest, this.partBytes,JSON.stringify(sortObject(metadata)));
      }
      return this.status(ctx, uploadId);
    })();
  }
  status(ctx, id) {
    const row = this.task(ctx, id), count = Math.ceil(row.bytes / row.part_bytes);
    const present = new Set(this.db.prepare('SELECT part FROM parts WHERE transfer=?').all(id).map(r => r.part));
    const missingParts = Array.from({length: count}, (_, i) => i).filter(i => !present.has(i) || !existsSync(join(this.folder(id), `${i}.part`)));
    return {uploadId: id, partBytes: row.part_bytes, byteLength: row.bytes, digest: row.hash, kind: row.kind,metadata:JSON.parse(row.metadata),
      ready: Boolean(row.ready && existsSync(join(this.folder(id), 'payload'))), missingParts};
  }
  putPart(ctx, id, part, bytes, digest) {
    return this.db.transaction(() => {
      const row = this.task(ctx, id), count = Math.ceil(row.bytes / row.part_bytes);
      if (!Number.isSafeInteger(part) || part < 0 || part >= count || !Buffer.isBuffer(bytes)
        || bytes.length !== Math.min(row.part_bytes, row.bytes - part * row.part_bytes)) fail('VALIDATION_ERROR');
      if (sha256(bytes) !== digest) fail('MANIFEST_MISMATCH');
      const old = this.db.prepare('SELECT hash FROM parts WHERE transfer=? AND part=?').get(id, part);
      if (old && old.hash !== digest) fail('OPERATION_REUSED');
      const dir = this.folder(id), temporary = join(dir, randomUUID() + '.tmp');
      let fd;
      try {
        fd = openSync(temporary, 'wx', 0o600); writeAll(fd, bytes); fsyncSync(fd); closeSync(fd); fd = undefined;
        renameSync(temporary, join(dir, `${part}.part`)); syncDirectory(dir);
        this.fault('part-published');
        this.db.prepare('INSERT OR IGNORE INTO parts VALUES(?,?,?,?)').run(id, part, bytes.length, digest);
      } finally {
        if (fd !== undefined) closeSync(fd);
        if (existsSync(temporary)) unlinkSync(temporary);
      }
      return {part, digest};
    })();
  }
  commit(ctx, id) {
    return this.db.transaction(() => {
      const row = this.task(ctx, id), state = this.status(ctx, id);
      if (state.missingParts.length) fail('DEPENDENCY_MISSING', {missingParts: state.missingParts});
      // Always rebuild/verify from immutable parts, including retries after a
      // crash between filesystem publication and the SQLite ready marker.
      const dir = this.folder(id), temporary = join(dir, randomUUID() + '.tmp');
      const hash = createHash('sha256'), buffer = Buffer.alloc(Math.min(row.part_bytes, 64 * 1024));
      let output, total = 0;
      try {
        output = openSync(temporary, 'wx', 0o600);
        for (let part = 0; part < Math.ceil(row.bytes / row.part_bytes); part++) {
          const entry = this.db.prepare('SELECT * FROM parts WHERE transfer=? AND part=?').get(id, part);
          const input = openSync(join(dir, `${part}.part`), 'r'), partHash = createHash('sha256');
          let length = 0;
          try {
            for (;;) {
              const n = readSync(input, buffer, 0, buffer.length, null); if (!n) break;
              const chunk = buffer.subarray(0, n); length += n; total += n;
              if (length > entry.bytes || total > row.bytes) fail('MANIFEST_MISMATCH');
              partHash.update(chunk); hash.update(chunk); writeAll(output, chunk);
            }
          } finally { closeSync(input); }
          if (length !== entry.bytes || partHash.digest('hex') !== entry.hash) fail('MANIFEST_MISMATCH');
        }
        if (total !== row.bytes || hash.digest('hex') !== row.hash) fail('MANIFEST_MISMATCH');
        fsyncSync(output); closeSync(output); output = undefined;
        renameSync(temporary, join(dir, 'payload')); syncDirectory(dir);
        this.fault('payload-published');
        this.db.prepare('UPDATE transfers SET ready=1 WHERE id=?').run(id);
        return {payloadRef: id, digest: row.hash, byteLength: row.bytes, kind: row.kind, encodingVersion: 'shiwen-json-v1'};
      } finally {
        if (output !== undefined) closeSync(output);
        if (existsSync(temporary)) unlinkSync(temporary);
      }
    })();
  }
  read(ctx, id, {kind, start = 0, end} = {}) {
    const row = this.task(ctx, id), path = join(this.folder(id), 'payload');
    if (kind !== row.kind) fail('PERMISSION_DENIED');
    if (!row.ready || !existsSync(path)) fail('DEPENDENCY_MISSING');
    if (statSync(path).size !== row.bytes) fail('MANIFEST_MISMATCH');
    if (!Number.isSafeInteger(start) || start < 0 || (row.bytes ? start >= row.bytes : start !== 0)
      || end !== undefined && (!Number.isSafeInteger(end) || end < start || end >= row.bytes)) fail('VALIDATION_ERROR');
    return createReadStream(path, {start, ...(end === undefined ? {} : {end})});
  }
  readBytes(ctx,id,{kind}={}){const row=this.task(ctx,id),path=join(this.folder(id),'payload');if(kind!==row.kind)fail('PERMISSION_DENIED');if(!row.ready||!existsSync(path))fail('DEPENDENCY_MISSING');if(statSync(path).size!==row.bytes)fail('MANIFEST_MISMATCH');const bytes=readFileSync(path);if(bytes.length!==row.bytes||sha256(bytes)!==row.hash)fail('MANIFEST_MISMATCH');return {bytes,metadata:JSON.parse(row.metadata),digest:row.hash};}
  publish(ctx,{kind,bytes,digest,metadata={}}){if(!Buffer.isBuffer(bytes)||sha256(bytes)!==digest)fail('MANIFEST_MISMATCH');const task=this.begin(ctx,{kind,byteLength:bytes.length,digest,metadata});for(let part=0;part*task.partBytes<bytes.length;part++){const start=part*task.partBytes,chunk=bytes.subarray(start,Math.min(bytes.length,start+task.partBytes));if(!task.missingParts.includes(part))continue;this.putPart(ctx,task.uploadId,part,chunk,sha256(chunk));}return this.commit(ctx,task.uploadId);}
}
function sortObject(value){if(Array.isArray(value))return value.map(sortObject);if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,sortObject(value[key])]));return value;}
function writeAll(fd, buffer) {
  for (let offset = 0; offset < buffer.length;) offset += writeSync(fd, buffer, offset, buffer.length - offset);
}
function syncDirectory(path) {
  // Directory fsync is supported by the Linux coordinator. Windows needs a
  // separately verified publication adapter before this primitive is enabled.
  const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
}
