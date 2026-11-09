import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {createStore} from '../plugins/library/legacy/store.mjs';
import Database from '../plugins/library/legacy/sqlite.mjs';
import {markdownSource} from '../plugins/library/legacy/markdown.mjs';
import {readDoc,dateKey} from '../plugins/library/legacy/content.mjs';
import {contentHash} from '../plugins/library/src/sync/canonical.mjs';
import {createMobileSyncAdapter} from '../plugins/mobile/src/sync-adapter.mjs';
import {apply as workbench} from '../plugins/workbench/src/index.mjs';

function fixture(t){
  const dir=mkdtempSync(join(tmpdir(),'shiwen-daily-')),path=join(dir,'library.sqlite'),store=createStore(path);
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  const issued=store.externalClientCreate({name:'journal test',scopes:['create','read','update']}),client=store.externalAuthenticate(issued.token);
  const external=(body,day,extra={})=>store.externalCall(client,'shiwen_save',{requestId:randomUUID(),kind:'journal',origin:'personal',body,...(day===undefined?{}:{day}),...extra});
  const sync=store.mobileSync(),deviceId=randomUUID(),identity=sync.identity({protocolVersion:'1.0.0-draft.3',deviceId});
  const push=op=>sync.push({libraryId:identity.libraryId,epoch:identity.epoch,deviceId,operations:[{inlineBody:op}]}).receipts[0];
  return {store,path,client,external,sync,push,identity,deviceId};
}
function operation(deviceId,markdown,{id=randomUUID(),day='2026-11-08',base=null,origin='personal',descriptors=[]}={}){
  const at='2026-11-08T12:00:00.000Z',changeId=randomUUID(),sources=[{text:markdown,origin}];
  const payload={id,kind:'journal',title:'手机日记',markdown,origin,processing:'original',contentDay:day,dateBasis:'用户确认',url:'',annotation:'',stage:'draft',sourceIds:[],sources,attachmentDescriptors:descriptors,createdAt:at,updatedAt:at,deleted:false,createdByDevice:deviceId};
  return {operationId:randomUUID(),recordId:id,changeId,versionId:randomUUID(),baseVersionId:base?.versionId??null,parentVersionIds:base?[base.versionId]:[],originDeviceId:deviceId,action:base?'update':'create',baseRevision:base?.revision??null,localGeneration:base?2:1,occurredAt:at,timeZone:'Asia/Shanghai',payload,
    activities:[{activityId:randomUUID(),recordId:id,changeId,originDeviceId:deviceId,occurredAt:at,timeZone:'Asia/Shanghai',beforeHash:contentHash('',[]),afterHash:contentHash(markdown,sources),afterSegments:sources,action:'write',authorship:origin}]};
}

test('MCP and direct saves append to one dated diary; retry, editing and other kinds keep their semantics',t=>{
  const {store,client,external}=fixture(t),day=dateKey(new Date());
  const first=store.save({kind:'journal',body:'早晨'});
  const requestId=randomUUID(),second=external('晚上',undefined,{requestId,origin:'ai'});
  assert.equal(second.id,first.id);assert.equal(second.day,day);
  assert.equal(markdownSource(store.get(first.id).doc),'早晨\n\n晚上');
  assert.deepEqual(store.externalCall(client,'shiwen_save',{requestId,kind:'journal',origin:'ai',body:'晚上'}),second);
  assert.equal(readDoc(store.get(first.id).doc).groups.personal,'早晨');assert.equal(readDoc(store.get(first.id).doc).groups.ai,'晚上');
  assert.throws(()=>store.save({kind:'journal',body:' '}),/先写/);
  const edited=store.updateRecord({id:first.id,revision:second.revision,body:'修改后的全文'});
  assert.equal(markdownSource(edited.doc),'修改后的全文');
  const yesterday=external('补记','2026-10-01');assert.notEqual(yesterday.id,first.id);
  assert.throws(()=>store.updateRecord({id:yesterday.id,revision:yesterday.revision,day}),/已有日记/);
  store.save({kind:'idea',body:'同日灵感一'});store.save({kind:'idea',body:'同日灵感二'});
  assert.equal(store.searchRecords({kind:'idea'}).total,2);assert.equal(store.searchRecords({kind:'journal'}).total,2);
  const changes=JSON.parse(store.exportBackup()).payload.tables.sync_changes.map(x=>JSON.parse(x.payload));
  assert.ok(changes.filter(x=>x.id===first.id).every(x=>x.contentDay===day));
});

