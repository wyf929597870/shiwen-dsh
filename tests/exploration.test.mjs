import {plainDoc} from '../plugins/library/legacy/content.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createStore} from '../plugins/library/legacy/store.mjs';
import {periodKeys} from '../plugins/library/src/exploration/rules.mjs';

function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'shiwen-exploration-')),path=join(root,'library.sqlite');
 const store=createStore(path);t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
 const library={expectedLibraryId:store.themeContext().libraryId};
 const agent=store.externalClientCreate({name:'测试外部来源',scopes:['read','create','update']});
 const call=(method,args)=>store.externalCall(agent,'shiwen_'+method,args);
 const write=(method,args)=>call('exploration_'+method,{...library,requestId:randomUUID(),...args});
 const suggest=(text,sources,extra={})=>write('suggest',{suggestions:[{externalItemId:randomUUID(),type:'explore',text,sources,...extra}]}).items[0];
 const list=(view,extra={})=>call('exploration_list',{...library,view,...extra}).items;
 const read=questionId=>call('exploration_read',{...library,questionId});
 const review=(q,action,extra={})=>write('review',{questionId:q.questionId,expectedRevision:q.revision,action,...extra});
 const place=(q,period,action='pin',extra={})=>write('place',{questionId:q.questionId,expectedRevision:q.revision,
   period,action,periodKey:q.placements[period].key,expectedPlacementRevision:q.placements[period].revision,...extra});
 const record=body=>{const r=store.save({kind:'freewrite',origin:'personal',body});return {recordId:r.id,revision:r.revision};};
 const feed=view=>call('recommendation_list',{view}).items;
 const refresh=()=>call('recommendation_refresh',{...library,requestId:randomUUID()});
 const enable=()=>call('recommendation_settings',{...library,revision:1,requestId:randomUUID(),enabled:true});
 return {store,root,path,library,call,write,suggest,list,read,review,place,record,feed,refresh,enable};
}
test('MCP 原始池、人工排期、离开再开和撤卡；首页不检索正文或调用模型',t=>{
 const f=fixture(t),source=f.record('我写下🙂一句话。');
 const {questionId}=f.suggest('接下来要做什么？',[{...source,quote:'🙂一句话'}]);
 assert.equal(f.list('raw')[0].sources[0].start,3);
 assert.equal(f.feed('daily').length,0);
 f.place(f.read(questionId),'day','pin',{accept:true});f.place(f.read(questionId),'week');
 assert.equal(f.feed('daily')[0].questionId,questionId);assert.equal(f.feed('week')[0].alsoToday,true);
 f.place(f.read(questionId),'week','unpin');assert.equal(f.feed('week').length,0);assert.equal(f.feed('daily').length,1);
 f.enable();
 for(const method of ['generateAssist','get','searchSnapshot'])f.store[method]=()=>assert.fail('首页调用 '+method);
 f.refresh();assert.equal(f.feed('week').length,1);
 const backup=f.store.exportBackup();const restored=createStore(join(f.root,'restored.sqlite'));
 try{
  restored.restoreBackup(backup);
  assert.equal(restored.exploration.call('shiwen_exploration_read',{expectedLibraryId:restored.themeContext().libraryId,questionId}).status,'accepted');
 }finally{restored.close();}
 f.review(f.read(questionId),'skip');assert.deepEqual(f.feed('week'),[]);assert.deepEqual(f.feed('daily'),[]);
 assert.equal(f.review(f.read(questionId),'restore').status,'accepted');
});
test('多来源换序、用户问法、重试、批量内次要来源过期',t=>{
 const f=fixture(t),a=f.record('A 原文'),b=f.record('B 原文'),c=f.record('C 原文');
 const suggestion=(id,text,sources)=>({externalItemId:id,type:'explore',text,sources});
 const both=suggestion('ab','问题 1',[a,b]),first={...f.library,requestId:'batch',suggestions:[both,suggestion('c','问题 2',[c])]};
 f.store.save({id:b.recordId,revision:b.revision,doc:plainDoc('修改后的 B','personal')});
 const result=f.call('exploration_suggest',first);
 assert.deepEqual(result.items[0],{externalItemId:'ab',status:'source_changed',recordIds:[b.recordId]});
 assert.equal(result.items[1].status,'created');assert.equal(f.list('all').length,1);
 assert.deepEqual(f.call('exploration_suggest',first),result);
 assert.throws(()=>f.call('exploration_suggest',{...first,suggestions:[both]}),e=>e.code==='request_conflict');
 const updated={...b,revision:b.revision+1},q=f.suggest('问题 1',[a,updated],{externalItemId:'ab'});
 f.review(f.read(q.questionId),'rewrite',{text:'我的问法'});
 const again=f.suggest('问题 1',[updated,a]);assert.equal(again.status,'existing');assert.equal(again.questionId,q.questionId);
 assert.deepEqual(again.sources.map(s=>s.recordId),[b.recordId,a.recordId]);
 assert.equal(f.read(q.questionId).sources.length,2);assert.equal(f.read(q.questionId).text,'我的问法');
});
test('整篇、重复书摘和感想、个人归属与严格随附导入',t=>{
 const f=fixture(t);
 const r=f.call('save',{requestId:'reading',title:'测试书',kind:'reading_note',origin:'personal',body:'同一句🙂',readingNote:{excerpts:[{text:'同一句🙂'}]}});
 const source={recordId:r.id,revision:r.revision};
 for(const [i,extra] of [{},{quote:'同一句🙂'},{quote:'同一句🙂',field:'excerpt'},{quote:'同一句🙂',field:'reflection'}].entries()){
  const q=f.suggest('提问 '+i,[{...source,...extra}]);assert.equal(q.status,'created');
  assert.equal(q.sources[0].scope,i<2?'record':'passage');
  assert.equal(q.sources[0].label,['来自这篇笔记','来自这篇笔记','书中原文','我的原句'][i]);
  f.review(f.read(q.questionId),'accept');
 }
 f.enable();f.refresh();assert.equal(f.feed('week').length,1);
 const mixed=f.list('accepted').find(q=>q.text==='提问 0');
 f.review(mixed,'confirm_personal_context',{recordId:r.id,sourceRevision:r.revision});f.refresh();assert.equal(f.feed('week').length,2);
 const input={kind:'idea',origin:'personal',body:'随记录附建议',requireSuggestions:true};
 assert.throws(()=>f.call('save',{...input,requestId:'strict'}),e=>e.code==='suggestions_required');
 const raw={externalItemId:'attached',type:'follow_up',text:'后来怎样了？'};
 const ok=f.call('save',{...input,suggestions:[raw],requestId:'save'});assert.equal(ok.items[0].sources[0].recordId,ok.id);
 const deferred=f.call('save',{...input,requireSuggestions:false,requestId:'unmapped',suggestions:[{...raw,externalItemId:'outside',sources:[{externalSourceId:'other'}]}]});
 assert.equal(deferred.items[0].reason,'source_unmapped');assert.equal(f.list('reviews').length,1);
 const user=f.store.externalClientCreate({name:'仅创建',scopes:['create']});
 assert.ok(!f.store.externalCatalog(user).some(tool=>tool.name==='shiwen_exploration_suggest'));
 assert.throws(()=>f.store.externalCall(user,'shiwen_save',{...input,requestId:'denied',suggestions:[raw]}),e=>e.code==='permission_denied');
});
test('安排 4→7，回应重试保留原文，来源部分和全部失效',t=>{
 const f=fixture(t),a=f.record('甲记录'),b=f.record('乙记录');
 function accept(i){const item=f.suggest('第 '+i+' 问',[a,b]);return f.review(f.read(item.questionId),'accept');}
 const q=accept(0);for(let i=1;i<4;i++)accept(i);
 f.enable();f.refresh();const first=f.feed('week').map(q=>q.cardId);assert.equal(first.length,4);
 for(let i=4;i<12;i++)accept(i);
 f.refresh();const second=f.feed('week');assert.equal(second.length,7);assert.deepEqual(second.slice(0,4).map(q=>q.cardId),first);
 f.refresh();assert.equal(f.feed('week').length,8);
 const args={...f.library,requestId:'respond',questionId:q.questionId,expectedRevision:q.revision,responseRecordId:randomUUID(),body:'  我写的回应。\n'};
 const r=f.call('exploration_respond',args);assert.deepEqual(f.call('exploration_respond',args),r);
 assert.equal(r.responses.length,1);assert.equal(f.call('read',{id:args.responseRecordId}).body,args.body);assert.equal(r.status,'accepted');
 f.place(f.read(q.questionId),'day');f.store.remove({id:a.recordId,revision:a.revision});
 assert.deepEqual(f.feed('daily')[0].sources.map(s=>s.recordId),[b.recordId]);
 f.store.remove({id:b.recordId,revision:b.revision});assert.deepEqual(f.feed('daily'),[]);assert.deepEqual(f.feed('week'),[]);
});
test('库本地日期在周一午夜切换',()=>{
 assert.deepEqual(periodKeys(new Date('2026-11-22T15:59:59Z'),'Asia/Shanghai'),{day:'2026-11-22',week:'2026-11-16'});
 assert.deepEqual(periodKeys(new Date('2026-11-22T16:00:00Z'),'Asia/Shanghai'),{day:'2026-11-23',week:'2026-11-23'});
});
test('来源核对保留原回执，旧库与来源版本不能串用',t=>{
 const f=fixture(t),source=f.record('原始的个人感想');
 const item={externalItemId:'foreign',text:'后来还有什么想法？',type:'follow_up',sources:[{externalSourceId:'other-system-7'}]};
 const payload={...f.library,requestId:'unmapped',kind:'idea',body:'随附正文',origin:'personal',suggestions:[item]};
 const saved=f.call('save',payload),reviewItemId=saved.items[0].reviewItemId;
 const read=()=>f.call('exploration_read',{...f.library,reviewItemId});
 const resolve={...f.library,requestId:'resolve',reviewItemId,expectedReviewRevision:read().revision,action:'resolve_source',
   mappings:[{externalSourceId:'other-system-7',...source}]};
 assert.throws(()=>f.call('exploration_review',{...resolve,expectedLibraryId:'other-lib'}),e=>e.code==='library_changed');
 const linked=f.call('exploration_review',resolve);assert.equal(linked.status,'created');
 assert.equal(read().resolution.questionId,linked.questionId);assert.equal(f.list('reviews').length,0);
 assert.deepEqual(f.call('save',payload),saved);assert.deepEqual(f.call('exploration_review',resolve),linked);
 assert.equal(f.read(linked.questionId).status,'pending');
 const repeat=f.call('save',{...payload,requestId:'later'});assert.equal(repeat.items[0].status,'existing');
});
test('同一旧库的两个并发写连接只建一题，两端的发现分别可追溯',async t=>{
 const {Worker}=await import('node:worker_threads');
 const f=fixture(t),a=f.record('两位分析者看到同一段'),b=f.record('还有第二个来源');
 const gate=new SharedArrayBuffer(4);
 const launch=(actor,sources)=>new Promise((resolve,reject)=>{
  const worker=new Worker(`
   const {parentPort,workerData:d}=require('node:worker_threads');
   (async()=>{
    const {createStore}=await import(d.module);
    const s=createStore(d.path,{recover:false});
    try{
     parentPort.postMessage('ready');const flag=new Int32Array(d.gate);
     Atomics.wait(flag,0,0,10000);
     parentPort.postMessage(s.exploration.call('shiwen_exploration_suggest',d.input,d.actor).items[0]);
    }finally{s.close();}
   })().catch(e=>{throw e;});
  `,{eval:true,workerData:{gate,path:f.path,actor,module:new URL('../plugins/library/legacy/store.mjs',import.meta.url).href,
    input:{...f.library,requestId:'same-local-id',suggestions:[{externalItemId:'discovery',type:'explore',text:'同一个问题？',sources}]}}});
  worker.on('message',value=>{
   if(value==='ready'){if(++ready===2){const flag=new Int32Array(gate);Atomics.store(flag,0,1);Atomics.notify(flag,0);}}
   else resolve(value);
  });
  worker.on('error',reject);worker.on('exit',code=>{if(code)reject(Error('worker exit '+code));});
 });
 let ready=0;
 const [one,two]=await Promise.all([launch('writer-a',[a,b]),launch('writer-b',[b,a])]);
 assert.deepEqual([one.status,two.status].sort(),['created','existing']);assert.equal(one.questionId,two.questionId);
 assert.equal(f.read(one.questionId).sources.length,2);
 const tables=JSON.parse(f.store.exportBackup()).payload.tables;
 assert.equal(tables.exploration_discoveries.length,2);assert.equal(tables.exploration_questions.length,1);
});

