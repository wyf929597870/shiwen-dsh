import {insertLegacyCard} from './support/legacy-recommendation.mjs';
import test from 'node:test';
import {scenarios} from './support/recommendation-scenarios.mjs';
import {encodeReadingNote} from '../plugins/library/legacy/reading-note.mjs';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {plainDoc} from '../plugins/library/legacy/content.mjs';
import {createStore} from '../plugins/library/legacy/store.mjs';
import {analyze,passages,resolveQuote} from '../plugins/library/src/assist/evidence.mjs';

const id=randomUUID;
function fixture(t){
 const dir=mkdtempSync(join(tmpdir(),'shiwen-assist-')),store=createStore(join(dir,'library.sqlite'));
 t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
 const context={expectedLibraryId:store.themeContext().libraryId};
 const desk=(name,args={})=>store.assist.call('shiwen_'+name,args);
 function client(scopes){
  const cred=store.externalClientCreate({name:'测试助手',scopes}),identity=store.externalAuthenticate(cred.token);
  return (name,args)=>store.externalCall(identity,'shiwen_'+name,args);
 }
 return {store,desk,context,client,path:join(dir,'library.sqlite')};
}
async function wait(call,job){
 for(let n=0;n<100;n++){const r=await call('assist_result',job);if(r.status==='ready')return r.result;if(r.status==='failed')throw Error(r.message);await new Promise(resolve=>setTimeout(resolve,5));}
 throw Error('任务未结束');
}
function model(_,input){
 const p=JSON.parse(input),matched=p.passages.find(q=>q.record===p.seed)||p.passages[0];
 return JSON.stringify([{scene:'writing',type:'writing',addsEvidence:true,question:matched.title+'，我为什么改了开头？',reason:'这段记录解释了删掉开头的原因。',followup:'读者在哪一句停下？',refs:[matched.n]}]);
}
test('历史推荐卡仍可读取、保存、关联和撤销反馈',async t=>{
 const {store,desk,context,client,path}=fixture(t),ext=client(['read','create','update']),reader=client(['read']);
 const read=id=>ext('recommendation_read',{...context,cardId:id});
 const source=store.save({kind:'idea',origin:'personal',title:'改稿记录',body:'编辑时，我删掉了前三段，直接从例子开始。'});
 const old=insertLegacyCard(path,store,source);
 const list=()=>ext('recommendation_list',{view:'week'}).items;
 assert.throws(()=>reader('recommendation_settings',{...context,enabled:true,revision:1,requestId:id()}),e=>e.code==='permission_denied');
 let card=read(old.cardId);
 const ref=()=>({...context,cardId:card.cardId,cardRevision:card.cardRevision,requestId:id()});
 const quoteIds=card.quotes.map(q=>q.quoteId);
 const q=card.quotes[0],src=reader('read',{id:q.recordId,revision:q.sourceRevision});assert.equal(src.body.slice(q.start,q.end),q.text);
 const decision={...ref(),body:'我决定先给读者看例子。',day:'2026-11-24'};
 const receipt=desk('assist_save_decision',decision);
 assert.deepEqual(desk('assist_save_decision',decision),receipt);assert.equal(store.get(receipt.recordId).contentDay,decision.day);
 card=read(card.cardId);assert.equal(card.targets.decisions[0].id,receipt.recordId);
 const attach=ext('assist_add_to_theme',{...ref(),newThemeTitle:'写作实验',quoteIds});
 assert.equal(attach.items[0].status,'added');card=read(card.cardId);
 const same=desk('assist_add_to_theme',{...ref(),themeId:attach.themeId,themeRevision:attach.themeRevision,quoteIds});assert.equal(same.items[0].status,'already_present');
 assert.equal(ext('theme_read',{...context,themeId:attach.themeId}).items[0].id,attach.items[0].memberId);card=read(card.cardId);
 const draft=ext('assist_create_draft',{...ref(),mode:'first',quoteIds,title:card.question});card=read(card.cardId);
 assert.equal(desk('assist_create_draft',{...ref(),mode:'first',quoteIds,title:card.question}).status,'existing');
 const other=desk('assist_create_draft',{...ref(),mode:'another',quoteIds,title:'另一种开头'});assert.notEqual(other.articleId,draft.articleId);card=read(card.cardId);
 assert.deepEqual(store.get(draft.articleId).sourceIds,[q.recordId]);assert.equal(card.targets.drafts.length,2);
 const act=(action,args={})=>{const result=ext('recommendation_feedback',{...ref(),action,...args});card=read(card.cardId);return result;};
 act('save_later');assert.equal(desk('recommendation_list',{view:'later'}).items.length,1);
 act('remove_later');assert.equal(desk('recommendation_list',{view:'later'}).items.length,0);
 const rel=card.relations[0],reject=act('reject_relation',{relationId:rel.relationId,quoteIds:rel.quoteIds,reason:'不是同一个项目'});
 const skip=act('skip');assert.ok(!list().some(c=>c.cardId===card.cardId));
 const history=desk('recommendation_feedback_list',context);assert.equal(history.items.length,2);
 act('undo',{feedbackId:skip.feedbackId});assert.equal(card.relations.length,0);
 act('undo',{feedbackId:reject.feedbackId});assert.equal(card.relations.length,1);assert.ok(!list().some(c=>c.cardId===card.cardId));
 assert.throws(()=>desk('assist_create_draft',{...ref(),cardRevision:1,mode:'another',title:'冲突',quoteIds}),e=>e.code==='revision_conflict');
 assert.throws(()=>read('missing'),e=>e.code==='card_missing');
});
test('模型失败保留候选；选区、来源归属、任务身份和引用变更均校验',async t=>{
 const {store,desk,context,client}=fixture(t),reader=client(['read']);
 const r=store.save({kind:'idea',origin:'personal',title:'如何改稿',body:'我在第一次改稿时去掉了开场白。'});
 const args={...context,scene:'writing',question:'改稿',callId:id(),mode:'analyze'};
 const result=desk('assist_analyze',args);
 assert.throws(()=>reader('assist_result',result),e=>e.code==='result_expired');
 const fallback=await wait(desk,result);assert.ok(fallback.modelError);assert.equal(fallback.candidates[0].recordId,r.id);
 store.generateAssist=()=>JSON.stringify([{type:'writing',question:'凭空的问题',reason:'错引',refs:[99]}]);
 assert.equal((await analyze(store,args)).items.length,0);
 store.generateAssist=model;const manual=(await wait(desk,desk('assist_analyze',{...args,callId:id()}))).items[0];
 const payload={...context,resultId:manual.resultId,resultVersion:manual.resultVersion,requestId:id(),mode:'first',title:'检查引文',quoteIds:manual.quotes.map(q=>q.quoteId)};
 assert.throws(()=>client(['read','create'])('assist_create_draft',payload),e=>e.code==='result_expired');
 const quote=passages(store.get(r.id))[0];store.save({id:r.id,revision:r.revision,doc:plainDoc('已经替换成另一个例子。','personal')});assert.equal(resolveQuote(store,quote),null);
 assert.throws(()=>desk('assist_create_draft',payload),e=>e.code==='source_changed');
});
test('书摘和整篇感想、重复句及内容日期的归属',async t=>{
 const {store,context,client}=fixture(t),external=client(['create','read']);
 const {id:noteId}=external('save',{requestId:id(),kind:'reading_note',origin:'personal',title:'观察读者',body:'我不同意把沉默当作认同。',readingNote:{chapter:'观察',excerpts:[{page:'2',text:'观察读者在哪一步停下。'}]}});
 const ask={scene:'reading',question:'读者',mode:'analyze'};
 store.generateAssist=(_,raw)=>{const {passages}=JSON.parse(raw);return JSON.stringify([{type:'reading',question:'如何观察读者？',reason:'书摘提供了一种观察方法。',refs:[passages.find(x=>x.field==='excerpt').n]}]);};
 const a=await analyze(store,ask);assert.equal(a.items.length,1);const quote=a.items[0].quotes[0];assert.equal(quote.recordId,noteId);assert.equal(quote.origin,'external');assert.equal(quote.page,'2');
 store.generateAssist=()=>JSON.stringify([{type:'outcome',question:'后来呢？',reason:'错引书中内容',refs:[1]}]);
 assert.equal((await analyze(store,{...ask,scene:'experience'})).items.length,0);
 const row=store.save({kind:'idea',origin:'personal',body:'先看一段原文。然后换个角度。先看一段原文。'});
 const repeated=passages(store.get(row.id)).filter(x=>x.text==='先看一段原文。');assert.equal(repeated.length,2);assert.notEqual(repeated[0].start,repeated[1].start);
 assert.throws(()=>store.assist.call('shiwen_assist_analyze',{...context,expectedLibraryId:'another',callId:id(),scene:'writing'}),e=>e.code==='library_changed');
});
for(const scenario of scenarios)test('原文关系夹具 / '+scenario.name,async t=>{
 const {store,client}=fixture(t),ext=client(['read','create']);
 const relevant=[];
 for(const {excerpts,...row} of scenario.rows){
  const saved=excerpts?store.save({kind:row.kind,origin:row.origin,title:row.title,body:row.body,annotation:encodeReadingNote({chapter:'第一章',excerpts})}):ext('save',{...row,requestId:id()});
  if(row.title!=='周末日记')relevant.push(saved.id);
 }
 // A deterministic recall adapter covers paraphrases without downloading a model in CI.
 store.contentSearch={status:()=>({canSearchSemantic:true}),search:async()=>({items:relevant.map(recordId=>({recordId}))})};
 store.generateAssist=(_,input)=>{
  const data=JSON.parse(input);if(data.earlier)return JSON.stringify({sameEvent:true,earlier:data.earlier.text,later:data.later.text});
  const {passages}=data;
  const refs=scenario.wanted.map(fragment=>passages.find(q=>q.text.includes(fragment))?.n);
  assert.ok(refs.every(Number.isInteger));
  return JSON.stringify(scenario.type?[{question:scenario.question,reason:'根据选中的测试引文作出判断。',type:scenario.type,refs,followup:'当时具体发生了什么？'}]:[]);
 };
 for(let round=0;round<2;round++){
  const r=await analyze(store,{scene:scenario.scene,question:scenario.question});
  assert.equal(r.modelError,undefined);assert.equal(r.retrieval,'semantic');assert.equal(r.items.length,scenario.type?1:0);
  if(!scenario.type)continue;
  const item=r.items[0];assert.equal(item.relations[0].type,scenario.type);
  assert.ok(item.quotes.every(q=>relevant.includes(q.recordId)&&resolveQuote(store,q)));
  if(scenario.name.includes('整篇')){assert.equal(item.quotes[0].excerptIndex,1);assert.equal(item.quotes[1].sharedReflection,true);}
 }
});
