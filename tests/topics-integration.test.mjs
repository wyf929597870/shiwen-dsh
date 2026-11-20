import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {createStore} from '../plugins/library/legacy/store.mjs';
import {apply as workbench} from '../plugins/workbench/src/index.mjs';

const protocolVersion='1.0.0-draft.3';
function isolated(t){const dir=mkdtempSync(join(tmpdir(),'shiwen-topics-integration-'));const store=createStore(join(dir,'library.sqlite'));t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});return store;}
function snapshot(store){const sync=store.mobileSync(),deviceId=randomUUID(),identity=sync.identity({protocolVersion,deviceId}),begin=sync.bootstrapBegin({libraryId:identity.libraryId,epoch:identity.epoch,deviceId}),entities={};for(const type of begin.manifest.entityTypes){const items=[];let pageToken=null;do{const page=sync.bootstrapPage({snapshotId:begin.snapshotId,entityType:type,pageToken});items.push(...page.items);pageToken=page.nextPageToken;}while(pageToken);entities[type]=items;}return {identity,manifest:begin.manifest,entities};}
function setup(store,source,mode){const sync=store.mobileSync(),deviceId=randomUUID(),target=sync.identity({protocolVersion,deviceId}),setupId=randomUUID(),begin=sync.setupBegin({setupId,mode,libraryId:source.identity.libraryId,sourceEpoch:source.identity.epoch,manifest:source.manifest,manifestDigest:source.manifest.manifestDigest,expectedLibraryId:target.libraryId,expectedEpoch:target.epoch,targetGeneration:target.targetGeneration});for(const type of source.manifest.entityTypes){const items=source.entities[type];for(let i=0;i<items.length;i+=100)sync.setupPage({setupId,fencingToken:begin.fencingToken,entityType:type,startOrdinal:i,items:items.slice(i,i+100)});}return sync.setupCommit({setupId,fencingToken:begin.fencingToken});}
const add=(store,theme,source)=>store.themeMemberAdd({themeId:theme.id,revision:theme.revision,sourceRecordId:source.id,sourceRevision:source.revision,field:'body',quote:'片段',start:2,end:4});

test('主题备份往返、旧备份兼容及失效快照',t=>{
 const source=isolated(t),record=source.save({kind:'idea',body:'前文片段后文'}),theme=source.themeSave({title:'主题',summary:'说明'}),added=add(source,theme,record),member=added.members[0];
 assert.equal(member.location.status,'current');assert.throws(()=>add(source,theme,record),/更新|版本/);
 const backup=source.exportBackup(),target=isolated(t);target.restoreBackup(backup);
 const restored=target.themeRead({id:theme.id});assert.equal(restored.members[0].quote,'片段');assert.equal(restored.members[0].location.status,'current');
 const same=target.get(record.id);target.updateRecord({id:same.id,revision:same.revision,body:'改动之后'});assert.equal(target.themeRead({id:theme.id}).members[0].location.status,'changed');
 const current=target.get(record.id);target.remove({id:current.id,revision:current.revision});const missing=target.themeRead({id:theme.id}).members[0];assert.equal(missing.location.status,'deleted');assert.equal(missing.quote,'片段');
 const old=JSON.parse(backup);old.payload.schema=15;delete old.payload.libraryId;delete old.payload.tables.themes;delete old.payload.tables.theme_members;old.sha256=createHash('sha256').update(JSON.stringify(old.payload)).digest('hex');target.restoreBackup(JSON.stringify(old));assert.deepEqual(target.themeList(),[]);
});

test('手机恢复保留主题并以资料库身份阻止同 ID 误关联',t=>{
 const target=isolated(t),empty=snapshot(target),record=target.save({kind:'idea',body:'前文片段后文'}),theme=target.themeSave({title:'旧库主题'}),added=add(target,theme,record);
 setup(target,empty,'recover');assert.equal(target.themeRead({id:theme.id}).members[0].location.status,'deleted');
 const other=isolated(t);other.save({id:record.id,kind:'idea',body:'前文片段后文'},{allowCreateWithId:true});const otherSnapshot=snapshot(other);
 setup(target,otherSnapshot,'initialize');const entry=target.themeRead({id:theme.id}).members[0];assert.equal(entry.id,added.members[0].id);assert.equal(entry.quote,'片段');assert.equal(entry.location.status,'library_mismatch');assert.deepEqual(target.recordThemes({id:record.id}),[]);
 const copied=isolated(t);copied.restoreBackup(target.exportBackup());const after=copied.themeRead({id:theme.id}).members[0];assert.equal(after.sourceLibraryId,entry.sourceLibraryId);assert.equal(after.location.status,'library_mismatch');
});

test('重复片段保持歧义，主题操作要求所有者',async t=>{
 const s=isolated(t),before='前'.repeat(64),after='后'.repeat(64),record=s.save({kind:'idea',body:before+'片段'+after}),theme=s.themeSave({title:'主题'});
 const saved=s.themeMemberAdd({themeId:theme.id,revision:theme.revision,sourceRecordId:record.id,sourceRevision:record.revision,field:'body',quote:'片段',start:64,end:66});
 s.updateRecord({id:record.id,revision:record.revision,body:before+'片段'+after+before+'片段'+after});assert.equal(s.themeRead({id:theme.id}).members[0].location.status,'ambiguous');
 assert.throws(()=>s.themeMemberRemove({themeId:theme.id,revision:theme.revision,memberId:saved.members[0].id}),/更新|版本/);
 const browserPeer={id:'owner'};let peer=browserPeer,route;workbench({shiwenLibrary:s,effect:fn=>fn(),connection:{browserPeer,admit:()=>({peer}),fetch:{register:value=>{route=value;return()=>{};}}}});
 const rpc=async(method,args)=>route.fetch(new Request('http://localhost/api/shiwen',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({method,args})}));
 assert.equal((await rpc('themeRead',{id:theme.id})).status,200);
 const libraryId=s.themeContext().libraryId;
 const read=await (await rpc('readMarkdown',{id:record.id})).json();assert.equal(read.result.sourceLibraryId,libraryId);
 const note=s.readingNoteSave({requestId:randomUUID(),book:'书',day:'2026-11-17',reflection:'感想',excerpts:[{text:'摘录',page:''}]});
 const notes=await (await rpc('readingNoteList',{})).json();assert.equal(notes.result.records.find(row=>row.id===note.id)?.sourceLibraryId,libraryId);
 assert.equal((await rpc('themeSave',{title:'缺少身份'})).status,400);
 assert.equal((await rpc('themeSave',{title:'错误身份',expectedLibraryId:randomUUID()})).status,400);
 assert.equal((await rpc('themeSave',{title:'正确身份',expectedLibraryId:libraryId})).status,200);
 assert.equal((await rpc('themeDelete',{id:theme.id,revision:saved.revision,expectedLibraryId:randomUUID()})).status,400);
 assert.equal(s.themeRead({id:theme.id}).id,theme.id);
 peer={id:'other'};assert.equal((await rpc('themeRead',{id:theme.id})).status,403);assert.equal((await rpc('themeSave',{title:'无权写入',expectedLibraryId:libraryId})).status,403);
 const nonOwner=await (await rpc('readMarkdown',{id:record.id})).json();assert.equal(nonOwner.result.sourceLibraryId,undefined);
});