test('近义发现分别保留，合并后新增回应仍属于写入目标，撤销恢复归属',t=>{
 const f=fixture(t),a=f.record('今天我试着重新开始阅读。'),b=f.record('我保留了中断时的那一页。');
 const q=f.suggest('怎样在中断之后继续阅读？',[a,b]).questionId;
 f.review(f.read(q),'rewrite',{text:'下次我如何接着读？'});
 const other=f.suggest('怎样在中断之后恢复阅读？',[b]).questionId;
 const match=f.read(other).possibleDuplicates[0];
 assert.equal(match.questionId,q);
 f.review(f.read(other),'keep_separate',{targetQuestionId:q,expectedTargetRevision:match.revision,evidenceFingerprint:match.evidenceFingerprint});
 assert.equal(f.suggest('怎样在中断之后恢复阅读？',[b]).questionId,other);
 assert.deepEqual(f.read(other).possibleDuplicates,[]);
 const merged=f.review(f.read(other),'merge',{targetQuestionId:q,expectedTargetRevision:f.read(q).revision});
 assert.equal(merged.questionId,q);assert.equal(f.read(other).text,'下次我如何接着读？');
 const reply=f.write('respond',{questionId:q,expectedRevision:merged.revision,responseRecordId:randomUUID(),body:'我给自己留了一张书签。'});
 const old=reply.mergedQuestions.find(m=>m.questionId===other);
 f.write('review',{questionId:other,expectedRevision:old.revision,targetQuestionId:q,expectedTargetRevision:reply.revision,decisionId:old.decisionId,action:'undo_merge'});
 assert.equal(f.read(q).responses.length,1);assert.equal(f.read(other).responses.length,0);
 assert.equal(f.read(other).status,'pending');assert.equal(f.read(q).text,'下次我如何接着读？');
});

