import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {createStore} from '../plugins/library/legacy/store.mjs';
import Database from '../plugins/library/legacy/sqlite.mjs';
import {markdownSegments} from '../plugins/library/legacy/markdown.mjs';
import {record as recordSchema} from '../contracts/mobile/v1/schema.mjs';
import {contentHash,fingerprint} from '../plugins/library/src/sync/canonical.mjs';

function isolated(t){const dir=mkdtempSync(join(tmpdir(),'shiwen-sync-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const store=createStore(join(dir,'library.sqlite'));t.after(()=>store.close());return store;}

test('mobile sync identity is stable, bootstrap is paged and validates portable record DTOs',t=>{
  const store=isolated(t),saved=store.save({kind:'journal',title:'同步日记',body:'正文内容'});
  store.attachmentAdd({record:saved.id,name:'proof.txt',data:Buffer.from('proof').toString('base64')});
  const sync=store.mobileSync(),deviceId=randomUUID(),identity=sync.identity({protocolVersion:'1.0.0-draft.2',deviceId});
  assert.equal(sync.identity({protocolVersion:'1.0.0-draft.2',deviceId}).libraryId,identity.libraryId);
  const begun=sync.bootstrapBegin({libraryId:identity.libraryId,epoch:identity.epoch,deviceId});
  const page=sync.bootstrapPage({snapshotId:begun.snapshotId,entityType:'records',limit:1});
  assert.equal(page.highWatermark,begun.highWatermark);assert.equal(page.items.length,1);
  assert.equal(recordSchema.parse(page.items[0]).markdown,'正文内容');
  const attachments=sync.bootstrapPage({snapshotId:begun.snapshotId,entityType:'attachments'});
  assert.equal(attachments.items[0].hash,createHash('sha256').update('proof').digest('hex'));assert.equal(attachments.items[0].recordId,saved.id);
  const changes=sync.changes({libraryId:identity.libraryId,epoch:identity.epoch,deviceId,cursor:0});
  assert.equal(changes.events.length,2);assert.equal(changes.events.at(-1).record.attachmentDescriptors.length,1);
  const event=changes.events[0];assert.equal(event.version.id,event.versionId);assert.equal(event.version.recordId,event.recordId);
  assert.equal(event.version.revision,event.revision);assert.equal(event.version.markdown,event.record.markdown);
});

test('date corrections and tombstones produce durable incremental events, ACK is monotonic-bounded',t=>{
  const store=isolated(t),saved=store.saveDsh({kind:'journal',title:'同步日记',body:'第一版',origin:'personal',day:'2026-11-01',sessionId:'s',messageId:'m',role:'user',operationId:'seed'}),sync=store.mobileSync(),deviceId=randomUUID();
  const identity=sync.identity({protocolVersion:'1.0.0-draft.2',deviceId});
  const baseline=sync.bootstrapBegin({libraryId:identity.libraryId,epoch:identity.epoch,deviceId});
  store.updateRecord({id:saved.id,revision:saved.revision,body:'第二版',day:'2026-11-02'});
  store.recordDate({id:saved.id,day:'2026-11-07'});
  store.remove({id:saved.id,revision:store.get(saved.id).revision});
  const events=sync.changes({libraryId:identity.libraryId,epoch:identity.epoch,deviceId,cursor:0,limit:10});
  assert.deepEqual(events.events.map(event=>event.action),['create','update','update','delete']);
  assert.ok(events.events.every(event=>event.version.id===event.versionId&&event.version.revision===event.revision));
  assert.equal(events.events.at(-1).record.deleted,true);
  assert.throws(()=>sync.ack({libraryId:identity.libraryId,epoch:identity.epoch,deviceId,appliedCursor:4,completeCursor:5,manifestDigest:baseline.manifest.manifestDigest}),/VALIDATION_ERROR/);
  assert.deepEqual(sync.ack({libraryId:identity.libraryId,epoch:identity.epoch,deviceId,appliedCursor:4,completeCursor:4,manifestDigest:baseline.manifest.manifestDigest}).completeCursor,4);
});

test('push preserves client identities and metadata, CAS receipts are idempotent and device-scoped',t=>{
  const store=isolated(t),sync=store.mobileSync(),deviceId=randomUUID(),id=randomUUID(),operationId=randomUUID(),changeId=randomUUID(),versionId=randomUUID();
  const identity=sync.identity({protocolVersion:'1.0.0-draft.2',deviceId});
  const payload={id,kind:'journal',title:'来自手机',markdown:'原文',origin:'personal',processing:'original',contentDay:'2026-11-02',dateBasis:'手工日期',url:'',annotation:'',stage:'draft',sourceIds:[],sources:[{text:'原文',origin:'personal',sourceRef:'local:voice'}],attachmentDescriptors:[],createdAt:'2026-11-02T01:00:00.000Z',updatedAt:'2026-11-03T01:00:00.000Z',deleted:false,createdByDevice:deviceId};
  const activity={activityId:randomUUID(),recordId:id,changeId,originDeviceId:deviceId,occurredAt:'2026-11-03T01:00:00.000Z',timeZone:'Asia/Shanghai',beforeHash:contentHash('',[]),afterHash:contentHash(payload.markdown,payload.sources),afterSegments:payload.sources,action:'write',authorship:'unknown'};
  const operation={operationId,recordId:id,changeId,versionId,baseVersionId:null,parentVersionIds:[],originDeviceId:deviceId,action:'create',baseRevision:null,localGeneration:1,occurredAt:'2026-11-03T01:00:00.000Z',timeZone:'Asia/Shanghai',payload,activities:[activity]};
  const request={libraryId:identity.libraryId,epoch:identity.epoch,deviceId,operations:[{inlineBody:operation}]};
  const first=sync.push(request).receipts[0],again=sync.push(request).receipts[0];
  assert.equal(first.status,'applied');assert.deepEqual(again,first);
  const saved=store.get(id);assert.equal(saved.created,'2026-11-02T01:00:00.000Z');assert.equal(saved.updated,'2026-11-03T01:00:00.000Z');
  const backupTables=JSON.parse(store.exportBackup()).payload.tables;assert.equal(backupTables.edits.filter(item=>item.record===id&&item.origin==='personal').reduce((sum,item)=>sum+item.added-item.removed,0),2);assert.equal(backupTables.edits.filter(item=>item.record===id).length,1);
  const row=sync.changes({libraryId:identity.libraryId,epoch:identity.epoch,deviceId,cursor:0}).events[0].record;
  assert.equal(row.processing,'original');assert.deepEqual(row.sources,[{text:'原文',origin:'personal',sourceRef:'local:voice'}]);
  const manifest=sync.bootstrapBegin({libraryId:identity.libraryId,epoch:identity.epoch,deviceId}),versions=sync.bootstrapPage({snapshotId:manifest.snapshotId,entityType:'versions'});
  assert.deepEqual(versions.items[0].sources,payload.sources);assert.equal(versions.items[0].doc.content[0].content[0].text,'原文');
  const receipt=sync.receipts({libraryId:identity.libraryId,epoch:identity.epoch,deviceId,operationIds:[operationId]}).receipts[0];assert.deepEqual(receipt,first);
  assert.equal(sync.receipts({libraryId:identity.libraryId,epoch:identity.epoch,deviceId:randomUUID(),operationIds:[operationId]}).receipts[0].status,'unknown');
});

test('same changeId maps across re-envelopes but rejects a changed business fingerprint',t=>{
  const store=isolated(t),sync=store.mobileSync(),deviceId=randomUUID(),identity=sync.identity({protocolVersion:'1.0.0-draft.2',deviceId}),recordId=randomUUID(),changeId=randomUUID(),versionId=randomUUID();
  const payload={id:recordId,kind:'idea',title:'same change',markdown:'same body',origin:'personal',processing:'original',contentDay:null,dateBasis:'',url:'',annotation:'',stage:'idea',sourceIds:[],sources:[{text:'same body',origin:'personal'}],attachmentDescriptors:[],createdAt:'2026-11-01T00:00:00.000Z',updatedAt:'2026-11-01T00:00:00.000Z',deleted:false,createdByDevice:deviceId};
  const op={operationId:randomUUID(),recordId,changeId,versionId,baseVersionId:null,parentVersionIds:[],originDeviceId:deviceId,action:'create',baseRevision:null,localGeneration:1,occurredAt:payload.createdAt,timeZone:'UTC',payload,activities:[]};
  const first=sync.push({libraryId:identity.libraryId,epoch:identity.epoch,deviceId,operations:[{inlineBody:op}]}).receipts[0];assert.equal(first.status,'applied');
  const rewrapped={...op,operationId:randomUUID(),localGeneration:2},mapped=sync.push({libraryId:identity.libraryId,epoch:identity.epoch,deviceId,operations:[{inlineBody:rewrapped}]}).receipts[0];
  assert.equal(mapped.duplicateChange,true);assert.equal(mapped.seq,first.seq);
  const altered={...rewrapped,operationId:randomUUID(),versionId:randomUUID(),payload:{...payload,title:'different'}};
  assert.throws(()=>sync.push({libraryId:identity.libraryId,epoch:identity.epoch,deviceId,operations:[{inlineBody:altered}]}),/OPERATION_REUSED/);
});

test('import activities preserve personal attribution without counting imported history as new writing',t=>{
  const store=isolated(t),sync=store.mobileSync(),deviceId=randomUUID(),identity=sync.identity({protocolVersion:'1.0.0-draft.2',deviceId}),recordId=randomUUID(),markdown='导入旧日记',sources=[{text:markdown,origin:'personal'}],payload={id:recordId,kind:'journal',title:'历史',markdown,origin:'personal',processing:'original',contentDay:'2025-01-01',dateBasis:'导入日期',url:'',annotation:'',stage:'draft',sourceIds:[],sources,attachmentDescriptors:[],createdAt:'2025-01-01T00:00:00.000Z',updatedAt:'2025-01-01T00:00:00.000Z',deleted:false,createdByDevice:deviceId};
  const activity={activityId:randomUUID(),recordId,changeId:randomUUID(),originDeviceId:deviceId,occurredAt:payload.createdAt,timeZone:'UTC',beforeHash:contentHash('',[]),afterHash:contentHash(markdown,sources),afterSegments:sources,action:'import',authorship:'personal'},operation={operationId:randomUUID(),recordId,changeId:activity.changeId,versionId:randomUUID(),baseVersionId:null,parentVersionIds:[],originDeviceId:deviceId,action:'create',baseRevision:null,localGeneration:1,occurredAt:payload.createdAt,timeZone:'UTC',payload,activities:[activity]};
  assert.equal(sync.push({libraryId:identity.libraryId,epoch:identity.epoch,deviceId,operations:[{inlineBody:operation}]}).receipts[0].status,'applied');assert.equal(JSON.parse(store.exportBackup()).payload.tables.edits.length,0);
});

test('new record attachment can be staged before create and is committed atomically with the record',t=>{
  const store=isolated(t),sync=store.mobileSync(),deviceId=randomUUID(),otherDevice=randomUUID(),identity=sync.identity({protocolVersion:'1.0.0-draft.2',deviceId}),recordId=randomUUID(),attachmentId=randomUUID(),bytes=Buffer.from('original markdown bytes'),digest=createHash('sha256').update(bytes).digest('hex');
  assert.equal(sync.putAttachment({libraryId:identity.libraryId,epoch:identity.epoch,deviceId,recordId,attachmentId,name:'original.md',bytes,digest}).staged,true);
  const markdown='正文带原件',sources=[{text:markdown,origin:'personal'}],createdAt='2026-11-07T01:02:03.000Z',payload={id:recordId,kind:'journal',title:'含原件',markdown,origin:'personal',processing:'original',contentDay:'2026-11-07',dateBasis:'created',url:'',annotation:'',stage:'draft',sourceIds:[],sources,attachmentDescriptors:[{id:attachmentId,hash:digest,byteLength:bytes.length,name:'original.md'}],createdAt,updatedAt:createdAt,deleted:false,createdByDevice:deviceId};
  const activity={activityId:randomUUID(),recordId,changeId:randomUUID(),originDeviceId:deviceId,occurredAt:createdAt,timeZone:'UTC',beforeHash:contentHash('',[]),afterHash:contentHash(markdown,sources),afterSegments:sources,action:'write',authorship:'personal'},operation={operationId:randomUUID(),recordId,changeId:activity.changeId,versionId:randomUUID(),baseVersionId:null,parentVersionIds:[],originDeviceId:deviceId,action:'create',baseRevision:null,localGeneration:1,occurredAt:createdAt,timeZone:'UTC',payload,activities:[activity]};
  const blocked=sync.push({libraryId:identity.libraryId,epoch:identity.epoch,deviceId:otherDevice,operations:[{inlineBody:operation}]}).receipts[0];assert.equal(blocked.status,'blocked-dependency');assert.deepEqual(blocked.missingAttachmentIds,[attachmentId]);assert.equal(store.get(recordId),null);
  const applied=sync.push({libraryId:identity.libraryId,epoch:identity.epoch,deviceId,operations:[{inlineBody:operation}]}).receipts[0];assert.equal(applied.status,'applied');
  const transfer=sync.attachmentChunk({libraryId:identity.libraryId,epoch:identity.epoch,deviceId,attachmentId,offset:0,byteLength:100});assert.equal(transfer.dataBase64,bytes.toString('base64'));
  const event=sync.changes({libraryId:identity.libraryId,epoch:identity.epoch,deviceId,cursor:0,limit:10}).events.find(item=>item.changeId===operation.changeId);assert.equal(event.record.attachmentDescriptors[0].id,attachmentId);assert.equal(event.record.attachmentDescriptors[0].hash,digest);
});

test('setup transfer keys same attachment ID separately for current record and retained branch',t=>{
  const source=isolated(t),sourceSync=source.mobileSync(),deviceId=randomUUID(),sourceIdentity=sourceSync.identity({protocolVersion:'1.0.0-draft.2',deviceId});
  const saved=source.save({kind:'journal',title:'保留原件',body:'正文'}),attachmentId=source.attachmentAdd({record:saved.id,name:'original.md',data:Buffer.from('same attachment').toString('base64')}),raw=source.exportBackup(),rawAttachment=JSON.parse(raw).payload.tables.attachments.find(item=>item.id===attachmentId),snapshot=sourceSync.bootstrapBegin({libraryId:sourceIdentity.libraryId,epoch:sourceIdentity.epoch,deviceId}),entities={};
  for(const type of snapshot.manifest.entityTypes)entities[type]=sourceSync.bootstrapPage({snapshotId:snapshot.snapshotId,entityType:type}).items;
  const record=entities.records[0],head=entities.heads[0],versions=entities.versions.filter(item=>item.recordId===record.id),branchId=randomUUID(),branch={branchId,recordId:record.id,state:'retained',sourceServerId:sourceIdentity.serverId,sourceEpoch:sourceIdentity.epoch,sourceDeviceId:deviceId,manifestDigest:'a'.repeat(64),head,record,versions,activities:entities.activities.filter(item=>item.recordId===record.id),links:[],provenance:null,attachments:[{...entities.attachments[0],branchId}],createdAt:'2026-11-07T00:00:00.000Z'};
  entities.branches=[branch];entities.attachments.push({...entities.attachments[0],branchId});
  const counts=Object.fromEntries(snapshot.manifest.entityTypes.map(type=>[type,entities[type].length])),entityDigests=Object.fromEntries(snapshot.manifest.entityTypes.map(type=>[type,fingerprint(entities[type])])),manifest={protocolVersion:'1.0.0-draft.2',libraryId:sourceIdentity.libraryId,epoch:sourceIdentity.epoch,snapshotId:randomUUID(),highWatermark:snapshot.highWatermark,counts,entityDigests,entityTypes:snapshot.manifest.entityTypes},manifestDigest=fingerprint(manifest);manifest.manifestDigest=manifestDigest;
  const dir=mkdtempSync(join(tmpdir(),'shiwen-sync-target-')),target=createStore(join(dir,'library.sqlite'));t.after(()=>{target.close();rmSync(dir,{recursive:true,force:true});});const targetSync=target.mobileSync(),targetDevice=randomUUID(),targetIdentity=targetSync.identity({protocolVersion:'1.0.0-draft.2',deviceId:targetDevice}),setupId=randomUUID(),begun=targetSync.setupBegin({setupId,mode:'initialize',libraryId:sourceIdentity.libraryId,sourceEpoch:sourceIdentity.epoch,manifestDigest,manifest,expectedLibraryId:targetIdentity.libraryId,expectedEpoch:targetIdentity.epoch,targetGeneration:targetIdentity.targetGeneration});
  for(const type of manifest.entityTypes)if(entities[type].length)targetSync.setupPage({setupId,fencingToken:begun.fencingToken,entityType:type,startOrdinal:0,items:entities[type]});
  const bytes=Buffer.from(rawAttachment.data,'base64'),digest=createHash('sha256').update(bytes).digest('hex');
  targetSync.setupBlobStore({setupId,fencingToken:begun.fencingToken,attachmentId,recordId:record.id,name:'original.md',bytes,digest,branchId:null});
  targetSync.setupBlobStore({setupId,fencingToken:begun.fencingToken,attachmentId,recordId:record.id,name:'original.md',bytes,digest,branchId});
  assert.equal(targetSync.setupStatus({setupId,fencingToken:begun.fencingToken}).state,'ready');
  const committed=targetSync.setupCommit({setupId,fencingToken:begun.fencingToken});assert.equal(committed.state,'committed');
  const nextIdentity=targetSync.identity({protocolVersion:'1.0.0-draft.2',deviceId:targetDevice}),manifest2=targetSync.bootstrapBegin({libraryId:nextIdentity.libraryId,epoch:nextIdentity.epoch,deviceId:targetDevice}),transferred=targetSync.bootstrapPage({snapshotId:manifest2.snapshotId,entityType:'attachments'}).items;
  assert.equal(transferred.length,2);assert.deepEqual(transferred.map(item=>item.branchId??null).sort(),[null,branchId].sort());
});

test('mobile sync may change an article to a material and removes its article source links',t=>{
  const store=isolated(t),material=store.save({kind:'freewrite',body:'素材'}),article=store.save({kind:'article',title:'文章',body:'内容',sourceIds:[material.id]}),sync=store.mobileSync(),deviceId=randomUUID(),identity=sync.identity({protocolVersion:'1.0.0-draft.2',deviceId}),base=sync.recordHead({libraryId:identity.libraryId,epoch:identity.epoch,deviceId,recordId:article.id});
  const payload={...base.record,kind:'idea',stage:'idea',sourceIds:[],title:'改为想法',markdown:'改过的素材',sources:[{text:'改过的素材',origin:'personal'}],updatedAt:'2026-11-07T00:00:00.000Z'};
  const operation={operationId:randomUUID(),recordId:article.id,changeId:randomUUID(),versionId:randomUUID(),baseVersionId:base.head.versionId,parentVersionIds:[base.head.versionId],originDeviceId:deviceId,action:'update',baseRevision:base.head.revision,localGeneration:1,occurredAt:payload.updatedAt,timeZone:'UTC',payload,activities:[]};
  assert.equal(sync.push({libraryId:identity.libraryId,epoch:identity.epoch,deviceId,operations:[{inlineBody:operation}]}).receipts[0].status,'applied');assert.equal(store.get(article.id).kind,'idea');assert.deepEqual(store.get(article.id).sourceIds,[]);
});

test('backup restore rotates epoch, retains history and rejects old cursors',t=>{
  const store=isolated(t);store.save({kind:'idea',body:'恢复后保留'});const sync=store.mobileSync(),deviceId=randomUUID(),before=sync.identity({protocolVersion:'1.0.0-draft.2',deviceId}),backup=store.exportBackup();
  store.restoreBackup(backup);const after=store.mobileSync().identity({protocolVersion:'1.0.0-draft.2',deviceId});
  assert.notEqual(after.epoch,before.epoch);assert.equal(store.snapshot().records[0].body,'恢复后保留');
  assert.throws(()=>store.mobileSync().changes({libraryId:before.libraryId,epoch:before.epoch,deviceId,cursor:0}),/EPOCH_CHANGED/);
  assert.ok(store.mobileSync().changes({libraryId:after.libraryId,epoch:after.epoch,deviceId,cursor:0}).events.length>=2);
});

test('recovery rejects another library and does not duplicate an already retained old-epoch source branch',t=>{
  const store=isolated(t),sync=store.mobileSync(),deviceId=randomUUID(),initial=sync.identity({protocolVersion:'1.0.0-draft.2',deviceId}),emptyBackup=store.exportBackup();
  store.save({kind:'journal',title:'旧协调中心',body:'已确认的历史正文'});
  const sourceIdentity=sync.identity({protocolVersion:'1.0.0-draft.2',deviceId}),snapshot=sync.bootstrapBegin({libraryId:sourceIdentity.libraryId,epoch:sourceIdentity.epoch,deviceId}),entities={};
  for(const type of snapshot.manifest.entityTypes)entities[type]=sync.bootstrapPage({snapshotId:snapshot.snapshotId,entityType:type}).items;
  store.restoreBackup(emptyBackup);
  const target=store.mobileSync().identity({protocolVersion:'1.0.0-draft.2',deviceId}),operationDigest=fingerprint([]),sourceServerId=sourceIdentity.serverId;
  const beginRecovery=()=>{
    const taskId=randomUUID(),manifestDigest=fingerprint({sourceServerId,sourceDeviceId:deviceId,sourceManifest:snapshot.manifest,operationCount:0,operationDigest});
    const begun=store.mobileSync().reconcileBegin({taskId,mode:'coordinator-recovery',libraryId:target.libraryId,sourceEpoch:sourceIdentity.epoch,
      targetEpoch:target.epoch,sourceDeviceId:deviceId,sourceServerId,sourceManifest:snapshot.manifest,manifestDigest,operationCount:0,operationDigest,
      targetGeneration:target.targetGeneration});
    for(const type of snapshot.manifest.entityTypes)if(entities[type].length)store.mobileSync().reconcilePage({taskId,fencingToken:begun.fencingToken,entityType:type,startOrdinal:0,items:entities[type]});
    return {taskId,begun};
  };
  const wrongCore={...snapshot.manifest,libraryId:randomUUID()};delete wrongCore.manifestDigest;
  const wrongManifest={...wrongCore,manifestDigest:fingerprint(wrongCore)},wrongOuter=fingerprint({sourceServerId,sourceDeviceId:deviceId,sourceManifest:wrongManifest,operationCount:0,operationDigest});
  assert.throws(()=>store.mobileSync().reconcileBegin({taskId:randomUUID(),mode:'coordinator-recovery',libraryId:target.libraryId,
    sourceEpoch:sourceIdentity.epoch,targetEpoch:target.epoch,sourceDeviceId:deviceId,sourceServerId,sourceManifest:wrongManifest,
    manifestDigest:wrongOuter,operationCount:0,operationDigest,targetGeneration:target.targetGeneration}),/LIBRARY_MISMATCH/);
  const first=beginRecovery(),[candidate]=store.mobileSync().reconcileCandidates({taskId:first.taskId,fencingToken:first.begun.fencingToken,cursor:0,limit:10}).items;
  assert.ok(candidate);store.mobileSync().reconcileDecide({taskId:first.taskId,fencingToken:first.begun.fencingToken,branchId:candidate.branchId,resolution:'retain-branch'});
  store.mobileSync().reconcileComplete({taskId:first.taskId,fencingToken:first.begun.fencingToken});
  const second=beginRecovery(),progress=store.mobileSync().reconcileStatus({taskId:second.taskId,fencingToken:second.begun.fencingToken});
  assert.equal(progress.candidateCount,0);
  assert.equal(store.mobileSync().bootstrapPage({snapshotId:store.mobileSync().bootstrapBegin({libraryId:target.libraryId,epoch:target.epoch,deviceId}).snapshotId,entityType:'branches'}).items.length,1);
  assert.equal(initial.libraryId,target.libraryId);
});

test('setup imports a complete immutable snapshot atomically and fences writes to the target',t=>{
  const source=isolated(t),target=isolated(t),material=source.save({kind:'freewrite',title:'素材',body:'原始素材'});
  const article=source.save({kind:'article',title:'文章',body:'**发布稿**',sourceIds:[material.id]});
  source.attachmentAdd({record:article.id,name:'原件.md',data:Buffer.from('raw source').toString('base64')});
  const sourceSync=source.mobileSync(),targetSync=target.mobileSync(),deviceId=randomUUID();
  const sourceIdentity=sourceSync.identity({protocolVersion:'1.0.0-draft.2',deviceId}),targetIdentity=targetSync.identity({protocolVersion:'1.0.0-draft.2',deviceId});
  assert.equal(targetIdentity.targetGeneration,0);
  const snapshot=sourceSync.bootstrapBegin({libraryId:sourceIdentity.libraryId,epoch:sourceIdentity.epoch,deviceId});
  const setupId=randomUUID(),begin=targetSync.setupBegin({setupId,mode:'initialize',libraryId:sourceIdentity.libraryId,sourceEpoch:sourceIdentity.epoch,manifestDigest:snapshot.manifest.manifestDigest,manifest:snapshot.manifest,expectedLibraryId:targetIdentity.libraryId,expectedEpoch:targetIdentity.epoch,targetGeneration:targetIdentity.targetGeneration});
  assert.throws(()=>targetSync.setupBegin({setupId:randomUUID(),mode:'initialize',libraryId:sourceIdentity.libraryId,sourceEpoch:sourceIdentity.epoch,manifestDigest:snapshot.manifest.manifestDigest,manifest:snapshot.manifest,expectedLibraryId:targetIdentity.libraryId,expectedEpoch:targetIdentity.epoch,targetGeneration:targetIdentity.targetGeneration}),/SETUP_TARGET_BUSY/);
  for(const entityType of snapshot.manifest.entityTypes){let pageToken=null;do{const page=sourceSync.bootstrapPage({snapshotId:snapshot.snapshotId,entityType,pageToken});if(page.items.length)targetSync.setupPage({setupId,fencingToken:begin.fencingToken,entityType,startOrdinal:Number(pageToken??0),items:page.items});pageToken=page.nextPageToken;}while(pageToken!==null);}
  for(const attachment of sourceSync.bootstrapPage({snapshotId:snapshot.snapshotId,entityType:'attachments'}).items){const stored=source.attachment({id:attachment.id});targetSync.setupBlobStore({setupId,fencingToken:begin.fencingToken,attachmentId:attachment.id,recordId:attachment.recordId,name:attachment.name,bytes:Buffer.from(stored.data,'base64'),digest:attachment.hash});}
  const status=targetSync.setupStatus({setupId,fencingToken:begin.fencingToken});assert.equal(status.state,'ready');assert.equal(snapshot.manifest.counts.records,2);
  const committed=targetSync.setupCommit({setupId,fencingToken:begin.fencingToken});assert.equal(committed.state,'committed');assert.equal(committed.records,2);assert.equal(committed.attachments,1);
  assert.equal(target.mobileSync().identity({protocolVersion:'1.0.0-draft.2',deviceId}).libraryId,sourceIdentity.libraryId);
  assert.equal(target.get(article.id).body,'**发布稿**');assert.deepEqual(target.get(article.id).sourceIds,[material.id]);
  assert.deepEqual(target.attachments({record:article.id}).map(x=>x.name),['原件.md']);
  assert.deepEqual(targetSync.setupCommit({setupId,fencingToken:begin.fencingToken}),committed);

  const secondSnapshot=sourceSync.bootstrapBegin({libraryId:sourceIdentity.libraryId,epoch:sourceIdentity.epoch,deviceId}),secondId=randomUUID();
  const current=target.mobileSync().identity({protocolVersion:'1.0.0-draft.2',deviceId});
  const second=target.mobileSync().setupBegin({setupId:secondId,mode:'recover',libraryId:sourceIdentity.libraryId,sourceEpoch:sourceIdentity.epoch,manifestDigest:secondSnapshot.manifest.manifestDigest,manifest:secondSnapshot.manifest,expectedLibraryId:current.libraryId,expectedEpoch:current.epoch,targetGeneration:current.targetGeneration});
  for(const entityType of secondSnapshot.manifest.entityTypes){let pageToken=null;do{const page=sourceSync.bootstrapPage({snapshotId:secondSnapshot.snapshotId,entityType,pageToken});if(page.items.length)target.mobileSync().setupPage({setupId:secondId,fencingToken:second.fencingToken,entityType,startOrdinal:Number(pageToken??0),items:page.items});pageToken=page.nextPageToken;}while(pageToken!==null);}
  for(const attachment of sourceSync.bootstrapPage({snapshotId:secondSnapshot.snapshotId,entityType:'attachments'}).items){const stored=source.attachment({id:attachment.id});target.mobileSync().setupBlobStore({setupId:secondId,fencingToken:second.fencingToken,attachmentId:attachment.id,recordId:attachment.recordId,name:attachment.name,bytes:Buffer.from(stored.data,'base64'),digest:attachment.hash});}
  target.save({kind:'idea',body:'并发本地写入'});
  assert.throws(()=>target.mobileSync().setupCommit({setupId:secondId,fencingToken:second.fencingToken}),/SETUP_TARGET_CHANGED/);
});

test('setup preserves null dates and falls back to record dates for missing import provenance',t=>{
  const source=isolated(t),target=isolated(t),record=source.save({kind:'reference',title:'Imported note',body:'Imported body'}),
    ordinary=source.save({kind:'idea',title:'Undated note',body:'Undated body'}),
    explicitNull=source.save({kind:'reference',title:'Explicitly undated import',body:'Another body'});
  const sourceSync=source.mobileSync(),targetSync=target.mobileSync(),deviceId=randomUUID();
  const sourceIdentity=sourceSync.identity({protocolVersion:'1.0.0-draft.2',deviceId}),targetIdentity=targetSync.identity({protocolVersion:'1.0.0-draft.2',deviceId});
  const baseline=sourceSync.bootstrapBegin({libraryId:sourceIdentity.libraryId,epoch:sourceIdentity.epoch,deviceId}),entities={};
  for(const type of baseline.manifest.entityTypes)entities[type]=sourceSync.bootstrapPage({snapshotId:baseline.snapshotId,entityType:type}).items;
  const fallbackDay='2024-04-01',explicitRecordDay='2024-04-02';
  for(const item of entities.records){
    if(item.id===record.id)Object.assign(item,{contentDay:fallbackDay,dateBasis:'imported'});
    if(item.id===ordinary.id)Object.assign(item,{contentDay:null,dateBasis:'unknown'});
    if(item.id===explicitNull.id)Object.assign(item,{contentDay:explicitRecordDay,dateBasis:'manual'});
  }
  // Mirrors importMarkdown() output for a standalone file: import metadata has
  // no date fields, while the provenance entity still carries its relational owner.
  // Explicit JSON null remains authoritative and must not fall back to record fields.
  entities.provenance=[
    {recordId:record.id,import:{sourceName:'original.md',originalAttachmentId:null,files:[]},sources:[],externalSources:[]},
    {recordId:explicitNull.id,import:{sourceName:'explicit-null.md',contentDay:null,dateBasis:'unknown',originalAttachmentId:null,files:[]},sources:[],externalSources:[]},
  ];
  const counts=Object.fromEntries(baseline.manifest.entityTypes.map(type=>[type,entities[type].length]));
  const entityDigests=Object.fromEntries(baseline.manifest.entityTypes.map(type=>[type,fingerprint(entities[type])]));
  const manifestCore={...baseline.manifest,counts,entityDigests};delete manifestCore.manifestDigest;
  const manifest={...manifestCore,manifestDigest:fingerprint(manifestCore)},setupId=randomUUID();
  const begun=targetSync.setupBegin({setupId,mode:'initialize',libraryId:sourceIdentity.libraryId,sourceEpoch:sourceIdentity.epoch,
    manifestDigest:manifest.manifestDigest,manifest,expectedLibraryId:targetIdentity.libraryId,expectedEpoch:targetIdentity.epoch,
    targetGeneration:targetIdentity.targetGeneration});
  for(const type of manifest.entityTypes)if(entities[type].length)targetSync.setupPage({setupId,fencingToken:begun.fencingToken,
    entityType:type,startOrdinal:0,items:entities[type]});
  assert.equal(targetSync.setupStatus({setupId,fencingToken:begun.fencingToken}).state,'ready');
  const committed=targetSync.setupCommit({setupId,fencingToken:begun.fencingToken});assert.equal(committed.state,'committed');
  const backup=JSON.parse(target.exportBackup()).payload.tables;
  const imported=backup.imports.find(item=>item.record===record.id),explicitImported=backup.imports.find(item=>item.record===explicitNull.id);
  assert.ok(imported);assert.equal(imported.path,'original.md');assert.equal(imported.day,fallbackDay);assert.equal(imported.date_basis,'imported');
  assert.ok(explicitImported);assert.equal(explicitImported.day,null);assert.equal(explicitImported.date_basis,'unknown');
  assert.deepEqual(backup.record_dates.find(item=>item.record===ordinary.id),{record:ordinary.id,day:null,basis:'unknown'});
  const initialized=targetSync.identity({protocolVersion:'1.0.0-draft.2',deviceId});
  const remote=targetSync.bootstrapBegin({libraryId:initialized.libraryId,epoch:initialized.epoch,deviceId});
  const remoteRecords=targetSync.bootstrapPage({snapshotId:remote.snapshotId,entityType:'records'}).items;
  assert.deepEqual(remoteRecords.find(item=>item.id===record.id) && [remoteRecords.find(item=>item.id===record.id).contentDay,
    remoteRecords.find(item=>item.id===record.id).dateBasis],[fallbackDay,'imported']);
  assert.deepEqual(remoteRecords.find(item=>item.id===ordinary.id) && [remoteRecords.find(item=>item.id===ordinary.id).contentDay,
    remoteRecords.find(item=>item.id===ordinary.id).dateBasis],[null,'unknown']);
  assert.deepEqual(remoteRecords.find(item=>item.id===explicitNull.id) && [remoteRecords.find(item=>item.id===explicitNull.id).contentDay,
    remoteRecords.find(item=>item.id===explicitNull.id).dateBasis],[null,'unknown']);
});

test('bootstrap derives legacy edit activities with cross-device canonical content hashes',t=>{
  const dir=mkdtempSync(join(tmpdir(),'shiwen-sync-legacy-')),path=join(dir,'library.sqlite');let store=createStore(path);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  const first=store.save({kind:'journal',title:'历史日记',body:'第一版',origin:'personal'});store.updateRecord({id:first.id,revision:first.revision,body:'第二版'});
  store.close();const db=new Database(path);db.exec('DELETE FROM sync_activities; DELETE FROM sync_changes;');db.close();store=createStore(path);
  const sync=store.mobileSync(),deviceId=randomUUID(),identity=sync.identity({protocolVersion:'1.0.0-draft.2',deviceId}),snapshot=sync.bootstrapBegin({libraryId:identity.libraryId,epoch:identity.epoch,deviceId}),page=sync.bootstrapPage({snapshotId:snapshot.snapshotId,entityType:'activities'});
  assert.equal(page.items.length,2);const chronological=[...page.items].sort((a,b)=>a.occurredAt.localeCompare(b.occurredAt));
  const before=markdownSegments({type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'第一版',marks:[{type:'provenance',attrs:{origin:'personal'}}]}]}]},'personal');
  const firstSegments=markdownSegments({type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'第一版',marks:[{type:'provenance',attrs:{origin:'personal'}}]}]}]},'personal');
  const secondSegments=markdownSegments({type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'第二版',marks:[{type:'provenance',attrs:{origin:'personal'}}]}]}]},'personal');
  assert.equal(chronological[0].beforeHash,contentHash('',[]));assert.equal(chronological[0].afterHash,contentHash('第一版',firstSegments));
  assert.equal(chronological[1].beforeHash,contentHash('第一版',before));assert.equal(chronological[1].afterHash,contentHash('第二版',secondSegments));
  assert.ok(chronological.every(item=>item.action==='write'&&item.authorship==='personal'));
});

