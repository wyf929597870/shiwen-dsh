import {z} from 'zod';

// P0 contracts. These are not advertised by the running desktop service yet.
export const protocolVersion = '1.0.0-draft.2';
export const limits = Object.freeze({maxBodyCodeUnits: 1_000_000, maxBatchOperations: 100,
  maxRequestBytes: 4 * 1024 ** 2, maxInlineBytes: 512 * 1024, maxPartBytes: 1024 ** 2,
  maxCanonicalOperationBytes: 64 * 1024 ** 2});
export const errorCodes = ['AUTH_REQUIRED', 'PERMISSION_DENIED', 'LIBRARY_MISMATCH',
  'PROTOCOL_UNSUPPORTED', 'EPOCH_CHANGED', 'REVISION_CONFLICT', 'OPERATION_REUSED',
  'DEPENDENCY_MISSING', 'VALIDATION_ERROR', 'PAYLOAD_TOO_LARGE', 'STORAGE_FULL',
  'SETUP_TARGET_BUSY', 'SETUP_TARGET_CHANGED', 'SETUP_LEASE_EXPIRED', 'SETUP_NOT_READY',
  'SETUP_ALREADY_COMMITTED', 'MANIFEST_MISMATCH', 'RECONCILIATION_REQUIRED'];
const object = shape => z.object(shape).strict();
const uuid = z.uuid();
const id = z.string().min(1).max(100); // Existing imported record IDs are retained.
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const dateTime = z.iso.datetime({offset: true});
const origin = z.enum(['personal', 'external', 'ai', 'translation', 'unknown']);
export const segment = object({text: z.string().max(limits.maxBodyCodeUnits), origin,
  sourceRef: z.string().max(2048).optional()});
const segments = z.array(segment).max(100_000);
export const record = object({
  id, kind: z.enum(['journal', 'freewrite', 'idea', 'web', 'ai', 'reference', 'article']),
  title: z.string().max(200), markdown: z.string().max(limits.maxBodyCodeUnits), origin,
  processing: z.enum(['original', 'formatting', 'ai-organized', 'translation', 'unknown']),
  contentDay: z.iso.date().nullable(), dateBasis: z.string().max(200),
  url: z.union([z.literal(''), z.url({protocol: /^https?$/}).max(2048)]),
  annotation: z.string().max(10_000), stage: z.enum(['idea', 'draft', 'revision', 'final']),
  sourceIds: z.array(id).max(1000), sources: segments,
  attachmentDescriptors: z.array(object({id, hash: digest, byteLength: integer,
    name: z.string().max(500)})).max(10_000),
  createdAt: dateTime, updatedAt: dateTime, deleted: z.boolean(), createdByDevice: uuid.nullable(),
});
export const version = object({id:uuid,recordId:id,revision:integer.min(1),markdown:z.string().max(limits.maxBodyCodeUnits),
  doc:z.record(z.string(),z.unknown()),sources:segments,parentVersionIds:z.array(uuid).max(1000),title:z.string().max(200),
  createdAt:dateTime,reason:z.string().max(100)});
export const activity = object({activityId: uuid, recordId:id.optional(), changeId:uuid.nullable().optional(), originDeviceId: uuid.nullable(),
  occurredAt: dateTime, timeZone: z.string().min(1).max(100), beforeHash: digest, afterHash: digest,
  afterSegments: segments, action: z.enum(['write', 'copy', 'import', 'restore', 'resolve']), authorship: origin});
export const head = object({recordId:id,revision:integer.min(1),versionId:uuid,changeId:uuid.nullable(),deleted:z.boolean()});
export const attachment = object({id,recordId:id,name:z.string().max(500),createdAt:dateTime,hash:digest,byteLength:integer,branchId:uuid.optional()});
export const branch = object({branchId:uuid,recordId:id,state:z.enum(['retained','discarded','merged']),sourceServerId:uuid,
  sourceEpoch:uuid,sourceDeviceId:uuid,manifestDigest:digest,head,record,versions:z.array(version).max(100_000),
  activities:z.array(activity).max(100_000),links:z.array(object({articleId:id,materialId:id})).max(100_000),
  provenance:z.record(z.string(),z.unknown()).nullable(),attachments:z.array(attachment).max(10_000),createdAt:dateTime});
