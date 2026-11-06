import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createStore} from '../plugins/library/legacy/store.mjs';
const setup=t=>{const dir=mkdtempSync(join(tmpdir(),'shiwen-ext-store-'));const store=createStore(join(dir,'library.sqlite'));t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});return {store,dir};};
const saveArgs={requestId:'save-1',kind:'journal',origin:'personal',body:'# 我的日记\n今天去散步',day:'2026-10-12',source:{sessionId:'external-conversation',messageId:'message-1'}};
function client(store,scopes,name='WorkBuddy'){const issued=store.externalClientCreate({name,scopes});return {issued,identity:store.externalAuthenticate(issued.token)};}
test('外部来源与作者分离、请求重试幂等、权限独立且可撤销',t=>{
 const {store}=setup(t),{issued,identity}=client(store,['create']);
 assert.deepEqual(store.externalCatalog(identity).map(x=>x.name),['shiwen_save','shiwen_collect']);
 const first=store.externalCall(identity,'shiwen_save',saveArgs);
 assert.equal(first.origin,'personal');assert.equal(first.client.name,'WorkBuddy');assert.equal(store.get(first.id).externalSources[0].session_id,saveArgs.source.sessionId);
 assert.deepEqual(store.externalCall(identity,'shiwen_save',{...saveArgs,source:{messageId:'message-1',sessionId:'external-conversation'}}),first);
 assert.equal(store.snapshot().records.length,1);assert.equal(store.review().totals.added,0);
 assert.throws(()=>store.externalCall(identity,'shiwen_save',{...saveArgs,body:'另一段文字'}),/不同请求/);
 for(const [name,args] of [['shiwen_read',{id:first.id}],['shiwen_update',{id:first.id,revision:1,title:'覆盖',requestId:'edit'}],['shiwen_delete',{id:first.id,revision:1,requestId:'delete'}]])assert.throws(()=>store.externalCall(identity,name,args),/权限/);
 store.externalClientRevoke({id:issued.id});assert.throws(()=>store.externalAuthenticate(issued.token),/撤销/);assert.throws(()=>store.externalCall(identity,'shiwen_save',saveArgs),/撤销/);
 assert.ok(!JSON.stringify(store.externalClients()).includes(issued.token));assert.ok(!store.exportBackup().includes('token_hash'));assert.ok(!store.exportBackup().includes(issued.token));
});
test('授权更新、删除和恢复共用版本校验；出错操作原子回滚',t=>{
 const {store}=setup(t),{identity}=client(store,['create','read','update','delete']);
 assert.equal(store.externalCatalog(identity).length,8);
 const initial=store.externalCall(identity,'shiwen_save',saveArgs);
 const updated=store.externalCall(identity,'shiwen_update',{requestId:'update-1',id:initial.id,revision:initial.revision,kind:'reference',origin:'external',url:'https://example.org'});
 assert.equal(updated.origin,'external');assert.equal(store.get(initial.id).externalSources.length,2);
 assert.throws(()=>store.externalCall(identity,'shiwen_update',{requestId:'stale',id:initial.id,revision:initial.revision,title:'old'}),/更新/);
 assert.throws(()=>store.externalCall(identity,'shiwen_update',{requestId:'bad',id:initial.id,revision:updated.revision,title:'部分写入',sourceIds:['missing']}),/关联/);
 assert.equal(store.get(initial.id).title,initial.title);assert.equal(store.get(initial.id).revision,updated.revision);
 assert.throws(()=>store.externalCall(identity,'shiwen_save',{...saveArgs,requestId:'bad-date',day:'2026-02-30'}),/日期/);assert.equal(store.snapshot().records.length,1);
 const deleted=store.externalCall(identity,'shiwen_delete',{requestId:'delete-1',id:initial.id,revision:updated.revision});
 assert.throws(()=>store.externalCall(identity,'shiwen_read',{id:initial.id}),/不存在/);
 const restored=store.externalCall(identity,'shiwen_restore',{requestId:'restore-1',id:deleted.id,revision:deleted.revision});assert.ok(restored.restored);
 assert.deepEqual(store.externalCall(identity,'shiwen_delete',{requestId:'delete-1',id:initial.id,revision:updated.revision}),deleted);
 assert.equal(store.get(initial.id).deleted,0); // Retrying a completed delete cannot delete a restored record again.
 assert.equal(store.externalCall(identity,'shiwen_read',{id:initial.id}).origin,'external');
});
test('外部请求与凭据重启后有效；备份包含保存出处但不迁移凭据',t=>{
 const {store,dir}=setup(t),{issued,identity}=client(store,['create','read']);
 const record=store.externalCall(identity,'shiwen_collect',{requestId:'collect-1',body:'网页原文',url:'https://example.org',source:{file:'articles/original.md'}});
 const reopened=createStore(join(dir,'library.sqlite'));t.after(()=>reopened.close());
 assert.equal(reopened.externalAuthenticate(issued.token).id,identity.id);
 assert.equal(reopened.externalCall(identity,'shiwen_collect',{requestId:'collect-1',body:'网页原文',url:'https://example.org',source:{file:'articles/original.md'}}).id,record.id);
 const target=createStore(join(dir,'restore.sqlite'));t.after(()=>target.close());target.restoreBackup(store.exportBackup());
 assert.equal(target.get(record.id).externalSources[0].client_name,'WorkBuddy');assert.equal(target.externalClients().length,0);
 assert.throws(()=>target.externalAuthenticate(issued.token),/无效/);
});
test('接口拒绝未知字段、伪造客户端与空修改',t=>{
 const {store}=setup(t),{identity}=client(store,['create','update']);
 for(const extra of [{clientId:'fake'},{client:{name:'fake'}},{source:{clientName:'fake'}},{origin:'not-real'}])assert.throws(()=>store.externalCall(identity,'shiwen_save',{...saveArgs,...extra}));
 const row=store.externalCall(identity,'shiwen_save',saveArgs);
 assert.throws(()=>store.externalCall(identity,'shiwen_update',{id:row.id,revision:row.revision,requestId:'empty'}),/字段/);
 assert.equal(store.get(row.id).revision,1);
});
