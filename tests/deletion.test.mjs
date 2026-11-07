import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {plainDoc} from '../plugins/library/legacy/content.mjs';
import {createStore} from '../plugins/library/legacy/store.mjs';
import {apply as workbench} from '../plugins/workbench/src/index.mjs';
import {apply as agentTools} from '../plugins/agent-tools/src/index.mjs';

test('删除持久化、撤销保留正文日期来源，过期请求不覆盖记录状态',t=>{
 const dir=mkdtempSync(join(tmpdir(),'shiwen-delete-')),path=join(dir,'library.sqlite');
 let store=createStore(path);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
 const saved=store.saveDsh({kind:'journal',title:'日记',body:'我的历史正文',origin:'personal',day:'2026-11-01',sessionId:'s',messageId:'m',role:'user',operationId:'o'});
 const versions=store.versions({id:saved.id}),provenance=store.dshSources({id:saved.id});
 const receipt=store.remove({id:saved.id,revision:saved.revision});
 assert.equal(store.snapshot().records.length,0);assert.equal(store.searchRecords({query:'历史'}).total,0);
 assert.throws(()=>store.save({...saved,revision:receipt.revision,body:'不应保存'}),/已删除/);
 assert.throws(()=>store.remove({id:saved.id,revision:saved.revision}),/变更/);
 store.close();store=createStore(path);assert.equal(store.snapshot().records.length,0);
 assert.throws(()=>store.restoreRemoved({...receipt,revision:saved.revision}),/变更/);
 const restored=store.restoreRemoved(receipt),record=store.get(saved.id);
 assert.equal(record.body,saved.body);assert.equal(record.updated,saved.updated);assert.deepEqual(record.dateInfo,saved.dateInfo);
 const restoredVersions=store.versions({id:saved.id});assert.equal(restoredVersions.length,versions.length+2);assert.deepEqual(restoredVersions.slice(2),versions);assert.deepEqual(store.dshSources({id:saved.id}),provenance);
 assert.equal(store.snapshot().records.length,1);
 assert.throws(()=>store.restoreRemoved(receipt),/变更/);
 assert.throws(()=>store.save({...saved,body:'过期正文'}),/更新/);
 assert.throws(()=>store.remove({id:saved.id,revision:saved.revision}),/变更/);
 assert.equal(store.save({id:saved.id,revision:restored.revision,doc:plainDoc('新正文','personal')}).body,'新正文');
});

test('删除关联素材不破坏文章保存，禁止新增已删除来源，撤销不增加写作统计',t=>{
 const dir=mkdtempSync(join(tmpdir(),'shiwen-delete-link-'));const store=createStore(join(dir,'a.sqlite'));
 t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
 const material=store.save({kind:'freewrite',body:'素材正文'}),article=store.save({kind:'article',body:'文章正文',sourceIds:[material.id]});
 const added=store.review().totals.added,receipt=store.remove(material);
 assert.equal(store.review().totals.added,added);
 const edited=store.save({...article,title:'更新标题'});assert.deepEqual(edited.sourceIds,[material.id]);
 assert.throws(()=>store.save({kind:'article',body:'新文章',sourceIds:[material.id]}),/关联素材/);
 assert.equal(store.snapshot().records.length,1);
 store.restoreRemoved(receipt);assert.equal(store.review().totals.added,added);
 assert.deepEqual(store.get(article.id).sourceIds,[material.id]);
});

test('工作台删除接口与助手检索读取一致，失败返回错误且支持撤销',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'shiwen-delete-rpc-'));const store=createStore(join(dir,'a.sqlite'));
 t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
 let route;workbench({shiwenLibrary:store,effect:fn=>fn(),connection:{fetch:{register:value=>{route=value;return()=>{};}}}});
 const rpc=async(method,args={})=>{const response=await route.fetch(new Request('http://localhost/api/shiwen',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({method,args})}));return {status:response.status,...await response.json()};};
 const tools=new Map();agentTools({shiwenLibrary:store,effect:fn=>fn(),tools:{register:tool=>{tools.set(tool.name,tool);return()=>{};}},systemPrompt:{section:()=>()=>{}}});
 const {result:saved}=await rpc('saveMarkdown',{kind:'idea',body:'独特素材正文'});
 const {result:receipt}=await rpc('remove',{id:saved.id,revision:saved.revision});
 assert.equal((await rpc('readMarkdown',{id:saved.id})).status,400);
 assert.equal((await rpc('saveMarkdown',{id:saved.id,revision:receipt.revision,body:'覆盖'})).status,400);
 const exec={signal:new AbortController().signal};
 await assert.rejects(()=>tools.get('shiwen_read').execute({id:saved.id},exec),/不存在/);
 assert.equal((await rpc('searchRecords',{query:'独特'})).result.total,0);
 assert.equal((await rpc('restoreRemoved',receipt)).status,200);
 assert.equal((await rpc('readMarkdown',{id:saved.id})).result.markdown,'独特素材正文');
 assert.equal((await rpc('remove',{id:saved.id,revision:saved.revision})).status,400);
});
