import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createStore} from '../plugins/library/legacy/store.mjs';
import {createModel} from '../plugins/library/src/search/model.mjs';
import {createContentSearch} from '../plugins/library/src/search/service.mjs';

test('exact search survives disabled model and validates scope and filters',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'shiwen-service-test-'));const library=createStore(join(dir,'library.sqlite'));library.paths={library:dir,root:dir};const service=createContentSearch({library});
 t.after(async()=>{await service.close();library.close();await rm(dir,{recursive:true,force:true});});
 const row=library.save({kind:'freewrite',title:'隔离样本',body:'今天开始行动'});
 const bulk=library.searchSnapshot().find(x=>x.id===row.id), normal=library.snapshot().records.find(x=>x.id===row.id);assert.equal(bulk.contentDay,normal.contentDay);assert.deepEqual(bulk.doc,normal.doc);
 const result=await service.search({query:'开始',scope:'materials'});assert.equal(result.items[0].recordId,row.id);assert.equal(result.mode,'exact');
 await assert.rejects(service.search({query:'开始',mode:'semantic'}),{code:'SEMANTIC_NOT_READY'});
 await assert.rejects(service.search({query:'开始',scope:'articles',filters:{kind:'freewrite'}}),{code:'INVALID_REQUEST'});
 await assert.rejects(service.search({query:'开始',filters:{start:'2026-02-31'}}),{code:'INVALID_REQUEST'});
});

test('failed model download is shared, rejected by checksum and leaves no partial model',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'shiwen-model-download-test-'));let calls=0;
 const model=createModel({directory:dir,fetchImpl:async()=>{calls++;return new Response('invalid bytes');}});
 t.after(async()=>{await model.close();await rm(dir,{recursive:true,force:true});});
 const [a,b]=await Promise.allSettled([model.enable(),model.enable()]);assert.equal(a.status,'rejected');assert.equal(b.status,'rejected');assert.equal(calls,1);assert.equal(model.status().state,'failed');assert.deepEqual(await readdir(dir),[]);assert.equal(await model.available(),false);
});

test('offline and interrupted downloads retain retryable failure and no partial model',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'shiwen-model-interrupted-'));let attempt=0;
 const fetchImpl=async()=>{attempt++;if(attempt===1)throw Error('offline');return new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array([1,2,3]));c.error(Error('connection lost'));}}));};
 const model=createModel({directory:dir,fetchImpl});t.after(async()=>{await model.close();await rm(dir,{recursive:true,force:true});});
 await assert.rejects(model.enable());assert.equal(model.status().error.retryable,true);assert.deepEqual(await readdir(dir),[]);
 await assert.rejects(model.enable());assert.equal(model.status().state,'failed');assert.deepEqual(await readdir(dir),[]);
});

test('unexpected worker exit rejects an active request and exposes failure',async t=>{
 const {writeFile}=await import('node:fs/promises'),{createHash}=await import('node:crypto');const dir=await mkdtemp(join(tmpdir(),'shiwen-model-crash-'));
 const body=Buffer.from('fixture'),hash=createHash('sha256').update(body).digest('hex'),files=[{name:'fixture',url:'https://invalid.test/model',size:body.length,sha256:hash}],workerPath=join(dir,'worker.mjs');
 await writeFile(workerPath,"import {parentPort} from 'node:worker_threads';parentPort.postMessage({ready:true});parentPort.on('message',()=>process.exit(0));");
 const model=createModel({directory:join(dir,'models'),files,workerUrl:new URL('file://'+workerPath),fetchImpl:async()=>new Response(body)});t.after(async()=>{await model.close();await rm(dir,{recursive:true,force:true});});
 await model.enable();await assert.rejects(model.embed(['query']));assert.equal(model.status().state,'failed');assert.equal(model.status().error.retryable,true);
});

