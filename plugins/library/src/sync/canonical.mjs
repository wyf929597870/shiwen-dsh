import {createHash} from 'node:crypto';
import {fail} from '../../../../contracts/mobile/v1/schema.mjs';

export const encodingVersion = 'shiwen-json-v1';
// A deliberately small JSON dialect, shared with Kotlin. Do not normalize text,
// sort arrays, convert dates or silently drop undefined values.
export function canonicalJSON(value, depth = 0) {
  if (depth > 64) fail('VALIDATION_ERROR', {field: 'jsonDepth'});
  if (value === null) return 'null';
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'string') {
    if (!value.isWellFormed()) fail('VALIDATION_ERROR', {field: 'unicode'});
    return JSON.stringify(value);
  }
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value === 0 ? 0 : value);
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length) fail('VALIDATION_ERROR', {field: 'sparseArray'});
    return '[' + value.map(item => canonicalJSON(item, depth + 1)).join(',') + ']';
  }
  if (typeof value === 'object' && value && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    return '{' + Object.keys(value).sort().map(key => canonicalJSON(key, depth + 1)
      + ':' + canonicalJSON(value[key], depth + 1)).join(',') + '}';
  }
  fail('VALIDATION_ERROR', {field: 'jsonType'});
}
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const fingerprint = value => sha256(canonicalJSON(value));
export function businessFingerprint(op) {
  const {operationId, baseRevision, localGeneration, ...business} = op;
  return fingerprint(business);
}
export const contentHash = (markdown, segments) => fingerprint({markdown, segments});
export function transportFor(op, capabilities) {
  const byteLength = Buffer.byteLength(canonicalJSON(op));
  if (byteLength > capabilities.maxCanonicalOperationBytes) fail('PROTOCOL_UNSUPPORTED', {byteLength});
  return {mode: byteLength <= capabilities.maxInlineBytes ? 'inline' : 'reference', byteLength,
    digest: fingerprint(op), encodingVersion};
}
