import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer} from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createStore} from '../plugins/library/legacy/store.mjs';
import {apply} from '../plugins/workbench/src/index.mjs';

test('桌面从回应追问、从首页接续判断和行动、记结果后仍可略过撤卡',{skip:!process.env.SHIWEN_TEST_CHROME},async t=>{
 const dir=await mkdtemp(join(tmpdir(),'shiwen-explore-browser-'));
 const store=createStore(join(dir,'library.sqlite'));t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true});});
 const r=store.save({kind:'idea',body:'我翻到昨天那一页，又读了一段。'});
 const agent=store.externalClientCreate({name:'测试发现',scopes:['read','create']});
 const {libraryId:expectedLibraryId}=store.themeContext();
 const suggested=store.externalCall(agent,'shiwen_exploration_suggest',{expectedLibraryId,requestId:'browser',
  suggestions:[{type:'explore',text:'阅读被打断后怎么办？',externalItemId:'idea',sources:[{recordId:r.id,revision:r.revision}]}]});
 const later=store.save({kind:'journal',title:'周六的后续',body:'周六把草稿交给了朋友，收到了两条建议。'});
 const more=store.externalCall(agent,'shiwen_exploration_suggest',{expectedLibraryId,requestId:'more',suggestions:[
  {type:'follow_up',text:'朋友看过我的草稿了吗？',externalItemId:'draft',sources:[{recordId:r.id,revision:r.revision}]},
  {type:'explore',text:'我真的要换职业吗？',externalItemId:'career',sources:[{recordId:r.id,revision:r.revision}]}]});
 store.assist.call('shiwen_recommendation_settings',{expectedLibraryId,enabled:true,revision:1,requestId:'auto'});
 let modelCalls=0;store.generateAssist=()=>{modelCalls++;throw Error('首页触发模型');};
 const peer={id:'owner'};let route;
 apply({shiwenLibrary:store,effect:fn=>fn(),connection:{browserPeer:peer,admit:()=>({peer}),fetch:{register:r=>{route=r;}}}});
 const {outputFiles:[app]}=await build({entryPoints:['tests/support/exploration-browser.jsx'],nodePaths:[resolve('android/node_modules')],bundle:true,write:false,jsx:'automatic',loader:{'.css':'text'}});
 const calls=[];
 const server=createServer(async(req,res)=>{
  if(req.url==='/api'){
   const parts=[];for await(const part of req)parts.push(part);
   const body=Buffer.concat(parts);calls.push(JSON.parse(body).method);
   const response=await route.fetch(new Request('http://localhost/api/shiwen',{method:'POST',body}));
   const {method,args}=JSON.parse(body);
   if(method==='shiwen_exploration_respond' && args?.body){
    store.save({kind:'idea',body:'阅读被打断时，我试着夹了一枚书签。'});
    store.save({kind:'freewrite',body:'被打断的阅读要怎样恢复呢？'});
    const {jobId}=store.exploration.call('shiwen_exploration_import',{expectedLibraryId,requestId:'check-followups',mode:'incremental'});
    while(store.exploration.discovery.result(jobId,'desktop').status==='pending')await new Promise(resolve=>setTimeout(resolve,5));
   }
   res.writeHead(response.status,{'Content-Type':'application/json'});res.end(await response.text());
  }else if(req.url==='/app.js'){res.setHeader('Content-Type','text/javascript');res.end(app.contents);}
  else res.end('<!doctype html><meta charset="utf-8"><div id="root"></div><pre id="result"></pre><script src="/app.js"></script>');
 });
 await new Promise((ok,fail)=>server.once('error',fail).listen(0,'127.0.0.1',ok));t.after(()=>server.close());
 const {stdout}=await promisify(execFile)(process.env.SHIWEN_TEST_CHROME,['--headless','--no-sandbox','--disable-gpu','--disable-dev-shm-usage',
  '--user-data-dir='+join(dir,'chrome'),'--virtual-time-budget=25000','--dump-dom','http://127.0.0.1:'+server.address().port],{timeout:45000,maxBuffer:3000000});
 assert.equal(stdout.match(/<pre id="result">([^<]*)<\/pre>/)?.[1],'passed',stdout.slice(-4500));
 const q=store.externalCall(agent,'shiwen_exploration_read',{expectedLibraryId,questionId:suggested.items[0].questionId});
 assert.equal(q.status,'skipped');assert.deepEqual(q.steps.map(s=>s.kind),['ask','judgment','trial','result']);assert.equal(q.nextStep.parentId,q.steps[2].id);assert.equal(q.responses.length,2);assert.ok(q.responses.some(r=>r.preview==='我把书留在刚才那一页。'));
 const read=id=>store.externalCall(agent,'shiwen_exploration_read',{expectedLibraryId,questionId:id});
 assert.equal(read(more.items[0].questionId).responses[0].recordId,later.id);
 assert.equal(read(more.items[1].questionId).status,'skipped');
 const repeat=store.externalCall(agent,'shiwen_exploration_suggest',{expectedLibraryId,requestId:'rescan',suggestions:[{type:'explore',text:'我真的要换职业吗？',externalItemId:'career',sources:[{recordId:r.id,revision:r.revision}]}]});
 assert.equal(read(repeat.items[0].questionId).status,'skipped');
 assert.equal(modelCalls,0);assert.equal(calls.filter(m=>m==='shiwen_recommendation_refresh').length,1);
});
