// Run on an explicitly selected test device with the debug app and test APK installed.
import assert from 'node:assert/strict';
import {checkExplorationInterop} from '../tests/support/exploration-interop.mjs';
import {execFile} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {markdownSource} from '../plugins/library/legacy/markdown.mjs';
import Database from '../plugins/library/legacy/sqlite.mjs';
import {createStore} from '../plugins/library/legacy/store.mjs';
import {createMobileSyncAdapter} from '../plugins/mobile/src/sync-adapter.mjs';

const serial=process.env.ANDROID_SERIAL;
if(!serial)throw Error('请通过 ANDROID_SERIAL 指定隔离测试设备');
const adb=(...args)=>promisify(execFile)(process.env.ADB||'adb',['-s',serial,...args],{timeout:180000,maxBuffer:4e6});
for(const choice of ['abandon','replace','deleted']){
 const root=await mkdtemp(join(tmpdir(),'shiwen-explore-reconnect-'));
 const store=createStore(join(root,'library.sqlite'));store.paths={library:root};
 const adapter=createMobileSyncAdapter({ctx:{connection:{browserPeer:{id:'synthetic-owner'}}},library:store});
 const secret=randomUUID(),device=randomUUID(),response=randomUUID(),counts={body:0,link:0};
 const identity=adapter.identity({deviceId:device,protocolVersion:'1.0.0-draft.3'});
 const library=identity.libraryId,epoch=identity.epoch;
 const write=(method,args)=>store.exploration.call('shiwen_exploration_'+method,{requestId:randomUUID(),expectedLibraryId:library,...args});
 const read=id=>store.exploration.call('shiwen_exploration_read',{expectedLibraryId:library,questionId:id});
 const source=store.save({kind:'idea',body:'我把书签留在原地。'}).id;
 const [question,target]=['怎样恢复阅读？','下一次怎么回到这本书？'].map(text=>{
  const q=write('suggest',{suggestions:[{type:'explore',text,externalItemId:randomUUID(),sources:[{recordId:source,revision:1}]}]}).items[0].questionId;
  write('review',{questionId:q,expectedRevision:read(q).revision,action:'accept'});return q;
 });
 const resolutions=new Map();
 const server=createServer(async(req,res)=>{
  try{
   if(req.url!=='/sync'||req.headers.authorization!=='Bearer '+secret){res.writeHead(403);res.end();return;}
   const chunks=[];for await(const part of req)chunks.push(part);
   const {action,request}=JSON.parse(Buffer.concat(chunks));
   if(action==='push'&&request.operations.some(x=>x.inlineBody?.recordId===response))counts.body++;
   if(action==='explorationSubmit'&&request.operation.method==='shiwen_exploration_respond')counts.link++;
   const result=await adapter.execute(action,request);
   if(action==='explorationResolve'){
    assert.equal(result.status,'resolved');assert.equal(result.conflictId,request.conflictId);
    assert.deepEqual(await adapter.execute(action,request),result);
    if(request.choice==='replace'){
     assert.equal(request.replacement.operation.args.questionId,target);
     assert.equal(result.replacementId,request.replacement.operationId);
     assert.notEqual(result.replacementId,request.operationId);
    }else assert.equal(result.replacementId,undefined);
    resolutions.set(request.operationId,{conflictId:result.conflictId,operationId:request.operationId,
     choice:result.resolution,replacementId:result.replacementId});
   }
   res.setHeader('Content-Type','application/json');res.end(JSON.stringify(result));
  }catch(e){res.writeHead(400);res.end(JSON.stringify({error:e.message}));}
 });
 await new Promise((ok,fail)=>server.once('error',fail).listen(0,'127.0.0.1',ok));
 const endpoint='tcp:'+server.address().port;
 try{
  await adb('reverse',endpoint,endpoint);
  const journal=randomUUID(),uploads={};
  async function phone(phase,extra={}){
   await adb('shell','am','force-stop','io.github.wyf929597870.shiwen.probe');
   const params={...extra,phase,choice,device,secret,journal,explorationUi:String(process.env.SHIWEN_TEST_EXPLORATION_UI==='1'),library,epoch,server:identity.serverId,source,question,target,response,explorationPort:String(server.address().port)};
   const {stdout}=await adb('shell','am','instrument','-w','-e','class','io.github.wyf929597870.shiwen.library.ExplorationReconnectTest',
    ...Object.entries(params).flatMap(([k,v])=>['-e',k,v]),'io.github.wyf929597870.shiwen.probe.test/androidx.test.runner.AndroidJUnitRunner');
   assert.match(stdout,/OK \(1 test\)/,phase+'\n'+stdout.replaceAll(secret,'[redacted]'));
  }
  for(const phase of ['offline','holdBody','unknownBody','loseBody','holdLink','unknownLink','loseLink','resolve','reopen']){
   const before={...counts};
   if(phase==='holdBody' && choice==='deleted'){
    // A question disappeared while the phone was offline. Only this disposable fixture is edited.
    const db=new Database(join(root,'library.sqlite'));
    try{db.transaction(()=>{
     for(const table of ['exploration_discoveries','exploration_evidence'])db.prepare('DELETE FROM '+table+' WHERE question=?').run(question);
     db.prepare('DELETE FROM exploration_questions WHERE id=?').run(question);
    })();}finally{db.close();}
   }else if(phase==='holdBody')write('review',{action:'merge',questionId:question,expectedRevision:read(question).revision,targetQuestionId:target,expectedTargetRevision:read(target).revision});
   if(phase==='reopen'&&choice==='abandon'){
    const interop=await checkExplorationInterop({root,store,library,source,write,read,phone});
    console.log(JSON.stringify({interop}));
   }
   await phone(phase);
   uploads[phase]=[counts.body-before.body,counts.link-before.link];
   assert.deepEqual(uploads[phase],[Number(phase==='loseBody'),Number(phase==='loseLink')],phase);

  }
  assert.deepEqual(counts,{body:1,link:1});
  if(choice==='deleted'){
   assert.equal(markdownSource(store.get(journal).doc),'另一篇日记也已送达。');assert.equal(markdownSource(store.get(response).doc),'  我重新打开书，接着读了半页。\n');
   assert.equal(read(target).responses.length,0);
  }else{
   assert.equal(read(target).responses.length,1);assert.equal(read(target).responses[0].recordId,response);
  }
  assert.equal(resolutions.size,1);
  const [resolution]=resolutions.values();
  assert.equal(resolution.choice,choice==='replace'?'replace':'abandon');
  console.log(JSON.stringify({choice,resolution,library,epoch,question,target,response,counts,uploads,status:read(target).status}));
 }finally{
  await adb('reverse','--remove',endpoint).catch(()=>{});
  server.closeAllConnections();await new Promise(ok=>server.close(ok));adapter.close();store.close();await rm(root,{recursive:true,force:true});
 }
}