export const operation = object({operationId: uuid, recordId: id, changeId: uuid, versionId: uuid,
  baseVersionId: uuid.nullable(), parentVersionIds: z.array(uuid).max(1000), originDeviceId: uuid.nullable(),
  action: z.enum(['create', 'update', 'delete', 'restore', 'restore-and-update']),
  baseRevision: integer.nullable(), localGeneration: integer, occurredAt: dateTime,
  timeZone: z.string().min(1).max(100), payload: record, activities: z.array(activity).max(1000)});
export const payloadReference = object({payloadRef: uuid, digest, byteLength: integer,
  encodingVersion: z.literal('shiwen-json-v1')});
export const pushItem = z.union([
  object({inlineBody: operation}),
  object({operationId: uuid, requestFingerprint: digest, payloadReference}),
]);
export const push = object({libraryId: uuid, epoch: uuid, deviceId: uuid,
  operations: z.array(pushItem).min(1).max(limits.maxBatchOperations)});
export const receipts = object({libraryId: uuid, epoch: uuid, deviceId: uuid,
  operationIds: z.array(uuid).min(1).max(limits.maxBatchOperations)});
export const setup = object({setupId: uuid, mode: z.enum(['initialize', 'recover']), libraryId: uuid,
  targetGeneration: integer, expectedLibraryId: uuid.nullable(), expectedEpoch: uuid.nullable(),
  sourceEpoch: uuid.nullable(), manifestDigest: digest});
export const reconcile = object({taskId: uuid, mode: z.enum(['coordinator-recovery', 'device-restore']),
  libraryId: uuid, sourceEpoch: uuid.nullable(), targetEpoch: uuid, sourceDeviceIds: z.array(uuid).max(1000),
  manifestDigest: digest});
export const ack = object({libraryId: uuid, epoch: uuid, deviceId: uuid,
  appliedCursor: integer, completeCursor: integer, manifestDigest: digest});
export const bridgeContext = object({libraryId: uuid, requestId: uuid, pageGeneration: integer});
export const schemas = {record, version, head, activity, attachment, branch, operation, push, receipts, setup, reconcile, ack, bridgeContext};

export class ProtocolError extends Error {
  constructor(code, details = {}) { super(code); this.name = 'ProtocolError'; this.code = code; this.details = details; }
}
export const fail = (code, details) => { throw new ProtocolError(code, details); };
export function parseOperation(input) {
  const result = operation.safeParse(input);
  if (!result.success) fail('VALIDATION_ERROR', {issues: result.error.issues});
  const op = result.data;
  if (op.recordId !== op.payload.id || op.payload.sources.map(s => s.text).join('') !== op.payload.markdown)
    fail('VALIDATION_ERROR', {field: 'sources'});
  if ((op.action === 'create') !== (op.baseRevision === null && op.baseVersionId === null)
    || op.action !== 'create' && (op.baseRevision === null || op.baseVersionId === null))
    fail('VALIDATION_ERROR', {field: 'baseVersionId'});
  if (op.payload.deleted !== (op.action === 'delete')) fail('VALIDATION_ERROR', {field: 'deleted'});
  for (const value of [op.timeZone, ...op.activities.map(a => a.timeZone)]) {
    try { new Intl.DateTimeFormat('en', {timeZone: value}); } catch { fail('VALIDATION_ERROR', {field: 'timeZone'}); }
  }
  if (new Set(op.activities.map(a => a.activityId)).size !== op.activities.length)
    fail('VALIDATION_ERROR', {field: 'activityId'});
  return op;
}