async function waitJob(f,id){
 for(let n=0;n<500;n++){
  const job=f.call('assist_result',{jobId:id});
  if(job.status!=='pending')return job;
  await new Promise(ok=>setTimeout(ok,5));
 }
 assert.fail('后台扫描没有完成');
}
test('历史批注和外部引文归入同题；排除正文示例和代码块，重复整理沿用取舍',async t=>{
 const f=fixture(t),a=f.record('我留在原地。'),text='为何“留在原地”让我安心？';
 f.record('这只是使用示例。\n## 待探索\n- 错误的问题');
 const ann=f.store.annotationCreate({originalId:a.recordId,originalVersionId:f.store.originalVersionInfo({id:a.recordId}).versionId,
  body:'## 待探索\n- '+text+'\n\n## 其他\n- 不属于问题。',requestId:'annotation'});
 const input=f.suggest(text,[{...a,quote:'留在原地'}]);f.review(f.read(input.questionId),'skip');
 const first=f.write('import',{mode:'history'}),second=f.write('import',{mode:'history'});
 assert.equal(first.jobId,second.jobId);assert.equal((await waitJob(f,first.jobId)).status,'ready');
 assert.equal(f.list('all').length,1);assert.equal(f.read(input.questionId).sources.length,1);
 assert.equal(f.list('skipped').length,1);assert.equal(f.list('raw').length,0);
 f.store.annotationDelete({id:ann.id,revision:ann.revision,requestId:'delete'});
 assert.equal(f.read(input.questionId).sources.length,1);
});
test('模型等待中原文被删除，后到的候选不写入，后续材料继续处理',async t=>{
 const f=fixture(t),a=f.record('第一篇个人原文');
 let entered,release;const seen=new Promise(ok=>entered=ok),paused=new Promise(ok=>release=ok);
 f.store.generateAssist=async(_prompt,input)=>{
  if(input.includes('第一篇个人原文')){entered();await paused;return JSON.stringify([{type:'explore',text:'已删除的问题？',quote:'第一篇个人原文'}]);}
  return JSON.stringify([{type:'follow_up',text:'后来开始了吗？',quote:'第二篇个人原文'}]);
 };
 f.record('第二篇个人原文');f.write('settings',{expectedRevision:1,model:true});
 const job=f.write('import',{mode:'incremental'});
 await Promise.race([seen,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('模型未被调用')),3000);timer.unref();})]);
 f.store.remove({id:a.recordId,revision:a.revision});release();
 assert.equal((await waitJob(f,job.jobId)).status,'ready');
 assert.deepEqual(f.list('all').map(q=>q.text),['后来开始了吗？']);assert.deepEqual(f.feed('daily'),[]);
});

