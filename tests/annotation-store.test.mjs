import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {createStore} from '../plugins/library/legacy/store.mjs';
import Database from '../plugins/library/legacy/sqlite.mjs';
import {fingerprint} from '../plugins/library/src/sync/canonical.mjs';
import {createMobileSyncAdapter} from '../plugins/mobile/src/sync-adapter.mjs';
import {protocolVersion,record,version} from '../contracts/mobile/v1/schema.mjs';
function isolated(t){const dir=mkdtempSync(join(tmpdir(),'shiwen-annotation-'));const s=createStore(join(dir,'library.sqlite'));t.after(()=>{s.close();rmSync(dir,{recursive:true,force:true});});return s;}
test('annotation anchors original version, preserves independent deletion, and survives backup',t=>{
 const s=isolated(t),original=s.save({kind:'freewrite',body:'原文'}),anchor=s.originalVersionInfo({id:original.id});
 assert.equal(anchor.contentHash,createHash('sha256').update('原文').digest('hex'));
 const args={originalId:original.id,originalVersionId:anchor.versionId,originalContentHash:anchor.contentHash,body:'批注',requestId:'create'};
 const a=s.annotationCreate(args);assert.deepEqual(s.annotationCreate(args),a);assert.throws(()=>s.annotationCreate({...args,body:'其他'}));
 assert.deepEqual(a.annotationOf,{recordId:original.id,versionId:anchor.versionId,contentHash:anchor.contentHash});
 const edited=s.updateRecord({id:original.id,revision:original.revision,body:'修改后的原文'});assert.deepEqual(s.annotationRead({id:a.id}).annotationOf,a.annotationOf);
 assert.throws(()=>s.save({id:a.id,revision:a.revision,body:'越权'}));assert.throws(()=>s.remove({id:a.id,revision:a.revision}));
 assert.equal(s.snapshot().records.some(r=>r.id===a.id),false);assert.equal(s.searchRecords({query:'批注'}).total,0);
 const removed=s.annotationDelete({id:a.id,revision:a.revision,requestId:'delete'});s.remove({id:original.id,revision:edited.revision});assert.deepEqual(s.annotationList({originalId:original.id}),[]);
 s.restoreRemoved({id:original.id,revision:edited.revision+1});assert.deepEqual(s.annotationList({originalId:original.id}),[]);
 const restored=s.annotationRestore({id:a.id,revision:removed.revision,requestId:'restore'});assert.equal(restored.deleted,0);
 const backup=s.exportBackup(),target=isolated(t);target.restoreBackup(backup);assert.deepEqual(target.annotationRead({id:a.id}).annotationOf,a.annotationOf);
});
test('bootstrap and changes carry annotation relation and reject old protocol',t=>{
 const s=isolated(t),o=s.save({kind:'freewrite',body:'原文'}),anchor=s.originalVersionInfo({id:o.id}),a=s.annotationCreate({originalId:o.id,originalVersionId:anchor.versionId,body:'批注',requestId:'create'});
 const sync=s.mobileSync(),deviceId=randomUUID();assert.throws(()=>sync.identity({protocolVersion:'1.0.0-draft.2',deviceId}),/PROTOCOL_UNSUPPORTED/);const identity=sync.identity({protocolVersion,deviceId});
 const begin=sync.bootstrapBegin({libraryId:identity.libraryId,epoch:identity.epoch,deviceId});const records=sync.bootstrapPage({snapshotId:begin.snapshotId,entityType:'records'}).items,versions=sync.bootstrapPage({snapshotId:begin.snapshotId,entityType:'versions'}).items;
 const ar=records.find(r=>r.id===a.id),av=versions.find(v=>v.recordId===a.id);assert.deepEqual(ar.annotationOf,a.annotationOf);assert.deepEqual(av.annotationOf,a.annotationOf);record.parse(ar);version.parse(av);
 const event=sync.changes({libraryId:identity.libraryId,epoch:identity.epoch,deviceId,cursor:0}).events.find(e=>e.recordId===a.id);assert.deepEqual(event.record.annotationOf,a.annotationOf);assert.deepEqual(event.version.annotationOf,a.annotationOf);
});
test('setup recovery restores annotation anchors and all historical versions',t=>{
 const source=isolated(t),target=isolated(t),o=source.save({kind:'freewrite',body:'原稿'}),anchor=source.originalVersionInfo({id:o.id}),a=source.annotationCreate({originalId:o.id,originalVersionId:anchor.versionId,body:'批注',requestId:'create'});
 source.updateRecord({id:o.id,revision:o.revision,body:'新版'});
 const ss=source.mobileSync(),ts=target.mobileSync(),deviceId=randomUUID(),si=ss.identity({protocolVersion,deviceId}),ti=ts.identity({protocolVersion,deviceId}),snapshot=ss.bootstrapBegin({libraryId:si.libraryId,epoch:si.epoch,deviceId}),setupId=randomUUID();
 const start=ts.setupBegin({setupId,mode:'initialize',libraryId:si.libraryId,sourceEpoch:si.epoch,manifestDigest:snapshot.manifest.manifestDigest,manifest:snapshot.manifest,expectedLibraryId:ti.libraryId,expectedEpoch:ti.epoch,targetGeneration:ti.targetGeneration});
 for(const entityType of snapshot.manifest.entityTypes){const page=ss.bootstrapPage({snapshotId:snapshot.snapshotId,entityType});if(page.items.length)ts.setupPage({setupId,fencingToken:start.fencingToken,entityType,startOrdinal:0,items:page.items});}
 ts.setupCommit({setupId,fencingToken:start.fencingToken});assert.deepEqual(target.annotationRead({id:a.id}).annotationOf,a.annotationOf);assert.ok(target.versions({id:o.id}).some(v=>v.id===anchor.versionId));
});
test('preview counts whole personal documents by content date and leaves correction outside writing',t=>{
 const s=isolated(t);const item=s.saveDsh({kind:'reference',body:'甲 乙 ![图](attachment:12345678-1234-4234-8234-123456789abc)',origin:'personal',day:'2026-11-01',sessionId:'s',messageId:'m',role:'user',operationId:'dsh'});
 const historical=s.reviewPreview({period:'month',month:'2026-11',now:'2026-11-09T00:00:00Z'});assert.equal(historical.personalOriginalCharacters,2);
 assert.throws(()=>s.updateRecord({id:item.id,revision:item.revision,origin:'external'}));
 const corrected=s.correctRecordOrigin({id:item.id,revision:item.revision,origin:'external',requestId:'correct'});assert.equal(corrected.origin,'external');
 const after=s.reviewPreview({period:'month',month:'2026-11',now:'2026-11-09T00:00:00Z'});assert.equal(after.personalOriginalCharacters,0);assert.deepEqual(after.observedEdits,historical.observedEdits);
});
test('mobile annotation push waits for anchor and enforces immutable relation',t=>{
 const s=isolated(t),o=s.save({kind:'freewrite',body:'原文'}),anchor=s.originalVersionInfo({id:o.id}),sync=s.mobileSync(),deviceId=randomUUID(),identity=sync.identity({protocolVersion,deviceId}),id=randomUUID(),operationId=randomUUID(),versionId=randomUUID(),changeId=randomUUID(),at=new Date().toISOString();
 const payload={id,kind:'ai_annotation',annotationOf:{recordId:o.id,versionId:randomUUID(),contentHash:anchor.contentHash},title:'批注',markdown:'建议',origin:'ai',processing:'unknown',contentDay:null,dateBasis:'created',url:'',annotation:'',stage:'draft',sourceIds:[],sources:[{text:'建议',origin:'ai'}],attachmentDescriptors:[],createdAt:at,updatedAt:at,deleted:false,createdByDevice:deviceId};
 const op={operationId,recordId:id,changeId,versionId,baseVersionId:null,parentVersionIds:[],originDeviceId:deviceId,action:'create',baseRevision:null,localGeneration:1,occurredAt:at,timeZone:'Asia/Shanghai',payload,activities:[]},request={libraryId:identity.libraryId,epoch:identity.epoch,deviceId,operations:[{inlineBody:op}]};
 assert.equal(sync.push(request).receipts[0].status,'blocked-dependency');payload.annotationOf.versionId=anchor.versionId;const created=sync.push(request).receipts[0];assert.equal(created.status,'applied');assert.deepEqual(s.annotationRead({id}).annotationOf,payload.annotationOf);
 const update={...op,operationId:randomUUID(),changeId:randomUUID(),versionId:randomUUID(),baseVersionId:versionId,parentVersionIds:[versionId],action:'update',baseRevision:created.revision,payload:{...payload,annotationOf:{...payload.annotationOf,contentHash:'a'.repeat(64)}}};assert.throws(()=>sync.push({...request,operations:[{inlineBody:update}]}),/VALIDATION_ERROR/);
});
test('annotation staged images are atomic and retries do not consume twice',t=>{
 const s=isolated(t),o=s.save({kind:'freewrite',body:'正文'}),anchor=s.originalVersionInfo({id:o.id}),data=Buffer.from('89504e470d0a1a0a00010203','hex').toString('base64'),image=s.stageWorkbenchImage({name:'a.png',data}),args={originalId:o.id,originalVersionId:anchor.versionId,body:`![图](attachment:${image.id})`,imageIds:[image.id],requestId:'image-create'};
 const a=s.annotationCreate(args);assert.equal(s.attachments({record:a.id}).length,1);assert.equal(s.annotationCreate(args).id,a.id);
 const missing=randomUUID();assert.throws(()=>s.annotationUpdate({id:a.id,revision:a.revision,body:`![图](attachment:${missing})`,imageIds:[missing],requestId:'bad-image'}));assert.equal(s.annotationRead({id:a.id}).revision,a.revision);
});

