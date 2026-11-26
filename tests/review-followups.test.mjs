import test from 'node:test';
import assert from 'node:assert/strict';
import {collectReviewSources, reviewSample, verifiedFollowups} from '../plugins/workbench/src/review-followups.mjs';
import {apply} from '../plugins/workbench/src/index.mjs';

const row = (id,day)=>({id,kind:'journal',contentDay:day,title:id});
const rows = [row('a','2026-11-01'),row('b','2026-11-05'),row('c','2026-11-08')];
const lines = ['下次想先列问题。','今天列出了两个问题。','另外一条个人记录。'];
const read = async id => {
  const i=rows.findIndex(r=>r.id===id);
  return {...rows[i],origin:'personal',sources:[{origin:'external',text:'这句是收藏引文。'},{origin:'personal',text:lines[i]}]};
};

test('review samples multiple days; semantic hits use current personal text and dates',async()=>{
  const many=Array.from({length:35},(_,i)=>row(String(i),'2026-11-'+String(Math.min(30,i+1)).padStart(2,'0')));
  const sample=reviewSample(many);
  assert.equal(sample.length,12);
  assert.equal(sample[0].contentDay,'2026-11-01');
  assert.equal(sample.at(-1).contentDay,'2026-11-30');
  const sources=await collectReviewSources([rows[0],rows[2]],rows,read,async args=>{
    assert.equal(args.filters.start,'2026-11-02');
    return {items:[{recordId:'b',match:{text:'这句是收藏引文。'}},{recordId:'b',match:{text:lines[1]}}]};
  },()=>true);
  assert.equal(sources.length,3);
  assert.ok(sources.every(s=>s.excerpts.every(q=>!q.includes('收藏引文'))));
  const pair={before:1,after:3,beforeQuote:lines[0],afterQuote:lines[1],note:'试过一次。'};
  assert.equal(verifiedFollowups(JSON.stringify([pair,pair]),sources).length,1);
  assert.throws(()=>verifiedFollowups(JSON.stringify([{...pair,afterQuote:'杜撰引文'}]),sources));
  assert.throws(()=>verifiedFollowups(JSON.stringify([{...pair,before:3,after:1,beforeQuote:lines[1],afterQuote:lines[0]}]),sources));
  assert.deepEqual(verifiedFollowups('[]',sources),[]);
});

test('review sends a single tool-free request to the configured default and requires a complete response and owner admission',async()=>{
  const peer={}, seen=[];let handler,admitted=false,complete=true,model='custom-local';
  const ctx={effect:f=>f(),shiwenLibrary:{},connection:{browserPeer:peer,admit:()=>admitted?{peer}:{rejection:401},
    fetch:{register:r=>{handler=r.fetch;}}},get:key=>key==='agentDefaultModel'?{currentSelection:()=>({provider:'mine',model})}:key==='llm'?{async *stream(options){
      seen.push(options);yield {type:'text-delta',text:'[]'};if(complete)yield {type:'finish',reason:{kind:'stop'}};
    }}:undefined};
  apply(ctx);
  const send=()=>handler(new Request('http://localhost/api/shiwen',{method:'POST',body:JSON.stringify({method:'reviewFollowups',args:{input:'[]',instruction:'synthetic test'}})}));
  assert.equal((await send()).status,401);
  assert.equal(seen.length,0);
  admitted=true;
  assert.deepEqual((await (await send()).json()).result,{model,text:'[]'});
  model='my-online-model';complete=false;
  assert.equal((await send()).status,400);
  assert.deepEqual(seen.map(s=>[s.provider,s.model,s.tools]),[['mine','custom-local',undefined],['mine','my-online-model',undefined]]);
});