test('绑定独立切点、双通道的未知／未提交／已提交回执、合并后冲突解决和旧批次',async t=>{
 const {createMobileSyncAdapter}=await import('../plugins/mobile/src/sync-adapter.mjs');
 const {fingerprint,contentHash}=await import('../plugins/library/src/sync/canonical.mjs');
 const f=fixture(t),a=f.record('阅读是个人习惯。'),b=f.record('今天也想继续阅读。');
 f.store.paths={library:f.root};
 const adapter=createMobileSyncAdapter({ctx:{connection:{browserPeer:{id:'owner'}}},library:f.store});t.after(()=>adapter.close());
 const deviceId=randomUUID(),identity=adapter.identity({deviceId,protocolVersion:'1.0.0-draft.3'});
 const scope={deviceId,libraryId:identity.libraryId,serverId:identity.serverId,epoch:identity.epoch};
 const send=(action,args={})=>adapter.execute(action,{...scope,...args});
 scope.coverage=(await send('explorationCapabilities')).coverage;
 const q=f.suggest('怎样继续阅读？',[a,b]).questionId;
 f.place(f.read(q),'day','pin',{accept:true});
 const old=await send('explorationBegin');
 f.store.remove({id:a.recordId,revision:a.revision});
 const frozen=await send('explorationPage',{snapshotId:old.snapshotId});
 assert.equal(fingerprint(frozen.items),old.digest);
 for(const [entity,manifest] of Object.entries(old.entities)){
  const rows=frozen.items.filter(item=>item.entity===entity);
  assert.deepEqual(manifest,{count:rows.length,digest:fingerprint(rows)});
 }
 const newer=await send('explorationChanges',{cursor:old.highWatermark});
 assert.ok(newer.events.some(e=>e.entity==='source_state'&&e.key[0]===a.recordId&&e.value.deleted));
 assert.deepEqual(f.feed('daily')[0].sources.map(s=>s.recordId),[b.recordId]);
 const target=f.suggest('怎样继续阅读下去？',[b]).questionId;
 f.review(f.read(target),'accept');
 const original=f.read(q),conflicted={method:'shiwen_exploration_review',args:{...f.library,requestId:randomUUID(),questionId:q,expectedRevision:original.revision,action:'skip'}};
 f.review(original,'merge',{targetQuestionId:target,expectedTargetRevision:f.read(target).revision});
 const proofArgs=(channel,op,id)=>({channel,operationId:id,fingerprint:fingerprint(op)});
 const submits={record:0,exploration:0};
 async function transmit(op){
  const p=proofArgs('exploration',op,op.args.requestId);
  assert.equal((await send('explorationProof',p)).status,'unknown');
  assert.equal((await send('explorationReserve',p)).status,'not_committed');
  submits.exploration++;await send('explorationSubmit',{...p,operation:op});
  // The caller loses the submit reply. Reconnect through the proof endpoint.
  const recovered=await send('explorationProof',p);
  assert.equal(recovered.status,'committed');
  await assert.rejects(send('explorationProof',{...p,fingerprint:'modified'}),/OPERATION_REUSED/);
  return {p,receipt:recovered.receipt};
 }
 const conflict=await transmit(conflicted);
 assert.equal(conflict.receipt.status,'conflict');assert.equal(conflict.receipt.targetText,f.read(target).text);
 const response=randomUUID(),changeId=randomUUID(),timestamp=new Date().toISOString(),markdown='我读完了之前搁置的章节。';
 const sources=[{origin:'personal',text:markdown}];
 const payload={id:response,kind:'freewrite',title:'后来',markdown,origin:'personal',processing:'original',contentDay:null,dateBasis:'created',
  url:'',annotation:'',stage:'draft',sourceIds:[],sources,attachmentDescriptors:[],createdAt:timestamp,updatedAt:timestamp,deleted:false,createdByDevice:deviceId};
 const activity={activityId:randomUUID(),recordId:response,changeId,originDeviceId:deviceId,occurredAt:timestamp,timeZone:'UTC',
  beforeHash:contentHash('',[]),afterHash:contentHash(markdown,sources),afterSegments:sources,action:'write',authorship:'personal'};
 const body={operationId:randomUUID(),recordId:response,changeId,versionId:randomUUID(),baseVersionId:null,parentVersionIds:[],originDeviceId:deviceId,
  action:'create',baseRevision:null,localGeneration:1,occurredAt:timestamp,timeZone:'UTC',payload,activities:[activity]};
 const p=proofArgs('record',body,body.operationId);
 assert.equal((await send('explorationProof',p)).status,'unknown');
 assert.equal((await send('explorationReserve',p)).status,'not_committed');
 submits.record++;await send('push',{operations:[{inlineBody:body}]});
 assert.equal((await send('explorationProof',p)).receipt.status,'applied');
 const linked=await transmit({method:'shiwen_exploration_respond',args:{...f.library,requestId:randomUUID(),questionId:q,expectedRevision:original.revision,responseRecordId:response,sourceRevision:1}});
 assert.equal(linked.receipt.status,'applied');assert.equal(f.read(target).responses[0].recordId,response);
 const choice={...conflict.p,choice:'abandon',conflictId:conflict.receipt.conflictId};
 const resolved=await send('explorationResolve',choice);
 assert.deepEqual(await send('explorationResolve',choice),resolved);
 assert.equal(resolved.status,'resolved');assert.equal(f.read(target).status,'accepted');
 assert.deepEqual(submits,{record:1,exploration:2});
 await assert.rejects(send('explorationProof',{...p,coverage:'other'}),/COVERAGE_REQUIRED/);
});

