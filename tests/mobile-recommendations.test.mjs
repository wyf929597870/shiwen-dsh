import {insertLegacyCard} from './support/legacy-recommendation.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {mobileRecommendationRpc} from '../android/web/phone-recommendations.mjs';
import {createStore} from '../plugins/library/legacy/store.mjs';
const uuid=()=>crypto.randomUUID();
function model(input){
  const p=JSON.parse(input),hit=p.passages.find(q=>q.record===p.seed);
  return JSON.stringify([{scene:'writing',type:'writing',question:hit.title+'里的具体问题是什么？',reason:'这段试读记录提到了读者的反馈。',followup:'读者在哪一句停下？',refs:[hit.n],addsEvidence:true}])+'\n以上是分析。';
}
async function finish(rpc,job){
  for(let i=0;i<200;i++){
    const s=await rpc('shiwen_assist_result',job);
    if(s.status==='ready')return s.result;if(s.status==='failed')throw Error(s.message);
    await new Promise(r=>setTimeout(r,5));
  }
  throw Error('timed out');
}
test('独立库由手机模型生成，逐条显示，重开增补、反馈、重试和原文失效都保留库边界',async()=>{
  const id='local',rows=Array.from({length:13},(_,i)=>({id:uuid(),kind:'idea',origin:'personal',title:'试读笔记 '+i,revision:1,updated:new Date().toISOString(),markdown:'我删掉开头的三句话，从例子开始，读者给了第 '+i+' 条反馈。'}));
  const saved=new Map();let calls=0,release,entered;
  const gate=new Promise(r=>release=r),started=new Promise(r=>entered=r);
  async function bridge(method,a){
    assert.equal(a.libraryId,id);
    if(method==='phoneRecData')return {value:structuredClone(saved.get(a.key)??null)};
    if(method==='phoneRecSources')return {rows:a.after?[]:rows};
    if(method==='recordRead')return rows.find(row=>row.id===a.id);
    if(method==='phoneRecAnalyze'){
      assert.equal(saved.get('state').enabled,true);
      if(++calls===2){entered();await gate;}
      return {text:model(a.input)};
    }
    if(method==='phoneRecCommit'){
      assert.equal(saved.get('state')?.version??0,a.expected);
      saved.set('state',structuredClone(a.state));
      if(a.card)saved.set('card-'+a.card.cardId,structuredClone(a.card));
      if(a.receipt)saved.set(a.receipt.key,structuredClone(a.receipt));
      return {saved:true};
    }
    throw Error(method);
  }
  let rpc=mobileRecommendationRpc(bridge,id,'standalone');
  const C={expectedLibraryId:id},W=()=>({...C,requestId:uuid()});
  const list=(view='week')=>rpc('shiwen_recommendation_list',{view});
  assert.equal((await rpc('shiwen_recommendation_settings')).enabled,false);
  await rpc('shiwen_recommendation_settings',{...W(),enabled:true,revision:1});
  const req=W(),job=await rpc('shiwen_recommendation_refresh',req);
  await started;
  try{assert.equal((await list()).items.length,1);assert.equal((await rpc('shiwen_assist_result',job)).status,'pending');}finally{release();}
  assert.equal((await finish(rpc,job)).changed,10);
  rpc=mobileRecommendationRpc(bridge,id,'standalone');
  assert.equal((await finish(rpc,await rpc('shiwen_recommendation_refresh',req))).changed,10);assert.equal(calls,10);
  assert.equal((await list('today')).items.length,0);
  assert.equal((await finish(rpc,await rpc('shiwen_recommendation_refresh',W()))).changed,2);
  assert.equal((await list('today')).items.length,2);
  const first=(await list()).items[0], save={...W(),action:'save_later',cardId:first.cardId,cardRevision:first.cardRevision};
  await rpc('shiwen_recommendation_feedback',save);await rpc('shiwen_recommendation_feedback',save);
  assert.equal((await list('later')).items[0].cardId,first.cardId);
  const c=await rpc('shiwen_recommendation_read',{...C,cardId:first.cardId});assert.equal(c.quotes.length,1);
  const r=rows.find(x=>x.id===c.quotes[0].recordId);r.markdown='内容已替换';r.revision++;
  assert(!(await list()).items.some(x=>x.cardId===c.cardId));
  await assert.rejects(()=>rpc('shiwen_recommendation_read',{expectedLibraryId:'different',cardId:c.cardId}),/已切换/);
});
function acceptPhoneFixture(store,C,row){
 const created=store.exploration.call('shiwen_exploration_suggest',{...C,requestId:uuid(),suggestions:[
  {externalItemId:row.id,type:'explore',text:row.title+'的后续是什么？',sources:[{recordId:row.id,revision:row.revision,quote:row.body}]}]});
 return store.exploration.call('shiwen_exploration_review',{...C,requestId:uuid(),questionId:created.items[0].questionId,expectedRevision:1,action:'accept'});
}
test('绑定手机库通过工作台读取桌面原卡，手机的稍后看立即出现在桌面',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'mobile-paired-recs-')),store=createStore(join(dir,'library.sqlite'));
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  const id=store.themeContext().libraryId,desktop=(name,args={})=>store.assist.call(name,args),C={expectedLibraryId:id};
  const mobile=mobileRecommendationRpc(async(method,a)=>{
    assert.equal(method,'workspaceRemote');assert.equal(a.libraryId,id);return {result:desktop(a.method,a.args)};
  },id,'replica');
  const source=store.save({origin:'personal',kind:'idea',title:'试读',body:'一位读者告诉我，文章里的第一段很难懂。'});
  acceptPhoneFixture(store,C,source);
  store.generateAssist=(_,input)=>model(input);
  desktop('shiwen_recommendation_settings',{...C,revision:1,enabled:true,requestId:uuid()});
  await finish(mobile,await mobile('shiwen_recommendation_refresh',{...C,requestId:uuid()}));
  assert.deepEqual((await mobile('shiwen_recommendation_list',{view:'week'})).items,desktop('shiwen_recommendation_list').items);
  const card=insertLegacyCard(join(dir,'library.sqlite'),store,source);
  await mobile('shiwen_recommendation_feedback',{...C,cardId:card.cardId,cardRevision:card.cardRevision,action:'save_later',requestId:uuid()});
  assert.equal(desktop('shiwen_recommendation_list',{view:'later'}).items[0].cardId,card.cardId);
});