test('adapter requires compatible handshake before any incremental request',async t=>{
 const s=isolated(t),deviceId=randomUUID(),adapter=createMobileSyncAdapter({ctx:{connection:{browserPeer:{id:'owner'}}},library:s});t.after(()=>adapter.close());const identity=s.mobileSync().identity({protocolVersion,deviceId});
 const request={libraryId:identity.libraryId,epoch:identity.epoch,deviceId,cursor:0};await assert.rejects(adapter.execute('changes',request),/PROTOCOL_UNSUPPORTED/);assert.throws(()=>adapter.identity({protocolVersion:'1.0.0-draft.2',deviceId}),/PROTOCOL_UNSUPPORTED/);await assert.rejects(adapter.execute('changes',request),/PROTOCOL_UNSUPPORTED/);adapter.identity({protocolVersion,deviceId});assert.ok((await adapter.execute('changes',request)).events);
});

test('reconciliation merges parent before annotation and retains immutable anchor',t=>{
 const s=isolated(t),sync=s.mobileSync(),deviceId=randomUUID(),empty=s.exportBackup(),original=s.save({kind:'freewrite',body:'旧原稿'}),anchor=s.originalVersionInfo({id:original.id}),child=s.annotationCreate({originalId:original.id,originalVersionId:anchor.versionId,body:'批注',requestId:'create'});s.updateRecord({id:original.id,revision:original.revision,body:'新原稿'});
 const sourcePreview=s.reviewPreview({period:'1'}),source=sync.identity({protocolVersion,deviceId}),snapshot=sync.bootstrapBegin({libraryId:source.libraryId,epoch:source.epoch,deviceId}),all={};for(const type of snapshot.manifest.entityTypes)all[type]=sync.bootstrapPage({snapshotId:snapshot.snapshotId,entityType:type}).items;
 s.restoreBackup(empty);const target=sync.identity({protocolVersion,deviceId}),operationDigest=fingerprint([]),taskId=randomUUID(),manifestDigest=fingerprint({sourceServerId:source.serverId,sourceDeviceId:deviceId,sourceManifest:snapshot.manifest,operationCount:0,operationDigest});
 const begin=sync.reconcileBegin({taskId,mode:'coordinator-recovery',libraryId:target.libraryId,sourceEpoch:source.epoch,targetEpoch:target.epoch,sourceDeviceId:deviceId,sourceServerId:source.serverId,sourceManifest:snapshot.manifest,manifestDigest,operationCount:0,operationDigest,targetGeneration:target.targetGeneration});
 for(const type of snapshot.manifest.entityTypes)if(all[type].length)sync.reconcilePage({taskId,fencingToken:begin.fencingToken,entityType:type,startOrdinal:0,items:all[type]});
 const args={taskId,fencingToken:begin.fencingToken},candidates=sync.reconcileCandidates({...args,cursor:0,limit:10}).items,childBranch=candidates.find(x=>x.recordId===child.id),originalBranch=candidates.find(x=>x.recordId===original.id);assert.throws(()=>sync.reconcileDecide({...args,branchId:childBranch.branchId,resolution:'use-branch',expectedTargetHead:null}),/DEPENDENCY_MISSING/);
 sync.reconcileDecide({...args,branchId:originalBranch.branchId,resolution:'use-branch',expectedTargetHead:null});sync.reconcileDecide({...args,branchId:childBranch.branchId,resolution:'use-branch',expectedTargetHead:null});assert.equal(s.get(original.id).body,'新原稿');assert.equal(s.get(child.id).origin,'ai');assert.deepEqual(s.annotationRead({id:child.id}).annotationOf,child.annotationOf);assert.ok(s.versions({id:original.id}).some(v=>v.id===anchor.versionId));assert.equal(sync.reconcileComplete(args).state,'completed');assert.deepEqual(s.reviewPreview({period:'1'}).observedEdits,sourcePreview.observedEdits);
});
test('invalid backup relation is rejected before replacing target data',t=>{
 const source=isolated(t),target=isolated(t),o=source.save({kind:'freewrite',body:'原稿'}),anchor=source.originalVersionInfo({id:o.id});source.annotationCreate({originalId:o.id,originalVersionId:anchor.versionId,body:'批注',requestId:'create'});const existing=target.save({kind:'idea',body:'保留'});
 const backup=JSON.parse(source.exportBackup());backup.payload.tables.annotation_relations[0].content_hash='a'.repeat(64);backup.sha256=createHash('sha256').update(JSON.stringify(backup.payload)).digest('hex');assert.throws(()=>target.restoreBackup(JSON.stringify(backup)),/批注关联/);assert.equal(target.get(existing.id).body,'保留');
});
test('reconciliation refuses a branch that changes annotation authorship',t=>{
 const s=isolated(t),sync=s.mobileSync(),deviceId=randomUUID(),o=s.save({kind:'freewrite',body:'原稿'}),anchor=s.originalVersionInfo({id:o.id}),a=s.annotationCreate({originalId:o.id,originalVersionId:anchor.versionId,body:'一版',requestId:'create'}),backup=s.exportBackup();
 s.annotationUpdate({id:a.id,revision:a.revision,body:'离线版',requestId:'update'});const source=sync.identity({protocolVersion,deviceId}),snapshot=sync.bootstrapBegin({libraryId:source.libraryId,epoch:source.epoch,deviceId}),all={};for(const type of snapshot.manifest.entityTypes)all[type]=sync.bootstrapPage({snapshotId:snapshot.snapshotId,entityType:type}).items;
 all.records.find(row=>row.id===a.id).origin='personal';const manifest={...snapshot.manifest,entityDigests:{...snapshot.manifest.entityDigests,records:fingerprint(all.records)}};delete manifest.manifestDigest;manifest.manifestDigest=fingerprint(manifest);
 s.restoreBackup(backup);const target=sync.identity({protocolVersion,deviceId}),operationDigest=fingerprint([]),taskId=randomUUID(),manifestDigest=fingerprint({sourceServerId:source.serverId,sourceDeviceId:deviceId,sourceManifest:manifest,operationCount:0,operationDigest}),begin=sync.reconcileBegin({taskId,mode:'coordinator-recovery',libraryId:target.libraryId,sourceEpoch:source.epoch,targetEpoch:target.epoch,sourceDeviceId:deviceId,sourceServerId:source.serverId,sourceManifest:manifest,manifestDigest,operationCount:0,operationDigest,targetGeneration:target.targetGeneration});
 for(const type of manifest.entityTypes)if(all[type].length)sync.reconcilePage({taskId,fencingToken:begin.fencingToken,entityType:type,startOrdinal:0,items:all[type]});const args={taskId,fencingToken:begin.fencingToken},candidate=sync.reconcileCandidates({...args,cursor:0,limit:10}).items.find(item=>item.recordId===a.id);assert.throws(()=>sync.reconcileDecide({...args,branchId:candidate.branchId,resolution:'use-branch',expectedTargetHead:candidate.targetHead}),/VALIDATION_ERROR/);assert.equal(s.annotationRead({id:a.id}).origin,'ai');assert.equal(s.annotationRead({id:a.id}).body,'一版');
});