test('扫描超过领取期限后重开资料库，同一任务重领，迟到结果不覆盖新版本',async t=>{
 const {default:Database}=await import('../plugins/library/legacy/sqlite.mjs');
 const path=join(mkdtempSync(join(tmpdir(),'shiwen-explore-lease-')),'library.sqlite');
 const {dirname}=await import('node:path');t.after(()=>rmSync(dirname(path),{recursive:true,force:true}));
 const first=createStore(path),libraryId=first.themeContext().libraryId;
 let unblock,signal;const inFlight=new Promise(ok=>signal=ok),late=new Promise(ok=>unblock=ok);
 first.generateAssist=async()=>{signal();await late;return '[{"type":"explore","text":"过时建议","quote":"旧版个人材料"}]';};
 const original=first.save({kind:'idea',body:'旧版个人材料',origin:'personal'});
 first.exploration.call('shiwen_exploration_settings',{expectedLibraryId:libraryId,expectedRevision:1,requestId:'enable',model:true});
 const start=s=>s.exploration.call('shiwen_exploration_import',{expectedLibraryId:libraryId,requestId:randomUUID(),mode:'incremental'}).jobId;
 const job=start(first);await inFlight;
 first.save({id:original.id,revision:original.revision,doc:plainDoc('新的个人材料','personal')});first.close();
 const sql=new Database(path);sql.prepare("UPDATE exploration_work SET expires=0 WHERE state='leased'").run();sql.close();
 const reopened=createStore(path);t.after(()=>reopened.close());
 let analyzed;reopened.generateAssist=async(_prompt,input)=>{analyzed=JSON.parse(input).personal;return JSON.stringify([{type:'explore',text:'新版本的问题',quote:'新的个人材料'}]);};
 assert.equal(start(reopened),job);
 unblock();
 const wait=id=>waitJob({call:(_method,args)=>reopened.exploration.discovery.result(args.jobId,'desktop')},id);
 const oldDone=await wait(job),nextDone=await wait(start(reopened));
 assert.equal(oldDone.status,'ready');assert.equal(nextDone.status,'ready');assert.equal(analyzed,'新的个人材料');
 const all=reopened.exploration.call('shiwen_exploration_list',{expectedLibraryId:libraryId,view:'all'}).items;
 assert.deepEqual(all.map(x=>x.text),['新版本的问题']);assert.equal(all[0].sources[0].revision,original.revision+1);
});