test('corrupt derived index never blocks records or exact search and can be rebuilt',async t=>{
 const {mkdir,writeFile}=await import('node:fs/promises');const dir=await mkdtemp(join(tmpdir(),'shiwen-index-corrupt-'));
 const library=createStore(join(dir,'library.sqlite'));library.paths={library:dir,root:dir};await mkdir(join(dir,'search'));await writeFile(join(dir,'search','search.sqlite'),'not a sqlite database');
 const service=createContentSearch({library});t.after(async()=>{await service.close();library.close();await rm(dir,{recursive:true,force:true});});
 assert.equal(service.status().state,'failed');const row=library.save({kind:'freewrite',title:'隔离测试',body:'索引坏了也能保存'});
 assert.equal((await service.search({query:'也能保存',scope:'materials'})).items[0].recordId,row.id);
 await assert.rejects(service.search({query:'保存',mode:'semantic'}),{code:'SEMANTIC_NOT_READY'});
 const repaired=await service.rebuild();assert.equal(repaired.index.state,'missing');assert.equal(repaired.state,'disabled');
 assert.equal((await service.search({query:'也能保存',scope:'materials'})).items[0].recordId,row.id);
});

test('runtime index failure preserves exact search and can be repaired',async t=>{
 const {DatabaseSync}=await import('node:sqlite');const dir=await mkdtemp(join(tmpdir(),'shiwen-index-runtime-'));
 const library=createStore(join(dir,'library.sqlite'));library.paths={library:dir,root:dir};const service=createContentSearch({library});
 t.after(async()=>{await service.close();library.close();await rm(dir,{recursive:true,force:true});});
 const row=library.save({kind:'freewrite',title:'故障测试',body:'仍然可以搜索'}),db=new DatabaseSync(join(dir,'search','search.sqlite'));db.exec('DROP TABLE records');db.close();
 const found=await service.search({query:'可以搜索',scope:'materials'});assert.equal(found.items[0].recordId,row.id);assert.equal(found.status.state,'failed');
 assert.equal((await service.rebuild()).index.state,'missing');assert.equal((await service.search({query:'可以搜索'})).items[0].recordId,row.id);
});

test('repair waits for an in-flight index close before recreating its directory',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'shiwen-index-close-'));let release,created=0;
 const gate=new Promise(resolve=>release=resolve),model={status:()=>({state:'missing'}),available:async()=>false,close:async()=>{}};
 const factory=()=>{created++;return {status:()=>({state:'failed'}),rebuild(){throw Error('index write failed');},close:()=>gate};};
 const library={paths:{library:dir,root:dir},readingNoteList:()=>({scope:'test'})};const service=createContentSearch({library,modelFactory:()=>model,indexFactory:factory});
 t.after(async()=>{release();await service.close();await rm(dir,{recursive:true,force:true});});
 const repair=service.rebuild(),parallel=service.rebuild();await new Promise(resolve=>setImmediate(resolve));assert.equal(created,1);
 release();await Promise.all([repair,parallel]);assert.equal(created,2);
});

test('aborting a stuck indexing request fails concurrent query and permits worker restart',async t=>{
 const {writeFile}=await import('node:fs/promises'),{createHash}=await import('node:crypto');const dir=await mkdtemp(join(tmpdir(),'shiwen-model-abort-'));
 const body=Buffer.from('fixture'),files=[{name:'fixture',url:'https://invalid.test/model',size:body.length,sha256:createHash('sha256').update(body).digest('hex')}],workerPath=join(dir,'worker.mjs');
 await writeFile(workerPath,"import {parentPort} from 'node:worker_threads';parentPort.postMessage({ready:true});parentPort.on('message',()=>{});");
 const model=createModel({directory:join(dir,'models'),files,workerUrl:new URL('file://'+workerPath),fetchImpl:async()=>new Response(body)});t.after(async()=>{await model.close();await rm(dir,{recursive:true,force:true});});
 await model.enable();const controller=new AbortController(),index=model.embed(['index'],{priority:'index',signal:controller.signal}),query=model.embed(['query'],{priority:'query'});controller.abort();
 const outcomes=await Promise.allSettled([index,query]);assert.deepEqual(outcomes.map(x=>x.status),['rejected','rejected']);assert.equal(model.status().state,'failed');assert.equal(model.status().error.retryable,true);
 await model.enable();assert.equal(model.status().state,'ready');
});