test('opening an incomplete annotation graph is rejected',t=>{
 const dir=mkdtempSync(join(tmpdir(),'shiwen-incomplete-')),path=join(dir,'library.sqlite');t.after(()=>rmSync(dir,{recursive:true,force:true}));const s=createStore(path),o=s.save({kind:'freewrite',body:'原稿'}),anchor=s.originalVersionInfo({id:o.id});s.annotationCreate({originalId:o.id,originalVersionId:anchor.versionId,body:'批注',requestId:'create'});s.close();const db=new Database(path);db.prepare('DELETE FROM annotation_relations').run();db.close();assert.throws(()=>createStore(path),/批注关联不完整/);
});
test('merged offline journal preserves original version and canonicalizes annotation anchor',t=>{
 const s=isolated(t),sync=s.mobileSync(),deviceId=randomUUID(),identity=sync.identity({protocolVersion,deviceId}),day=new Date().toISOString().slice(0,10),desktop=s.save({kind:'journal',day,body:'桌面'}),localId=randomUUID(),sourceVersion=randomUUID(),at=new Date().toISOString(),sources=[{text:'离线原稿',origin:'personal'}];
 const payload={id:localId,kind:'journal',title:'离线',markdown:'离线原稿',origin:'personal',processing:'unknown',contentDay:day,dateBasis:'created',url:'',annotation:'',stage:'draft',sourceIds:[],sources,attachmentDescriptors:[],createdAt:at,updatedAt:at,deleted:false,createdByDevice:deviceId},op={operationId:randomUUID(),recordId:localId,changeId:randomUUID(),versionId:sourceVersion,baseVersionId:null,parentVersionIds:[],originDeviceId:deviceId,action:'create',baseRevision:null,localGeneration:1,occurredAt:at,timeZone:'UTC',payload,activities:[]},base={libraryId:identity.libraryId,epoch:identity.epoch,deviceId},push=op=>sync.push({...base,operations:[{inlineBody:op}]}).receipts[0],receipt=push(op);
 assert.equal(receipt.status,'applied');assert.equal(receipt.recordId,desktop.id);assert.notEqual(receipt.versionId,sourceVersion);assert.equal(receipt.inputVersionId,sourceVersion);const replay=push({...op,operationId:randomUUID()});assert.equal(replay.duplicateChange,true);assert.equal(replay.journalMerged,true);assert.equal(replay.currentVersion.id,receipt.versionId);const source=s.versions({id:desktop.id}).find(v=>v.id===sourceVersion);assert.equal(source.doc.content[0].content[0].text,'离线原稿');
 const childId=randomUUID(),annotationOf={recordId:localId,versionId:sourceVersion,contentHash:createHash('sha256').update('离线原稿').digest('hex')},childPayload={...payload,id:childId,kind:'ai_annotation',origin:'ai',annotationOf,title:'批注',markdown:'建议',sources:[{text:'建议',origin:'ai'}],contentDay:null};const child={...op,operationId:randomUUID(),recordId:childId,changeId:randomUUID(),versionId:randomUUID(),payload:childPayload};const target=isolated(t),targetSync=target.mobileSync(),targetIdentity=targetSync.identity({protocolVersion,deviceId}),snapshot=sync.bootstrapBegin({...base}),setupId=randomUUID(),started=targetSync.setupBegin({setupId,mode:'initialize',libraryId:identity.libraryId,sourceEpoch:identity.epoch,manifestDigest:snapshot.manifest.manifestDigest,manifest:snapshot.manifest,expectedLibraryId:targetIdentity.libraryId,expectedEpoch:targetIdentity.epoch,targetGeneration:targetIdentity.targetGeneration});for(const entityType of snapshot.manifest.entityTypes){const page=sync.bootstrapPage({snapshotId:snapshot.snapshotId,entityType});if(page.items.length)targetSync.setupPage({setupId,fencingToken:started.fencingToken,entityType,startOrdinal:0,items:page.items});}targetSync.setupCommit({setupId,fencingToken:started.fencingToken});const recoveredIdentity=targetSync.identity({protocolVersion,deviceId});const recovered=targetSync.push({libraryId:recoveredIdentity.libraryId,epoch:recoveredIdentity.epoch,deviceId,operations:[{inlineBody:child}]}).receipts[0];assert.equal(recovered.status,'applied');assert.equal(recovered.currentRecord.annotationOf.recordId,desktop.id);assert.equal(target.versions({id:desktop.id}).find(v=>v.id===sourceVersion).doc.content[0].content[0].text,'离线原稿');
 const childReceipt=push(child);assert.equal(childReceipt.status,'applied');assert.equal(childReceipt.currentRecord.annotationOf.recordId,desktop.id);assert.deepEqual(s.annotationRead({id:childId}).annotationOf,{...annotationOf,recordId:desktop.id});assert.deepEqual(push(child),childReceipt);
 const backup=s.exportBackup();s.restoreBackup(backup);const newIdentity=sync.identity({protocolVersion,deviceId}),retry={...op,operationId:randomUUID()},items=[{deviceId,operation:retry}],taskId2=randomUUID(),task=sync.reconcileBegin({taskId:taskId2,mode:'coordinator-recovery',libraryId:newIdentity.libraryId,sourceEpoch:identity.epoch,targetEpoch:newIdentity.epoch,sourceDeviceId:deviceId,manifestDigest:fingerprint(items),operationCount:1,targetGeneration:newIdentity.targetGeneration});sync.reconcilePage({taskId:taskId2,fencingToken:task.fencingToken,startOrdinal:0,items});const mapped=sync.reconcileReceipts({taskId:taskId2,fencingToken:task.fencingToken,operationIds:[retry.operationId]}).receipts[0];assert.equal(mapped.status,'applied');assert.equal(mapped.result.journalMerged,true);assert.equal(mapped.result.inputVersionId,sourceVersion);assert.equal(mapped.result.currentRecord.id,desktop.id);assert.equal(mapped.result.currentVersion.id,receipt.versionId);assert.equal(mapped.result.currentVersion.journalInput.id,localId);
});