test('关联回应的逐字选段绑定到原版本；正文修改后只显示整篇关联',t=>{
 const f=fixture(t),a=f.record('昨天我开始写稿。'),r=f.record('周六我把稿子交给了朋友。');
 const q=f.suggest('稿子后来交出去了吗？',[a]).questionId;
 const args={questionId:q,expectedRevision:f.read(q).revision,responseRecordId:r.recordId,sourceRevision:r.revision};
 assert.throws(()=>f.write('respond',{...args,passage:{...r,quote:'不存在'}}),/原句/);
 const response=f.write('respond',{...args,passage:{...r,quote:'交给了朋友'}});
 assert.equal(response.responses[0].passage.quote,'交给了朋友');
 f.store.save({id:r.recordId,revision:r.revision,doc:plainDoc('已经有了新进展。','personal')});
 assert.equal(f.read(q).responses[0].passage,undefined);assert.equal(f.read(q).responses[0].recordId,r.recordId);
});

test('无引文建议与批注以两种次序及双连接并发到达，归属和人工问法都能保留',async t=>{
 const {Worker}=await import('node:worker_threads');
 for(const order of ['external','annotation','concurrent']){
  const f=fixture(t),a=f.record('我想留在原地，慢一点。'),text='为什么“留在原地”让我安心？';
  f.store.annotationCreate({originalId:a.recordId,originalVersionId:f.store.originalVersionInfo({id:a.recordId}).versionId,
   body:'## 待探索\n- '+text,requestId:'annotation'});
  const submit=()=>f.suggest(text,[a],{externalItemId:'source-without-quote'});
  const scan=async()=>assert.equal((await waitJob(f,f.write('import',{mode:'history'}).jobId)).status,'ready');
  let q;
  if(order==='external'){
   q=submit().questionId;f.review(f.read(q),'rewrite',{text:'我的问法'});await scan();
  }else if(order==='annotation'){
   await scan();q=f.list('raw')[0].questionId;f.review(f.read(q),'rewrite',{text:'我的问法'});assert.equal(submit().questionId,q);
  }else{
   const barrier=new Int32Array(new SharedArrayBuffer(4));
   const worker=new Worker(`
    const {workerData:d,parentPort}=require('node:worker_threads');
    (async()=>{const {createStore}=await import(d.module);const store=createStore(d.path,{recover:false});
      try{parentPort.postMessage('ready');const gate=new Int32Array(d.gate);Atomics.wait(gate,0,0,10000);
        parentPort.postMessage(store.exploration.call('shiwen_exploration_suggest',d.args,'external-worker').items[0].questionId);
      }finally{store.close();}})();
   `,{eval:true,workerData:{module:new URL('../plugins/library/legacy/store.mjs',import.meta.url).href,path:f.path,
    args:{...f.library,requestId:randomUUID(),suggestions:[{externalItemId:'external',type:'explore',text,sources:[a]}]},gate:barrier.buffer}});
   // Install both listeners before the writer becomes ready.
   let job;
   q=await new Promise((resolve,reject)=>{worker.on('error',reject);worker.on('message',value=>{
    if(value==='ready'){job=scan();Atomics.store(barrier,0,1);Atomics.notify(barrier,0);}else resolve(value);
   });});
   await job;f.review(f.read(q),'rewrite',{text:'我的问法'});
  }
  const state=f.read(q);assert.equal(state.status,'accepted');assert.equal(state.text,'我的问法');
  assert.equal(f.list('all').length,1);assert.equal(state.sources.filter(s=>s.quote==='留在原地').length,1);
  assert.equal(JSON.parse(f.store.exportBackup()).payload.tables.exploration_discoveries.length,2);
 }
});

