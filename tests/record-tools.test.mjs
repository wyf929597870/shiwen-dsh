import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createStore} from '../plugins/library/legacy/store.mjs';
import {plainDoc,readDoc} from '../plugins/library/legacy/content.mjs';
import {apply} from '../plugins/agent-tools/src/index.mjs';
import {apply as workbench} from '../plugins/workbench/src/index.mjs';
function fixture(t){
 const dir=mkdtempSync(join(tmpdir(),'shiwen-record-tools-')),path=join(dir,'library.sqlite');
 const store=createStore(path);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
 const tools=new Map();apply({shiwenLibrary:store,effect:fn=>fn(),tools:{register:tool=>{tools.set(tool.name,tool);return()=>{};}},systemPrompt:{section:()=>()=>{}}});
 const exec={agent:{session:{id:'s'}},signal:new AbortController().signal,callId:'update-1'};
 const call=(name,args,context=exec)=>tools.get(name).execute(args,context);
 return {store,call,exec,path};
}
test('Agent 改分类保留正文和来源，重试幂等，陈旧版本不能覆盖',async t=>{
 const {store,call,exec}=fixture(t),saved=store.save({kind:'reference',body:'原始素材',url:'https://example.org'});
 const before=await call('shiwen_read',{id:saved.id});assert.equal(before.revision,saved.revision);
 const args={id:saved.id,revision:before.revision,kind:'journal',title:'改为日记',day:'2026-10-12'};
 const updated=await call('shiwen_update',args);assert.equal(updated.kind,'journal');assert.equal(updated.origin,before.origin);assert.equal(updated.url,before.url);
 assert.deepEqual(store.get(saved.id).doc,saved.doc);assert.equal(store.versions({id:saved.id}).length,2);
 assert.deepEqual(await call('shiwen_update',args),updated);assert.equal(store.get(saved.id).revision,updated.revision);
 await assert.rejects(()=>call('shiwen_update',{...args,title:'不同参数'}),/参数不一致/);
 await assert.rejects(()=>call('shiwen_update',args,{...exec,callId:'new-call'}),/重新读取/);
 assert.throws(()=>store.save({id:saved.id,revision:before.revision,doc:plainDoc('旧编辑器正文')}),/更新/);
 assert.equal(store.searchRecords({kind:'journal',start:'2026-10-01',end:'2026-10-31'}).total,1);
});
test('AI 标注与原文分开，普通编辑保留作者；分段读取校验版本',async t=>{
 const {store,call,exec}=fixture(t),saved=store.save({kind:'journal',body:'我的原话'}),added=store.review().totals.added;
 const anchor=await call('shiwen_original_version',{id:saved.id});
 const args={originalId:saved.id,originalVersionId:anchor.versionId,originalContentHash:anchor.contentHash,body:'## AI 整理\n新的建议'};
 const annotation=await call('shiwen_annotation_create',args);assert.equal((await call('shiwen_annotation_create',args)).id,annotation.id);
 assert.equal(store.get(saved.id).body,'我的原话');assert.equal(store.review().totals.added,added);assert.equal(store.get(annotation.id).origin,'ai');
 const full=await call('shiwen_annotation_read',{id:annotation.id});assert.match(full.body,/## AI 整理/);assert.equal((await call('shiwen_annotation_list',{originalId:saved.id})).length,1);
 await call('shiwen_update',{id:saved.id,revision:saved.revision,body:'我的原话补充'},{...exec,callId:'original-edit'});
 assert.equal(store.get(saved.id).origin,'personal');await assert.rejects(()=>call('shiwen_read',{id:saved.id,offset:1,revision:saved.revision}),/更新/);
 const long=store.save({kind:'reference',body:'甲'.repeat(6100)});
 const first=await call('shiwen_read',{id:long.id});assert.equal(first.nextOffset,6000);
 const last=await call('shiwen_read',{id:long.id,offset:first.nextOffset,revision:first.revision});assert.equal(last.body.length,100);assert.equal(last.nextOffset,null);
});
test('日期更新参与收集统计；错误字段、取消和文章互转不留下半更新',async t=>{
 const {store,call,exec}=fixture(t),saved=store.save({kind:'idea',body:'需要整理的资料'});
 const updated=await call('shiwen_update',{id:saved.id,revision:saved.revision,kind:'reference',day:'2026-10-12'});
 const review=store.review({period:'month',month:'2026-10',now:'2026-11-05T00:00:00Z',timeZone:'Asia/Shanghai'});
 assert.equal(review.totals.collected,1);assert.equal(review.daily.find(d=>d.day==='2026-10-12').collected,1);
 for(const invalid of [{day:'2026-02-30'},{kind:'article'},{kind:'bad'},{stage:'final'},{origin:'invalid'},{sourceIds:['bad']}]){
  assert.throws(()=>store.updateRecord({id:saved.id,revision:updated.revision,title:'不应写入',...invalid}));
  assert.equal(store.get(saved.id).title,saved.title);assert.equal(store.get(saved.id).revision,updated.revision);
 }
 const abort=new AbortController();abort.abort();
 await assert.rejects(()=>call('shiwen_update',{id:saved.id,revision:updated.revision,title:'取消的修改'},{...exec,callId:'cancel',signal:abort.signal}));
 assert.equal(store.get(saved.id).revision,updated.revision);
 store.updateRecord({id:saved.id,revision:updated.revision,day:''});
 assert.equal(store.searchRecords({start:'2026-10-01',end:'2026-10-31'}).total,0);
 assert.equal(store.review({period:'month',month:'2026-10'}).totals.collected,0);
});
test('文章状态和关联更新，Agent 删除和撤销保持关联',async t=>{
 const {store,call,exec}=fixture(t),source=store.save({kind:'idea',body:'文章来源'}),article=store.save({kind:'article',body:'正文'});
 const result=await call('shiwen_update',{id:article.id,revision:article.revision,stage:'final',sourceIds:[source.id],annotation:'已核对'});
 assert.equal(result.stage,'final');assert.deepEqual(result.sourceIds,[source.id]);assert.equal(result.annotation,'已核对');
 const deleted=await call('shiwen_delete',{id:source.id,revision:source.revision});
 await assert.rejects(()=>call('shiwen_update',{id:source.id,revision:deleted.revision,title:'已删除'},{...exec,callId:'deleted'}),/已删除/);
 await assert.rejects(()=>call('shiwen_read',{id:source.id}),/不存在/);
 await call('shiwen_restore',{id:deleted.id,revision:deleted.revision});assert.equal(store.get(source.id).deleted,0);assert.deepEqual(store.get(article.id).sourceIds,[source.id]);
});
test('导入记录保留原件和元数据；统一 RPC 对日期也进行版本校验',async t=>{
 const {store}=fixture(t);
 const result=store.importWiki({root:'/synthetic/wiki',files:[],notes:[{path:'memo.md',sha256:'original-hash',kind:'reference',title:'原文',doc:plainDoc('# 原文','external'),origin:'external',url:'',day:'2026-10-01',data:'original-file',dateBasis:'原文日期',chars:2,metadata:{tags:['原始标签']},links:[],candidates:[],warnings:[]}]});
 const id=result.records['memo.md'],original=store.get(id),attachment=store.attachment({id:original.importInfo.metadata._import.originalAttachment});
 let route;workbench({shiwenLibrary:store,effect:fn=>fn(),connection:{fetch:{register:value=>{route=value;return()=>{};}}}});
 const rpc=async args=>{const r=await route.fetch(new Request('http://localhost/api/shiwen',{method:'POST',body:JSON.stringify({method:'updateRecord',args})}));return {status:r.status,...await r.json()};};
 const updated=await rpc({id,revision:original.revision,kind:'journal',day:'2026-10-20'});
 assert.equal(updated.status,200);assert.equal(updated.result.importInfo.day,'2026-10-20');assert.equal(updated.result.origin,'external');
 assert.deepEqual(updated.result.importInfo.metadata,original.importInfo.metadata);assert.equal(updated.result.importInfo.sha256,original.importInfo.sha256);
 assert.deepEqual(store.attachment({id:attachment.id}),attachment);
 assert.equal((await rpc({id,revision:original.revision,day:'2026-10-21'})).status,400);
 assert.equal(store.get(id).importInfo.day,'2026-10-20');
});
test('来源可纠正，原文和历史版本保留，改标签不凭空增加个人字数',async t=>{
 const {store,call,exec}=fixture(t);
 const saved=store.saveDsh({kind:'journal',body:'这是我的日记',origin:'ai',day:'2026-10-20',sessionId:'s',messageId:'m',role:'user',operationId:'source-test'});
 const args={period:'month',month:'2026-10',now:'2026-11-05T00:00:00Z'};
 assert.equal(store.review(args).totals.personalRecords,0);
 const corrected=await call('shiwen_correct_origin',{id:saved.id,revision:saved.revision,origin:'personal'});
 assert.equal(corrected.origin,'personal');assert.equal(store.get(saved.id).body,saved.body);
 assert.equal(readDoc(store.get(saved.id).doc).groups.personal,'这是我的日记');
 assert.equal(store.review(args).totals.personalRecords,1);assert.equal(store.review().totals.added,0);
 const versions=store.versions({id:saved.id});assert.equal(readDoc(versions[1].doc).groups.ai,'这是我的日记');assert.match(versions[0].reason,/ai → personal/);
 assert.equal(store.dshSources({id:saved.id})[0].message_id,'m');
 const second=await call('shiwen_correct_origin',{id:saved.id,revision:corrected.revision,origin:'external'},{...exec,callId:'correct-again'});
 await call('shiwen_update',{id:saved.id,revision:second.revision,body:'这是我的日记\n外部补充',url:'https://example.org/source'},{...exec,callId:'separate-edit'});
 const groups=readDoc(store.get(saved.id).doc).groups;assert.equal(groups.external,'这是我的日记');assert.equal(groups.personal,'外部补充');assert.equal(groups.ai,'');
 assert.equal(store.get(saved.id).origin,'external');
});
test('用户原话和排版稿归用户，网页原文归外部，实际归档者不决定作者',async t=>{
 const {store}=fixture(t),tools=new Map();
 const events=[{type:'user/message',data:{id:'u',source:{kind:'user'},content:[{type:'text',text:'今天散步很开心。请把这段话记录为我的日记，并收藏这篇文章。'}]}},{type:'assistant/message',data:{message:{id:'a',content:[{type:'text',text:'我生成的内容'}]}}}];
 apply({shiwenLibrary:store,sessionQuery:{observeSession:async()=>({events,[Symbol.dispose](){}})},effect:fn=>fn(),tools:{register:tool=>{tools.set(tool.name,tool);return()=>{};}},systemPrompt:{section:()=>()=>{}}});
 const exec={agent:{session:{id:'session'}},signal:new AbortController().signal,callId:'original'};
 const call=(name,args,callId)=>tools.get(name).execute(args,{...exec,callId});
 const original=await call('shiwen_save',{kind:'journal',sourceMessageId:'u',mode:'original'},'original');assert.equal(original.origin,'personal');
 const formatted=await call('shiwen_save',{kind:'journal',sourceMessageId:'u',mode:'organized',origin:'personal',body:'# 今天\n今天散步很开心。'},'formatted');assert.equal(formatted.origin,'personal');
 const ai=await call('shiwen_save',{kind:'idea',sourceMessageId:'u',mode:'organized',body:'AI 提出的新观点'},'ai');assert.equal(ai.origin,'ai');
 const external=await call('shiwen_collect',{requestMessageId:'u',title:'网页原文',url:'https://example.org/article',body:'# 网络文章\n外部作者的原文。'},'collect');
 assert.equal(external.origin,'external');assert.equal(external.kind,'web');assert.equal(external.url,'https://example.org/article');
 assert.equal(readDoc(store.get(external.id).doc).groups.external,'# 网络文章外部作者的原文。');
 assert.equal(store.dshSources({id:external.id})[0].excerpt,events[0].data.content[0].text);
 assert.equal((await call('shiwen_collect',{requestMessageId:'u',title:'网页原文',url:'https://example.org/article',body:'# 网络文章\n外部作者的原文。'},'collect')).id,external.id);
 await assert.rejects(()=>call('shiwen_collect',{requestMessageId:'missing',url:'https://example.org',title:'标题',body:'正文'},'bad'),/用户消息/);
 await assert.rejects(()=>call('shiwen_collect',{requestMessageId:'u',url:'file:///private',title:'标题',body:'正文'},'bad-url'),/HTTP/);
 assert.equal(formatted.id,original.id);assert.equal(store.snapshot().records.length,3);
});