test('preview resolves mixed provenance write deltas by hashes and ignores correction',t=>{
 const s=isolated(t),original=s.save({kind:'freewrite',body:'甲'}),ai=s.updateRecord({id:original.id,revision:original.revision,body:'甲乙'},{addedOrigin:'ai'}),personal=s.updateRecord({id:original.id,revision:ai.revision,body:'甲乙丙'}),before=s.reviewPreview({period:'1'});assert.deepEqual(before.observedEdits,{added:2,removed:0,net:2});
 s.correctRecordOrigin({id:original.id,revision:personal.revision,origin:'external',requestId:'correction'});assert.deepEqual(s.reviewPreview({period:'1'}).observedEdits,before.observedEdits);
});

test('original review totals, daily trend and detail include MCP personal records without inventing edits',t=>{
 const s=isolated(t),args={period:'month',month:'2026-11',now:'2026-11-09T08:00:00Z',timeZone:'Asia/Shanghai'};
 const archive=(kind,body,origin,day,id)=>s.saveDsh({kind,body,origin,day,sessionId:'review',messageId:id,role:'user',operationId:id});
 const own=archive('freewrite','个人原文','personal','2026-11-09','own');
 archive('reference','我的参考','personal','2026-11-08','reference');
 archive('article','我的文章','personal','2026-11-09','article');
 archive('reference','外部资料','external','2026-11-09','external');
 archive('freewrite','未定日期','personal',null,'undated');
 const removed=archive('idea','已删除','personal','2026-11-09','deleted');s.remove({id:removed.id,revision:removed.revision});
 const anchor=s.originalVersionInfo({id:own.id});s.annotationCreate({originalId:own.id,originalVersionId:anchor.versionId,body:'AI 分析不计入个人原文',requestId:'note'});
 const report=s.reviewPreview(args);assert.equal(report.personalOriginalCharacters,12);assert.equal(report.records.length,3);
 assert.equal(report.records.reduce((n,r)=>n+r.characters,0),12);assert.equal(report.daily.reduce((n,r)=>n+r.personalOriginalCharacters,0),12);
 assert.equal(report.daily.find(r=>r.day==='2026-11-09').personalOriginalCharacters,8);assert.equal(report.daily.find(r=>r.day==='2026-11-08').personalOriginalCharacters,4);
 assert.deepEqual(report.observedEdits,{added:0,removed:0,net:0});
 assert.equal(s.reviewPreview({...args,period:'1'}).personalOriginalCharacters,8);
});
