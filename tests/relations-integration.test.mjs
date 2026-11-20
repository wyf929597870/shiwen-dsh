import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {createStore} from '../plugins/library/legacy/store.mjs';
import {apply as workbench} from '../plugins/workbench/src/index.mjs';
function isolated(t){const dir=mkdtempSync(join(tmpdir(),'shiwen-relations-'));const s=createStore(join(dir,'library.sqlite'));t.after(()=>{s.close();rmSync(dir,{recursive:true,force:true});});return s;}
const sign=backup=>{backup.sha256=createHash('sha256').update(JSON.stringify(backup.payload)).digest('hex');return JSON.stringify(backup);};
function snapshot(s){const sync=s.mobileSync(),deviceId=randomUUID(),identity=sync.identity({protocolVersion:'1.0.0-draft.3',deviceId}),start=sync.bootstrapBegin({libraryId:identity.libraryId,epoch:identity.epoch,deviceId}),entities={};for(const type of start.manifest.entityTypes){let token=null;const rows=[];do{const page=sync.bootstrapPage({snapshotId:start.snapshotId,entityType:type,pageToken:token});rows.push(...page.items);token=page.nextPageToken;}while(token);entities[type]=rows;}return {identity,manifest:start.manifest,entities};}
function setup(s,source,mode){const sync=s.mobileSync(),deviceId=randomUUID(),identity=sync.identity({protocolVersion:'1.0.0-draft.3',deviceId}),setupId=randomUUID(),started=sync.setupBegin({setupId,mode,libraryId:source.identity.libraryId,sourceEpoch:source.identity.epoch,manifest:source.manifest,manifestDigest:source.manifest.manifestDigest,expectedLibraryId:identity.libraryId,expectedEpoch:identity.epoch,targetGeneration:identity.targetGeneration});for(const type of source.manifest.entityTypes)if(source.entities[type].length)sync.setupPage({setupId,fencingToken:started.fencingToken,entityType:type,startOrdinal:0,items:source.entities[type]});return sync.setupCommit({setupId,fencingToken:started.fencingToken});}
test('来源与手动关系各自保存，同一对可并存且双向去重',t=>{
 const s=isolated(t),a=s.save({kind:'idea',body:'素材'}),b=s.save({kind:'article',body:'文章',sourceIds:[a.id]}),scope=s.themeContext().libraryId;
 assert.deepEqual(s.recordNeighborhood({id:a.id}).articles.map(x=>x.id),[b.id]);assert.deepEqual(s.recordNeighborhood({id:b.id}).sources.map(x=>x.id),[a.id]);
 const args={id:a.id,relatedId:b.id,expectedLibraryId:scope};s.recordRelationAdd(args);s.recordRelationAdd({...args,id:b.id,relatedId:a.id});
 assert.deepEqual(s.recordNeighborhood({id:a.id}).related.map(x=>x.id),[b.id]);assert.deepEqual(s.recordNeighborhood({id:b.id}).related.map(x=>x.id),[a.id]);
 s.recordRelationRemove(args);assert.deepEqual(s.recordNeighborhood({id:a.id}).related,[]);assert.deepEqual(s.recordNeighborhood({id:a.id}).articles.map(x=>x.id),[b.id]);
 assert.throws(()=>s.recordRelationAdd({...args,expectedLibraryId:randomUUID()}));assert.throws(()=>s.recordRelationAdd({...args,relatedId:a.id}));
});
test('完整备份保留关系，旧备份无关系，外库身份碰撞不误关联',t=>{
 const source=isolated(t),a=source.save({kind:'idea',body:'甲'}),b=source.save({kind:'idea',body:'乙'}),scope=source.themeContext().libraryId;
 source.recordRelationAdd({id:a.id,relatedId:b.id,expectedLibraryId:scope});const raw=source.exportBackup(),target=isolated(t),targetScope=target.themeContext().libraryId;
 target.restoreBackup(raw);assert.deepEqual(target.recordNeighborhood({id:a.id}).related.map(x=>x.id),[b.id]);
 const collision=JSON.parse(raw);collision.payload.tables.record_relations[0].library_id=targetScope;target.restoreBackup(sign(collision));assert.deepEqual(target.recordNeighborhood({id:a.id}).related,[]);
 target.restoreBackup(target.exportBackup());assert.deepEqual(target.recordNeighborhood({id:a.id}).related,[]);
 const legacy=JSON.parse(raw);legacy.payload.schema=16;delete legacy.payload.tables.record_relations;target.restoreBackup(sign(legacy));assert.deepEqual(target.recordNeighborhood({id:a.id}).related,[]);
});
test('关系 API 仅所有者访问且写操作绑定资料库',async t=>{
 const s=isolated(t),a=s.save({kind:'idea',body:'甲'}),b=s.save({kind:'idea',body:'乙'}),scope=s.themeContext().libraryId,owner={};let peer=owner,route;
 workbench({shiwenLibrary:s,effect:fn=>fn(),connection:{browserPeer:owner,admit:()=>({peer}),fetch:{register:value=>{route=value;return()=>{};}}}});
 const rpc=async(method,args)=>route.fetch(new Request('http://localhost/api/shiwen',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({method,args})}));
 assert.equal((await rpc('recordNeighborhood',{id:a.id})).status,200);assert.equal((await rpc('recordRelationAdd',{id:a.id,relatedId:b.id,expectedLibraryId:randomUUID()})).status,400);assert.deepEqual(s.recordNeighborhood({id:a.id}).related,[]);
 assert.equal((await rpc('recordRelationAdd',{id:a.id,relatedId:b.id,expectedLibraryId:scope})).status,200);peer={};assert.equal((await rpc('recordNeighborhood',{id:a.id})).status,403);assert.equal((await rpc('recordRelationRemove',{id:a.id,relatedId:b.id,expectedLibraryId:scope})).status,403);
});
test('手机恢复保留手动关系，不同库同 ID 不构成关系',t=>{
 const target=isolated(t),empty=snapshot(target),a=target.save({kind:'idea',body:'甲'}),b=target.save({kind:'idea',body:'乙'});target.recordRelationAdd({id:a.id,relatedId:b.id,expectedLibraryId:target.themeContext().libraryId});
 const same=snapshot(target);setup(target,same,'recover');assert.deepEqual(target.recordNeighborhood({id:a.id}).related.map(x=>x.id),[b.id]);
 setup(target,empty,'recover');const other=isolated(t);other.save({id:a.id,kind:'idea',body:'甲'},{allowCreateWithId:true});other.save({id:b.id,kind:'idea',body:'乙'},{allowCreateWithId:true});setup(target,snapshot(other),'initialize');assert.deepEqual(target.recordNeighborhood({id:a.id}).related,[]);
});