test('offline mobile create and subsequent appends merge with MCP diary exactly once, including images',t=>{
  const {store,sync,push,identity,deviceId,external}=fixture(t),day='2026-11-08';
  const desktop=external('电脑记录',day),id=randomUUID(),image=randomUUID(),bytes=Buffer.from('89504e470d0a1a0a','hex'),digest=createHash('sha256').update(bytes).digest('hex');
  sync.putAttachment({libraryId:identity.libraryId,epoch:identity.epoch,deviceId,recordId:id,attachmentId:image,name:'photo.png',bytes,digest});
  const first=operation(deviceId,`手机第一段\n![照片](attachment:${image})`,{id,day,descriptors:[{id:image,hash:digest,byteLength:bytes.length,name:'photo.png'}]}),accepted=push(first);
  assert.equal(accepted.status,'applied');assert.equal(accepted.journalMerged,true);assert.equal(accepted.recordId,desktop.id);
  assert.equal(store.get(id),null);assert.equal(store.attachment({id:image}).record,desktop.id);
  assert.deepEqual(push(first),accepted);
  external('MCP 又追加一段',day);
  const second=operation(deviceId,first.payload.markdown+'\n\n手机第二段',{id:desktop.id,day,base:accepted,descriptors:first.payload.attachmentDescriptors});
  const result=push(second);assert.equal(result.status,'applied');assert.deepEqual(push(second),result);
  assert.equal(store.searchRecords({kind:'journal'}).total,1);
  assert.equal(result.currentRecord.markdown,`电脑记录\n\n${first.payload.markdown}\n\nMCP 又追加一段\n\n手机第二段`);
  const versions=store.versions({id:desktop.id});assert.equal(versions.length,6);
  assert.equal(markdownSource(versions.find(v=>v.id===first.versionId).doc),first.payload.markdown);
  assert.equal(markdownSource(versions.find(v=>v.id===second.versionId).doc),second.payload.markdown);
  assert.notEqual(accepted.versionId,first.versionId);
  // A concurrent replacement edit must remain a conflict, never erase the merged diary.
  const edit=operation(deviceId,'覆盖全文',{id:desktop.id,day,base:accepted});
  assert.equal(push(edit).status,'conflict');assert.equal(markdownSource(store.get(desktop.id).doc),result.currentRecord.markdown);
  // A phone which has already adopted the merged head appends against that
  // head, while another MCP append can still arrive before its next sync.
  external('电脑继续写',day);
  const afterPull=operation(deviceId,result.currentRecord.markdown+'\n\n手机已同步后追加',{id:desktop.id,day,base:result,descriptors:first.payload.attachmentDescriptors});
  for(const field of ['title','origin','processing','url','annotation','stage'])afterPull.payload[field]=result.currentRecord[field];
  const third=push(afterPull);assert.equal(third.status,'applied');
  assert.equal(third.currentRecord.markdown,result.currentRecord.markdown+'\n\n电脑继续写\n\n手机已同步后追加');
});

test('diary merge validates attachments and activity hashes before committing',t=>{
  const {store,push,deviceId,external}=fixture(t),day='2026-11-08',row=external('原文',day);
  const bad=operation(deviceId,'新内容',{day});bad.activities[0].afterHash='0'.repeat(64);
  assert.throws(()=>push(bad),/VALIDATION_ERROR/);
  const missing=operation(deviceId,'图片',{day,descriptors:[{id:randomUUID(),hash:'a'.repeat(64),byteLength:10,name:'missing.png'}]});
  assert.equal(push(missing).status,'blocked-dependency');assert.equal(store.get(row.id).revision,row.revision);
});