test('restore-version snapshots preserve both branch parents',t=>{
  const store=isolated(t),first=store.save({kind:'journal',body:'根版本'}),firstVersion=store.versions({id:first.id})[0];
  const second=store.updateRecord({id:first.id,revision:first.revision,body:'后续版本'}),secondVersion=store.versions({id:first.id})[0];
  store.restoreVersion({id:first.id,versionId:firstVersion.id,revision:second.revision});
  const sync=store.mobileSync(),deviceId=randomUUID(),identity=sync.identity({protocolVersion:'1.0.0-draft.2',deviceId}),snapshot=sync.bootstrapBegin({libraryId:identity.libraryId,epoch:identity.epoch,deviceId}),versions=sync.bootstrapPage({snapshotId:snapshot.snapshotId,entityType:'versions'}).items;
  const restored=versions.find(item=>item.revision===3);assert.deepEqual(restored.parentVersionIds,[secondVersion.id,firstVersion.id]);
});

test('reconciliation maps source receipts, applies unknown re-envelopes and requires explicit discard or apply',t=>{
  const store=isolated(t),sync=store.mobileSync(),sourceDeviceId=randomUUID(),targetDeviceId=randomUUID(),sourceIdentity=sync.identity({protocolVersion:'1.0.0-draft.2',deviceId:sourceDeviceId});
  const makeOperation=(recordId,body)=>({operationId:randomUUID(),recordId,changeId:randomUUID(),versionId:randomUUID(),baseVersionId:null,parentVersionIds:[],originDeviceId:sourceDeviceId,action:'create',baseRevision:null,localGeneration:1,occurredAt:'2026-11-02T00:00:00.000Z',timeZone:'UTC',payload:{id:recordId,kind:'idea',title:body,markdown:body,origin:'personal',processing:'original',contentDay:null,dateBasis:'created',url:'',annotation:'',stage:'idea',sourceIds:[],sources:[{text:body,origin:'personal'}],attachmentDescriptors:[],createdAt:'2026-11-02T00:00:00.000Z',updatedAt:'2026-11-02T00:00:00.000Z',deleted:false,createdByDevice:sourceDeviceId},activities:[]});
  const applied=makeOperation(randomUUID(),'已确认变更'),unknown=makeOperation(randomUUID(),'待恢复变更');
  assert.equal(sync.push({libraryId:sourceIdentity.libraryId,epoch:sourceIdentity.epoch,deviceId:sourceDeviceId,operations:[{inlineBody:applied}]}).receipts[0].status,'applied');
  const backup=store.exportBackup();store.restoreBackup(backup);const targetIdentity=store.mobileSync().identity({protocolVersion:'1.0.0-draft.2',deviceId:targetDeviceId}),items=[{deviceId:sourceDeviceId,operation:applied},{deviceId:sourceDeviceId,operation:unknown}],manifestDigest=fingerprint(items),taskId=randomUUID();
  const task=store.mobileSync().reconcileBegin({taskId,mode:'coordinator-recovery',libraryId:targetIdentity.libraryId,sourceEpoch:sourceIdentity.epoch,targetEpoch:targetIdentity.epoch,sourceDeviceId,manifestDigest,operationCount:items.length,targetGeneration:targetIdentity.targetGeneration});
  assert.equal(store.mobileSync().reconcilePage({taskId,fencingToken:task.fencingToken,startOrdinal:0,items}).state,'ready');
  const receipts=store.mobileSync().reconcileReceipts({taskId,fencingToken:task.fencingToken,operationIds:[applied.operationId,unknown.operationId]}).receipts;
  assert.deepEqual(receipts.map(item=>item.status),['applied','unknown']);
  const replacement={...unknown,operationId:randomUUID(),localGeneration:2};
  const appliedUnknown=store.mobileSync().reconcileApply({taskId,fencingToken:task.fencingToken,resolutionId:randomUUID(),operationId:unknown.operationId,resolution:'push',operation:replacement,deviceId:targetDeviceId});
  assert.equal(appliedUnknown.status,'applied');assert.equal(store.get(unknown.recordId).body,'待恢复变更');
  assert.equal(store.mobileSync().reconcileComplete({taskId,fencingToken:task.fencingToken}).state,'completed');
});

