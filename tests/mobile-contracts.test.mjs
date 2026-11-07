import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {canonicalJSON, fingerprint, businessFingerprint, transportFor} from '../plugins/library/src/sync/canonical.mjs';
import {schemas, parseOperation, limits} from '../contracts/mobile/v1/schema.mjs';
import {createOperation} from './support/mobile/operations.mjs';
const fixtures = JSON.parse(readFileSync(new URL('../contracts/mobile/v1/fixtures/canonical.json', import.meta.url)));
for (const f of fixtures) test(`JS/Kotlin canonical fixture: ${f.name}`, () => {
  assert.equal(canonicalJSON(f.value), f.canonical); assert.equal(fingerprint(f.value), f.sha256);
});
test('non-JSON values and malformed Unicode are rejected rather than hashed ambiguously', () => {
  for (const value of [undefined, NaN, Infinity, 0.5, 9007199254740992, new Date(), '\ud800', '\udc00', [undefined], Array(2)])
    assert.throws(() => canonicalJSON(value), /VALIDATION_ERROR/);
});
test('generated JSON schemas stay in sync with strict executable contracts', () => {
  const file = JSON.parse(readFileSync(new URL('../contracts/mobile/v1/schema.json', import.meta.url)));
  for (const [name, schema] of Object.entries(schemas)) assert.deepEqual(file.schemas[name], z.toJSONSchema(schema));
});
test('preserve text, provenance and record identity; reject unknown input, wrong baselines and invalid source maps', () => {
  const op = createOperation(randomUUID(), '\r\n# 原文\n👩🏽‍💻 é\n');
  assert.equal(parseOperation(op).payload.markdown, op.payload.markdown);
  for (const mutate of [o => o.extra = true, o => o.payload.id = randomUUID(), o => o.payload.sources[0].text = 'x',
    o => o.baseRevision = 1, o => o.payload.deleted = true, o => o.timeZone = 'not/a-zone']) {
    const bad = structuredClone(op); mutate(bad); assert.throws(() => parseOperation(bad), /VALIDATION_ERROR/);
  }
});
test('request fingerprint excludes transport but immutable business identity survives a new envelope', () => {
  const op = createOperation(randomUUID()), newEnvelope = {...op, operationId: randomUUID(), baseRevision: 7, localGeneration: 12};
  assert.notEqual(fingerprint(newEnvelope), fingerprint(op));
  assert.equal(businessFingerprint(newEnvelope), businessFingerprint(op));
  assert.notEqual(businessFingerprint({...op, occurredAt: '2026-11-07T00:00:00Z'}), businessFingerprint(op));
});
test('near-limit Chinese with provenance and activity snapshots exceeds inline size without losing supported content', () => {
  const op = createOperation(randomUUID(), '文'.repeat(1_000_000));
  parseOperation(op);
  const transport = transportFor(op, limits);
  assert.equal(transport.mode, 'reference'); assert.ok(transport.byteLength > limits.maxRequestBytes);
  // Chunk boundaries may split UTF-8 sequences: concatenate bytes before decoding.
  const bytes = Buffer.from(canonicalJSON(op)), chunks = [];
  for (let start = 0; start < bytes.length; start += limits.maxPartBytes) chunks.push(bytes.subarray(start, start + limits.maxPartBytes));
  const decoded = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  assert.equal(fingerprint(decoded), transport.digest);
  assert.equal(parseOperation(decoded).payload.markdown.length, 1_000_000);
  assert.throws(() => transportFor(op, {...limits, maxCanonicalOperationBytes: limits.maxRequestBytes}), /PROTOCOL_UNSUPPORTED/);
});
test('UTF-16 body bound matches current desktop API, including emoji', () => {
  assert.equal(parseOperation(createOperation(randomUUID(), '🌱'.repeat(500_000))).payload.markdown.length, 1_000_000);
  assert.throws(() => parseOperation(createOperation(randomUUID(), '🌱'.repeat(500_001))), /VALIDATION_ERROR/);
});
