import {randomUUID} from 'node:crypto';
import {contentHash} from '../../../plugins/library/src/sync/canonical.mjs';
export function createOperation(deviceId, markdown = '散步后，记下今天的想法。') {
  const id = randomUUID(), at = '2026-11-06T03:20:00Z', sources = [{text: markdown, origin: 'personal'}];
  return {operationId: randomUUID(), recordId: id, changeId: randomUUID(), versionId: randomUUID(),
    baseVersionId: null, parentVersionIds: [], originDeviceId: deviceId, action: 'create', baseRevision: null,
    localGeneration: 1, occurredAt: at, timeZone: 'Asia/Shanghai',
    payload: {id, kind: 'journal', title: '散步之后', markdown, origin: 'personal', processing: 'original',
      contentDay: '2026-11-06', dateBasis: 'user', url: '', annotation: '', stage: 'draft', sourceIds: [],
      sources, attachmentDescriptors: [], createdAt: at, updatedAt: at, deleted: false, createdByDevice: deviceId},
    activities: [{activityId: randomUUID(), originDeviceId: deviceId, occurredAt: at, timeZone: 'Asia/Shanghai',
      beforeHash: contentHash('', []), afterHash: contentHash(markdown, sources), afterSegments: sources,
      action: 'write', authorship: 'personal'}]};
}