test('full reconciliation stages a frozen manifest and merges a source-only branch without changing activity identity',t=>{
  const store=isolated(t),deviceId=randomUUID(),sync=store.mobileSync(),initial=sync.identity({protocolVersion:'1.0.0-draft.2',deviceId}),backup=store.exportBackup();
  const record=store.save({kind:'journal',title:'离线记录',body:'手机上写下的正文'}),attachmentId=store.attachmentAdd({record:record.id,name:'原件.txt',data:Buffer.from('raw branch bytes').toString('base64')}),sourceAttachment=JSON.parse(store.exportBackup()).payload.tables.attachments.find(item=>item.id===attachmentId),sourceIdentity=sync.identity({protocolVersion:'1.0.0-draft.2',deviceId}),snapshot=sync.bootstrapBegin({libraryId:sourceIdentity.libraryId,epoch:sourceIdentity.epoch,deviceId});
  const all={};for(const type of snapshot.manifest.entityTypes)all[type]=sync.bootstrapPage({snapshotId:snapshot.snapshotId,entityType:type}).items;
  const originalActivityIds=all.activities.map(item=>item.activityId);store.restoreBackup(backup);const target=store.mobileSync().identity({protocolVersion:'1.0.0-draft.2',deviceId}),operationDigest=fingerprint([]),sourceServerId=sourceIdentity.serverId,outerDigest=fingerprint({sourceServerId,sourceDeviceId:deviceId,sourceManifest:snapshot.manifest,operationCount:0,operationDigest}),taskId=randomUUID();
  const begun=store.mobileSync().reconcileBegin({taskId,mode:'coordinator-recovery',libraryId:target.libraryId,sourceEpoch:sourceIdentity.epoch,targetEpoch:target.epoch,sourceDeviceId:deviceId,sourceServerId,sourceManifest:snapshot.manifest,manifestDigest:outerDigest,operationCount:0,operationDigest,targetGeneration:target.targetGeneration});
  for(const type of snapshot.manifest.entityTypes)if(all[type].length)store.mobileSync().reconcilePage({taskId,fencingToken:begun.fencingToken,entityType:type,startOrdinal:0,items:all[type]});
  const attachment=all.attachments.find(item=>item.id===attachmentId),bytes=Buffer.from(sourceAttachment.data,'base64'),blobDigest=createHash('sha256').update(bytes).digest('hex');store.mobileSync().reconcileBlobStore({taskId,fencingToken:begun.fencingToken,attachmentId,bytes,digest:blobDigest});
  const progress=store.mobileSync().reconcileStatus({taskId,fencingToken:begun.fencingToken});assert.equal(progress.state,'ready');assert.equal(progress.candidateCount,1);assert.equal(progress.receivedCounts.records,1);
  const [candidate]=store.mobileSync().reconcileCandidates({taskId,fencingToken:begun.fencingToken,cursor:0,limit:10}).items;assert.equal(candidate.classification,'source-only');assert.equal(candidate.resolved,false);assert.equal(candidate.resolution,null);
  const branch=store.mobileSync().reconcileBranchRead({taskId,fencingToken:begun.fencingToken,branchId:candidate.branchId});assert.deepEqual(branch.activities.map(item=>item.activityId),originalActivityIds);
  const decided=store.mobileSync().reconcileDecide({taskId,fencingToken:begun.fencingToken,branchId:candidate.branchId,resolution:'use-branch',expectedTargetHead:null});assert.equal(decided.status,'merged');assert.equal(store.get(record.id).body,'手机上写下的正文');
  const resolvedCandidates=store.mobileSync().reconcileCandidates({taskId,fencingToken:begun.fencingToken,cursor:0,limit:10});assert.equal(resolvedCandidates.total,0);
  const mergedSnapshot=store.mobileSync().bootstrapBegin({libraryId:target.libraryId,epoch:store.mobileSync().identity({protocolVersion:'1.0.0-draft.2',deviceId}).epoch,deviceId}),mergedVersions=store.mobileSync().bootstrapPage({snapshotId:mergedSnapshot.snapshotId,entityType:'versions'}).items;assert.ok(mergedVersions.some(item=>item.id===branch.head.versionId));assert.deepEqual(mergedVersions.at(-1).parentVersionIds,[branch.head.versionId]);
  const finalSnapshot=store.mobileSync().bootstrapBegin({libraryId:target.libraryId,epoch:store.mobileSync().identity({protocolVersion:'1.0.0-draft.2',deviceId}).epoch,deviceId}),branches=store.mobileSync().bootstrapPage({snapshotId:finalSnapshot.snapshotId,entityType:'branches'}).items;assert.equal(branches[0].attachments[0].id,attachmentId);
  assert.equal(store.mobileSync().reconcileComplete({taskId,fencingToken:begun.fencingToken}).state,'completed');
  const secondSourceIdentity=store.mobileSync().identity({protocolVersion:'1.0.0-draft.2',deviceId}),secondSnapshot=store.mobileSync().bootstrapBegin({libraryId:secondSourceIdentity.libraryId,epoch:secondSourceIdentity.epoch,deviceId}),secondEntities={};
  for(const type of secondSnapshot.manifest.entityTypes)secondEntities[type]=store.mobileSync().bootstrapPage({snapshotId:secondSnapshot.snapshotId,entityType:type}).items;
  const targetBackup=JSON.parse(store.exportBackup());targetBackup.payload.tables.sync_branches=[];targetBackup.payload.tables.sync_branch_blobs=[];targetBackup.sha256=createHash('sha256').update(JSON.stringify(targetBackup.payload)).digest('hex');store.restoreBackup(JSON.stringify(targetBackup));
  const secondTarget=store.mobileSync().identity({protocolVersion:'1.0.0-draft.2',deviceId}),secondOperationDigest=fingerprint([]),secondTaskId=randomUUID(),secondOuterDigest=fingerprint({sourceServerId:secondSourceIdentity.serverId,sourceDeviceId:deviceId,sourceManifest:secondSnapshot.manifest,operationCount:0,operationDigest:secondOperationDigest}),secondBegin=store.mobileSync().reconcileBegin({taskId:secondTaskId,mode:'coordinator-recovery',libraryId:secondTarget.libraryId,sourceEpoch:secondSourceIdentity.epoch,targetEpoch:secondTarget.epoch,sourceDeviceId:deviceId,sourceServerId:secondSourceIdentity.serverId,sourceManifest:secondSnapshot.manifest,manifestDigest:secondOuterDigest,operationCount:0,operationDigest:secondOperationDigest,targetGeneration:secondTarget.targetGeneration});
  for(const type of secondSnapshot.manifest.entityTypes)if(secondEntities[type].length)store.mobileSync().reconcilePage({taskId:secondTaskId,fencingToken:secondBegin.fencingToken,entityType:type,startOrdinal:0,items:secondEntities[type]});
  for(const descriptor of secondEntities.attachments)store.mobileSync().reconcileBlobStore({taskId:secondTaskId,fencingToken:secondBegin.fencingToken,attachmentId:descriptor.id,branchId:descriptor.branchId??null,bytes:Buffer.from(sourceAttachment.data,'base64'),digest:descriptor.hash});
  assert.equal(store.mobileSync().reconcileStatus({taskId:secondTaskId,fencingToken:secondBegin.fencingToken}).candidateCount,0);
  assert.equal(store.mobileSync().reconcileComplete({taskId:secondTaskId,fencingToken:secondBegin.fencingToken}).state,'completed');
  const finalIdentity=store.mobileSync().identity({protocolVersion:'1.0.0-draft.2',deviceId}),finalManifest=store.mobileSync().bootstrapBegin({libraryId:finalIdentity.libraryId,epoch:finalIdentity.epoch,deviceId}),replicatedBranches=store.mobileSync().bootstrapPage({snapshotId:finalManifest.snapshotId,entityType:'branches'}).items;assert.equal(replicatedBranches.length,1);assert.equal(replicatedBranches[0].attachments[0].id,attachmentId);
});
