import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createStore} from '../plugins/library/legacy/store.mjs';
const setup=t=>{const dir=mkdtempSync(join(tmpdir(),'shiwen-ext-store-'));const store=createStore(join(dir,'library.sqlite'));t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});return {store,dir};};
const saveArgs={requestId:'save-1',kind:'journal',origin:'personal',body:'# 我的日记\n今天去散步',day:'2026-10-12',source:{sessionId:'external-conversation',messageId:'message-1'}};
function client(store,scopes,name='WorkBuddy'){const issued=store.externalClientCreate({name,scopes});return {issued,identity:store.externalAuthenticate(issued.token)};}
test('external image chunks commit with the record and remain idempotent',t=>{
 const {store}=setup(t),{identity}=client(store,['create','read','update']),other=client(store,['create']).identity;
 const bytes=Buffer.from('89504e470d0a1a0a00010203','hex'),digest=createHash('sha256').update(bytes).digest('hex'),uploadId=randomUUID();
 const begin={uploadId,purpose:'create',name:'image.png',byteLength:bytes.length,digest};
 assert.equal(store.externalCall(identity,'shiwen_image_begin',begin).ready,false);
 assert.throws(()=>store.externalCall(other,'shiwen_image_part',{uploadId,part:0,dataBase64:bytes.toString('base64')}),/权限/);
 assert.equal(store.externalCall(identity,'shiwen_image_part',{uploadId,part:0,dataBase64:bytes.toString('base64')}).ready,true);
 const args={requestId:'image-save',kind:'reference',origin:'external',body:`![image](attachment:${uploadId})`,imageIds:[uploadId]};
 assert.throws(()=>store.externalCall(identity,'shiwen_save',{...args,requestId:'image-in-code',body:'`'+args.body+'`'}),/正文缺少图片引用/);
 assert.throws(()=>store.externalCall(identity,'shiwen_save',{...args,requestId:'missing-image',body:args.body+`\n![missing](attachment:${randomUUID()})`}),/图片不存在/);
 const saved=store.externalCall(identity,'shiwen_save',args);
 assert.deepEqual(store.externalCall(identity,'shiwen_save',args),saved);
 assert.equal(store.externalCall(identity,'shiwen_image_read',{id:saved.id,attachmentId:uploadId}).dataBase64,bytes.toString('base64'));
 const legacyMissing=randomUUID();const legacy=store.save({kind:'reference',body:`![old](attachment:${legacyMissing})`});
 assert.doesNotThrow(()=>store.externalCall(identity,'shiwen_update',{requestId:'legacy-update',id:legacy.id,revision:legacy.revision,body:`![old](attachment:${legacyMissing})\ncontinued`}));
 assert.doesNotThrow(()=>store.externalCall(identity,'shiwen_save',{requestId:'image-code-only',kind:'reference',origin:'external',body:`\`![example](attachment:${randomUUID()})\``}));
 assert.equal(store.attachments({record:saved.id}).length,1);
 const nextId=randomUUID();store.externalCall(identity,'shiwen_image_begin',{uploadId:nextId,purpose:'update',recordId:saved.id,name:'second.png',byteLength:bytes.length,digest});
 store.externalCall(identity,'shiwen_image_part',{uploadId:nextId,part:0,dataBase64:bytes.toString('base64')});
 const update={requestId:'image-update',id:saved.id,revision:saved.revision,body:`![new](attachment:${nextId})`,imageIds:[nextId]};
 assert.throws(()=>store.externalCall(identity,'shiwen_update',{...update,revision:saved.revision+1}),/更新/);
 assert.equal(store.attachments({record:saved.id}).length,1);
 const edited=store.externalCall(identity,'shiwen_update',update);
 assert.equal(edited.revision,saved.revision+1);
 assert.deepEqual(store.externalCall(identity,'shiwen_update',update),edited);
 assert.equal(store.attachments({record:saved.id}).length,2);
 assert.equal(store.externalCall(identity,'shiwen_image_read',{id:saved.id,attachmentId:uploadId}).dataBase64,bytes.toString('base64'));
});
test('外部来源与作者分离、请求重试幂等、权限独立且可撤销',t=>{
 const {store}=setup(t),{issued,identity}=client(store,['create']);
 assert.deepEqual(store.externalCatalog(identity).map(x=>x.name),['shiwen_image_begin','shiwen_image_part','shiwen_image_status','shiwen_save','shiwen_collect','shiwen_annotation_create']);
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
 assert.ok(store.externalCatalog(identity).some(x=>x.name==='shiwen_annotation_create'));
 const initial=store.externalCall(identity,'shiwen_save',saveArgs);
 const updated=store.externalCall(identity,'shiwen_update',{requestId:'update-1',id:initial.id,revision:initial.revision,kind:'reference',url:'https://example.org'});
 assert.equal(updated.origin,'personal');assert.equal(store.get(initial.id).externalSources.length,2);
 const corrected=store.externalCall(identity,'shiwen_correct_origin',{requestId:'correct-1',id:initial.id,revision:updated.revision,origin:'external'});assert.equal(corrected.origin,'external');
 assert.throws(()=>store.externalCall(identity,'shiwen_update',{requestId:'stale',id:initial.id,revision:initial.revision,title:'old'}),/更新/);
 assert.throws(()=>store.externalCall(identity,'shiwen_update',{requestId:'bad',id:initial.id,revision:corrected.revision,title:'部分写入',sourceIds:['missing']}),/关联/);
 assert.equal(store.get(initial.id).title,initial.title);assert.equal(store.get(initial.id).revision,corrected.revision);
 assert.throws(()=>store.externalCall(identity,'shiwen_save',{...saveArgs,requestId:'bad-date',day:'2026-02-30'}),/日期/);assert.equal(store.snapshot().records.length,1);
 const deleted=store.externalCall(identity,'shiwen_delete',{requestId:'delete-1',id:initial.id,revision:corrected.revision});
 assert.throws(()=>store.externalCall(identity,'shiwen_read',{id:initial.id}),/不存在/);
 const restored=store.externalCall(identity,'shiwen_restore',{requestId:'restore-1',id:deleted.id,revision:deleted.revision});assert.ok(restored.restored);
 assert.deepEqual(store.externalCall(identity,'shiwen_delete',{requestId:'delete-1',id:initial.id,revision:corrected.revision}),deleted);
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

test('MCP annotations keep original untouched, validate version and permissions, and retry safely',t=>{
 const {store}=setup(t),{identity}=client(store,['create','read','update','delete']),limited=client(store,['read']).identity;
 const original=store.externalCall(identity,'shiwen_save',{requestId:'original',kind:'freewrite',origin:'personal',body:'原文'});
 const version=store.externalCall(identity,'shiwen_original_version',{id:original.id});
 const args={requestId:'annotation',originalId:original.id,originalVersionId:version.versionId,originalContentHash:version.contentHash,title:'建议',body:'AI 建议'};
 assert.throws(()=>store.externalCall(limited,'shiwen_annotation_create',args),/权限/);
 assert.throws(()=>store.externalCall(identity,'shiwen_annotation_create',{...args,requestId:'bad-hash',originalContentHash:'0'.repeat(64)}),/校验/);
 const note=store.externalCall(identity,'shiwen_annotation_create',args);assert.deepEqual(store.externalCall(identity,'shiwen_annotation_create',args),note);
 assert.equal(store.externalCall(identity,'shiwen_annotation_list',{originalId:original.id})[0].annotationOf.versionId,version.versionId);
 assert.equal(store.externalCall(identity,'shiwen_annotation_read',{id:note.id}).body,'AI 建议');
 assert.throws(()=>store.externalCall(identity,'shiwen_read',{id:note.id}),/批注/);
 assert.throws(()=>store.externalCall(identity,'shiwen_update',{id:note.id,revision:note.revision,body:'覆盖',requestId:'wrong'}),/批注/);
 const updated=store.externalCall(identity,'shiwen_annotation_update',{id:note.id,revision:note.revision,body:'新建议',requestId:'edit-note'});
 assert.throws(()=>store.externalCall(identity,'shiwen_annotation_update',{id:note.id,revision:note.revision,body:'冲突',requestId:'stale-note'}),/更新/);
 const removed=store.externalCall(identity,'shiwen_annotation_delete',{id:note.id,revision:updated.revision,requestId:'delete-note'});
 store.externalCall(identity,'shiwen_annotation_restore',{id:note.id,revision:removed.revision,requestId:'restore-note'});
 assert.equal(store.externalCall(identity,'shiwen_read',{id:original.id}).body,'原文');assert.equal(store.get(original.id).revision,original.revision);
});

test('MCP annotation images are attached atomically and remain readable on retry',t=>{
 const {store}=setup(t),{identity}=client(store,['create','read','update']);
 const original=store.externalCall(identity,'shiwen_save',{requestId:'img-original',kind:'idea',origin:'personal',body:'原文'});
 const version=store.externalCall(identity,'shiwen_original_version',{id:original.id});
 const bytes=Buffer.from('89504e470d0a1a0a00010203','hex'),uploadId=randomUUID(),digest=createHash('sha256').update(bytes).digest('hex');
 store.externalCall(identity,'shiwen_image_begin',{uploadId,purpose:'create',name:'a.png',byteLength:bytes.length,digest});
 store.externalCall(identity,'shiwen_image_part',{uploadId,part:0,dataBase64:bytes.toString('base64')});
 const args={requestId:'img-note',originalId:original.id,originalVersionId:version.versionId,body:`![图](attachment:${uploadId})`,imageIds:[uploadId]};
 const note=store.externalCall(identity,'shiwen_annotation_create',args);assert.deepEqual(store.externalCall(identity,'shiwen_annotation_create',args),note);
 assert.equal(store.externalCall(identity,'shiwen_image_read',{id:note.id,attachmentId:uploadId}).dataBase64,bytes.toString('base64'));
 assert.equal(store.attachments({record:original.id}).length,0);
});