test('绑定库缓存桌面首页和原文，在断线、冷启动及跨日后仍可读；重连取回改动',async t=>{
 t.mock.timers.enable({apis:['Date'],now:new Date('2026-11-26T12:00:00')});
 const dir=mkdtempSync(join(tmpdir(),'mobile-offline-recs-')),store=createStore(join(dir,'library.sqlite'));
 t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
 const id=store.themeContext().libraryId,C={expectedLibraryId:id},disk=new Map();
 for(let i=0;i<12;i++)acceptPhoneFixture(store,C,store.save({origin:'personal',kind:'idea',title:'试读 '+i,body:'文章第 '+i+' 段的例子可以再具体一些。'}));
 const desktop=(name,args)=>store.assist.call(name,args);store.generateAssist=(_,input)=>model(input);
 const rpcFor=(state,epoch='original')=>mobileRecommendationRpc(async(method,a)=>{
   if(method==='phoneRecSnapshot'){
     assert.equal(a.libraryId,id);const key=a.serverId+'/'+a.epoch;
     if(a.snapshot)disk.set(key,structuredClone(a.snapshot));return {value:disk.get(key)};
   }
   assert.equal(state,'online','断线时不访问工作台');return {result:desktop(a.method,a.args)};
 },id,'replica',{state,serverId:'computer',epoch});
 const settings='shiwen_recommendation_settings',list='shiwen_recommendation_list',read='shiwen_recommendation_read';
 desktop(settings,{...C,revision:1,enabled:true,requestId:uuid()});
 const refresh=()=>finish(desktop,desktop('shiwen_recommendation_refresh',{...C,requestId:uuid()}));
 await refresh();const online=rpcFor('online');await online(settings);
 const live=await online(list,{view:'week'});
 const offline=rpcFor('offline');assert.equal((await offline(settings)).offline,true);
 assert.deepEqual((await offline(list,{view:'week'})).items,live.items);
 const card=await offline(read,{...C,cardId:live.daily[0].cardId});
 assert.equal(card.quotes[0].text,desktop(read,{...C,cardId:card.cardId}).quotes[0].text);
 await assert.rejects(()=>offline('shiwen_recommendation_feedback',C),/连接电脑/);
 await assert.rejects(()=>rpcFor('offline','other')(settings),/还没有保存/);
 await assert.rejects(()=>rpcFor('identity-mismatch')(settings),/验证/);
 await refresh();await online(list,{view:'week'});
 assert.equal((await offline(list,{view:'today'})).items.length,0);
 t.mock.timers.setTime(Date.parse('2026-11-27T12:00:00'));
 const picks=await rpcFor('offline')(list,{view:'daily'});assert.equal(picks.items.length,2);
 assert.equal(picks.cachedDay,'2026-11-26');assert.equal(picks.day,'2026-11-27');
 assert.equal((await offline(list,{view:'today'})).items.length,0);
 await online(settings,{...C,revision:2,enabled:false,requestId:uuid()});
 assert.equal((await offline(settings)).enabled,false);
 await assert.rejects(()=>offline(read,{...C,cardId:card.cardId}),/尚未保存/);
});
