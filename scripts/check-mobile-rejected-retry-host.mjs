// Verify that a parse-time validation rejection is not a durable receipt and can
// be safely repaired using the same operation identity. Uses only a temporary Host.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {contentHash} from '../plugins/library/src/sync/canonical.mjs';
import {startServer, stopServer} from './server-control.mjs';

const root = await mkdtemp(join(tmpdir(), 'shiwen-rejected-retry-host-'));
const password = 'Synthetic-retry-host-7331';
let service;
const request = async (url, body, cookie, origin) => fetch(url, {
  method: 'POST', redirect: 'manual',
  headers: {origin, cookie, 'content-type': 'application/json'}, body: JSON.stringify(body),
});
const cookieOf = response => response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
try {
  service = await startServer({root, host: '127.0.0.1', port: 0}, {runtime: resolve(import.meta.dirname, '..')});
  const origin = new URL(service.url).origin;
  const bootstrap = await fetch(service.loginUrl, {redirect: 'manual'});
  assert.equal(bootstrap.status, 303);
  const setup = await request(new URL('/auth/password', service.url), {password}, cookieOf(bootstrap), origin);
  assert.equal(setup.status, 200);
  const ownerCookie = cookieOf(setup);
  assert.ok(ownerCookie);

  const rpc = async (action, args) => {
    const response = await request(new URL('/api/shiwen', service.url),
      {method: 'mobileSync', args: {action, request: args}}, ownerCookie, origin);
    const body = await response.json();
    assert.equal(response.status, 200, `${action}: ${JSON.stringify(body)}`);
    return body.result.data;
  };
  const deviceId = randomUUID();
  const identity = await rpc('identity', {deviceId, protocolVersion: '1.0.0-draft.2'});
  const binding = {libraryId: identity.libraryId, epoch: identity.epoch, deviceId};
  const id = randomUUID();
  const operationId = randomUUID();
  const changeId = randomUUID();
  const versionId = randomUUID();
  const activityId = randomUUID();
  const occurredAt = new Date().toISOString();
  const markdown = '修复后的原文';
  const sources = [{text: markdown, origin: 'personal'}];
  const operation = {
    operationId, recordId: id, changeId, versionId, baseVersionId: null, parentVersionIds: [],
    originDeviceId: deviceId, action: 'create', baseRevision: null, localGeneration: 1,
    occurredAt, timeZone: 'Asia/Shanghai',
    payload: {
      id, kind: 'journal', title: 'Rejected request retry', markdown, origin: 'personal',
      processing: 'original', contentDay: null, dateBasis: 'unknown', url: '', annotation: '',
      stage: 'draft', sourceIds: [], sources, attachmentDescriptors: [],
      createdAt: occurredAt, updatedAt: occurredAt, deleted: false, createdByDevice: deviceId,
    },
    activities: [{activityId, originDeviceId: deviceId, occurredAt, timeZone: 'Asia/Shanghai',
      beforeHash: contentHash('', []), afterHash: contentHash(markdown, sources),
      afterSegments: sources, action: 'write', authorship: 'personal'}],
  };

  // Strict parse rejects the first body before any business write or receipt insert.
  const invalid = {...operation, nativeOnlyField: true};
  const rejected = await rpc('push', {...binding, operations: [{inlineBody: invalid}]});
  assert.equal(rejected.receipts[0].operationId, operationId);
  assert.equal(rejected.receipts[0].status, 'rejected');
  assert.equal(rejected.receipts[0].code, 'VALIDATION_ERROR');
  const beforeRetry = await rpc('receipts', {...binding, operationIds: [operationId]});
  assert.equal(beforeRetry.receipts[0].status, 'unknown', 'rejections are not durable immutable receipts');

  // Repaired payload keeps its operationId/changeId/versionId and applies once.
  const applied = await rpc('push', {...binding, operations: [{inlineBody: operation}]});
  assert.equal(applied.receipts[0].operationId, operationId);
  assert.equal(applied.receipts[0].status, 'applied');
  const afterRetry = await rpc('receipts', {...binding, operationIds: [operationId]});
  assert.equal(afterRetry.receipts[0].status, 'applied');
  assert.equal(afterRetry.receipts[0].versionId, versionId);

  const snapshot = await rpc('bootstrapBegin', binding);
  const page = await rpc('bootstrapPage', {...binding, snapshotId: snapshot.snapshotId, entityType: 'records', limit: 100});
  const saved = page.items.find(record => record.id === id);
  assert.equal(saved?.markdown, markdown);
  assert.equal(page.items.filter(record => record.id === id).length, 1);
  console.log('Rejected operation retry passed: no rejection receipt, same identity applies once, final snapshot contains one repaired record.');
} finally {
  try { if (service) await stopServer(root); }
  finally { await rm(root, {recursive: true, force: true}); }
}