test('A+B 的原始顺序、改写和后台仅用 B 的近义发现，在 MCP 与桌面读取一致',async t=>{
 const f=fixture(t),a=f.record('睡前翻开书。'),b=f.record('读完一页就留下书签。'),text='怎样继续阅读？';
 const q=f.suggest(text,[a,b]).questionId;
 f.review(f.read(q),'rewrite',{text:'我怎样找回那一页？'});
 const again=f.suggest(text,[b,a]);assert.equal(again.questionId,q);assert.equal(again.status,'existing');
 f.store.annotationCreate({originalId:b.recordId,originalVersionId:f.store.originalVersionInfo({id:b.recordId}).versionId,
  body:'## 待探索\n- 怎样继续阅读下去？',requestId:'annotation'});
 await waitJob(f,f.write('import',{mode:'history'}).jobId);
 const near=f.list('raw').find(r=>r.text==='怎样继续阅读下去？');assert.ok(near);
 assert.deepEqual(near.possibleDuplicates.map(m=>m.recordIds),[[b.recordId]]);
 assert.equal(near.possibleDuplicates[0].questionId,q);
 assert.deepEqual(f.read(near.questionId),f.store.exploration.call('shiwen_exploration_read',{...f.library,questionId:near.questionId}));
 f.enable();f.refresh();assert.ok(f.feed('week').every(c=>c.questionId!==near.questionId));
 const discoveries=JSON.parse(f.store.exportBackup()).payload.tables.exploration_discoveries.filter(d=>d.question===q);
 assert.deepEqual(discoveries.map(d=>JSON.parse(d.sources).map(s=>s.recordId)),[[a.recordId,b.recordId],[b.recordId,a.recordId]]);
});