test('legacy duplicate journals consolidate without losing original versions or attachment bytes',t=>{
  const {store,path}=fixture(t),day='2026-11-08';
  const a=store.save({kind:'journal',day,body:'第一篇'}),b=store.save({kind:'reference',body:'第二篇'});
  const image=store.attachmentAdd({record:b.id,name:'original.png',data:Buffer.from('original bytes').toString('base64')});
  store.updateRecord({id:b.id,revision:store.get(b.id).revision,body:`第二篇\n![图](attachment:${image})`});
  const db=new Database(path);db.prepare("UPDATE records SET kind='journal',created='2026-11-08T00:00:00Z' WHERE id=?").run(b.id);db.prepare("UPDATE records SET created='2026-11-09T00:00:00Z' WHERE id=?").run(a.id);db.prepare('INSERT INTO record_dates VALUES(?,?,?)').run(b.id,day,'旧版本');db.close();
  assert.equal(store.consolidateJournals(),1);assert.equal(store.consolidateJournals(),0);
  const active=store.searchRecords({kind:'journal'});assert.equal(active.total,1);
  const kept=store.get(active.items[0].id),removed=store.get(kept.id===a.id?b.id:a.id);
  assert.ok(removed.deleted);assert.ok(store.versions({id:removed.id}).length);
  assert.match(markdownSource(kept.doc),/第一篇/);assert.match(markdownSource(kept.doc),/第二篇/);
  const imageId=/attachment:([^)]*)/.exec(markdownSource(kept.doc))[1];assert.equal(store.attachment({id:imageId}).data,Buffer.from('original bytes').toString('base64'));
  assert.notEqual(imageId,image);assert.equal(store.attachment({id:image}).record,removed.id);
  assert.throws(()=>store.restoreRemoved({id:removed.id,revision:removed.revision}),/已有日记/);
});

test('diary append baseline survives a backup restore and midnight uses the sender timezone',t=>{
  const {store,sync,push,deviceId,identity}=fixture(t),first=operation(deviceId,'第一段',{day:null});
  first.occurredAt='2026-11-08T16:30:00.000Z';
  const accepted=push(first);assert.equal(accepted.currentRecord.contentDay,'2026-11-09');
  const backup=store.exportBackup();store.restoreBackup(backup);
  const renewed=sync.identity({protocolVersion:'1.0.0-draft.3',deviceId});assert.notEqual(identity.epoch,renewed.epoch);
  const second=operation(deviceId,'第一段\n\n第二段',{id:accepted.recordId,day:null,base:accepted});second.occurredAt=first.occurredAt;
  const result=sync.push({libraryId:renewed.libraryId,epoch:renewed.epoch,deviceId,operations:[{inlineBody:second}]}).receipts[0];
  assert.equal(result.status,'applied');assert.equal(result.currentRecord.markdown,'第一段\n\n第二段');
});

test('browser homepage requests without images are also idempotent',async t=>{
  const {store}=fixture(t);let route;
  workbench({shiwenLibrary:store,effect:fn=>fn(),connection:{fetch:{register:value=>{route=value;return()=>{};}}}});
  const requestId=randomUUID(),args={kind:'journal',body:'首页保存',requestId};
  const call=async input=>{const response=await route.fetch(new Request('http://localhost/api/shiwen',{method:'POST',body:JSON.stringify({method:'saveMarkdown',args:input})}));return {status:response.status,...await response.json()};};
  const first=await call(args),again=await call(args);assert.equal(first.status,200);assert.deepEqual(again,first);
  assert.equal(store.searchRecords({kind:'journal'}).total,1);assert.equal(markdownSource(store.get(first.result.id).doc),'首页保存');
  assert.equal((await call({...args,body:'不同内容'})).status,400);
});

test('large diary receipts remain chunked when querying a lost acknowledgement',async t=>{
  const {store,path,deviceId}=fixture(t);store.paths={library:join(path,'..')};
  const adapter=createMobileSyncAdapter({ctx:{connection:{browserPeer:{id:'owner'}}},library:store});t.after(()=>adapter.close());
  const identity=adapter.identity({protocolVersion:'1.0.0-draft.3',deviceId}),base={libraryId:identity.libraryId,epoch:identity.epoch,deviceId};
  const op=operation(deviceId,'中'.repeat(200000));
  const first=(await adapter.execute('push',{...base,operations:[{inlineBody:op}]})).receipts[0];
  const replay=(await adapter.execute('receipts',{...base,operationIds:[op.operationId]})).receipts[0];
  assert.equal(first.currentRecord,null);assert.equal(replay.currentRecord,null);assert.equal(replay.currentVersion,null);
  assert.equal(first.currentRecordRef.digest,replay.currentRecordRef.digest);assert.equal(first.currentVersionRef.digest,replay.currentVersionRef.digest);
  assert.equal(store.searchRecords({kind:'journal'}).total,1);
});
