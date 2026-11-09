// Packaged-app smoke check. Optional argv[3] seeds data with an older executable.
// All writes go to a new temporary user-data root.
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import assert from 'node:assert/strict';
import {startServer,stopServer} from './server-control.mjs';
const executable=resolve(process.argv[2]??'release/linux-unpacked/shiwen-dsh');
const previousExecutable=process.argv[3]?resolve(process.argv[3]):executable;
const data=await mkdtemp(join(tmpdir(),'shiwen-packaged-check-'));
const delay=ms=>new Promise(done=>setTimeout(done,ms));
async function until(fn){const deadline=Date.now()+90000;let last;while(Date.now()<deadline){try{const result=await fn();if(result)return result;}catch(error){last=error;}await delay(300);}throw last??Error('Timed out waiting for packaged app');}
const resources=join(dirname(executable),'resources/shiwen');
const service=await startServer({root:data,host:'127.0.0.1',port:0,discoverLan:false},{runtime:resources,worker:join(resources,'scripts/server-worker.mjs'),node:join(resources,'../runtime/primary-runtime/dependencies/node/bin/node')});
const login=await fetch(service.loginUrl,{redirect:'manual'}),cookie=login.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');
const configured=await fetch(new URL('/auth/password',service.url),{method:'POST',headers:{'Content-Type':'application/json',Origin:new URL(service.url).origin,cookie},body:JSON.stringify({password:'Isolated-desktop-acceptance-8321'})});assert.equal(configured.status,200);
await mkdir(join(data,'desktop'),{recursive:true});
await writeFile(join(data,'desktop/connection.json'),JSON.stringify({mode:'local',lan:false,port:Number(new URL(service.url).port)}));
let saved;
try{for(let round=0;round<2;round++){
 let output='',socket;
 await rm(join(data,'desktop/DevToolsActivePort'),{force:true});
 const env={...process.env,SHIWEN_ROOT_DIR:data};
 for(const name of ['ELECTRON_RUN_AS_NODE','NODE_PATH','NODE_OPTIONS','DSH_HOME','SHIWEN_DATA_DIR','SHIWEN_APP_PATCH'])delete env[name];
 const child=spawn(round===0?previousExecutable:executable,['--remote-debugging-port=0'],{cwd:tmpdir(),env,stdio:['ignore','pipe','pipe']});
 child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
 const exited=new Promise(done=>child.once('exit',done));
 try{
  const port=await until(async()=>Number((await readFile(join(data,'desktop/DevToolsActivePort'),'utf8')).split('\n')[0]));
  const page=await until(async()=>(await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(page=>page.url.startsWith('dsh-app://app/')||page.url.startsWith(new URL(service.loginUrl).origin+'/')));
  socket=new WebSocket(page.webSocketDebuggerUrl);await new Promise((ok,no)=>{socket.onopen=ok;socket.onerror=no;});
  let id=0;const pending=new Map();socket.onmessage=event=>{const reply=JSON.parse(event.data),entry=pending.get(reply.id);if(entry){pending.delete(reply.id);reply.error?entry.reject(reply.error):entry.resolve(reply.result);}};
  const call=(method,params={})=>new Promise((resolve,reject)=>{const key=++id;pending.set(key,{resolve,reject});socket.send(JSON.stringify({id:key,method,params}));});
  const evaluate=async expression=>{const reply=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(reply.exceptionDetails)throw Error(JSON.stringify(reply.exceptionDetails));return reply.result.value;};
  await until(()=>evaluate("(document.body.innerText.includes('素材') || document.body.innerText.includes('Materials')) && (document.body.innerText.includes('回顾') || document.body.innerText.includes('Review'))"));
  const rpc=(method,args={})=>evaluate(`(async()=>{const r=await fetch('/api/shiwen',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(${JSON.stringify({method,args})})});const b=await r.json();if(!r.ok)throw Error(b.error);return b.result;})()`);
  if(round===0){
   assert.equal((await rpc('snapshot')).records.length,0);
   saved=await rpc('saveMarkdown',{kind:'journal',title:'安装包验收日记',body:'# 测试标题\n\n独立运行与重启持久化。'});
   saved=await rpc('updateRecord',{id:saved.id,revision:saved.revision,kind:'idea',url:'https://example.org/test',day:'2026-10-12',annotation:'接口修改验收'});
   saved=await rpc('correctRecordOrigin',{id:saved.id,revision:saved.revision,origin:'external',requestId:'package-correct-origin'});
   const anchor=await rpc('originalVersionInfo',{id:saved.id});await rpc('annotationCreate',{originalId:saved.id,originalVersionId:anchor.versionId,body:'独立的安装包标注',requestId:'package-annotation'});
   await assert.rejects(()=>rpc('updateRecord',{id:saved.id,revision:1,title:'过期修改'}),/更新/);
  }else{
   const records=(await rpc('snapshot')).records;assert.equal(records.length,1);assert.equal(records[0].id,saved.id);
  }
  assert.equal((await rpc('annotationList',{originalId:saved.id})).length,1);
  const record=await rpc('readMarkdown',{id:saved.id});assert.match(record.markdown,/独立运行与重启持久化/);assert.equal(record.kind,'idea');assert.equal(record.origin,'external');assert.equal(record.dateInfo.day,'2026-10-12');assert.equal(record.annotation,'接口修改验收');
  assert.match((await rpc('agentState')).identity.body,/皮皮/);
  await rpc('review',{period:'7'});
  await evaluate("[...document.querySelectorAll('button,[role=button]')].find(x=>(x.innerText.includes('素材')||x.innerText.includes('Materials'))).click()");
  await until(()=>evaluate("document.querySelector('.sw-library-view')?.innerText.includes('安装包验收日记')"));
  await evaluate("[...document.querySelectorAll('.sw-row')].find(x=>x.innerText.includes('安装包验收日记')).click()");
  await until(()=>evaluate("Boolean(document.querySelector('.sw-annotation-list button:not(:disabled)'))"));
  await evaluate("document.querySelector('.sw-annotation-list button').click()");
  await until(()=>evaluate("Boolean(document.querySelector('.sw-annotation-detail-head button'))"));
  await evaluate("document.querySelector('.sw-annotation-detail-head button').click()");
  assert.equal(await evaluate("Boolean(document.querySelector('.sw-annotation-detail'))"),false);
  assert.equal((await rpc('annotationList',{originalId:saved.id})).length,1);
  await evaluate("[...document.querySelectorAll('button,[role=button]')].find(x=>x.innerText.trim()==='回顾'||x.innerText.trim()==='Review').click()");
  await until(()=>evaluate("Boolean(document.querySelector('.sw-review-metrics strong'))"));
  const originals=await rpc('reviewPreview',{period:'7'});
  assert.equal(await evaluate("Number(document.querySelector('.sw-review-metrics strong').textContent.replaceAll(',',''))"),originals.personalOriginalCharacters);
  assert.equal(await evaluate("document.querySelectorAll('.sw-review-table tbody tr').length"),originals.records.length);
  await evaluate("[...document.querySelectorAll('button,[role=button]')].find(x=>x.innerText.trim()==='素材'||x.innerText.trim()==='Materials').click()");
  await until(()=>evaluate("document.querySelector('.sw-library-view')?.innerText.includes('安装包验收日记')"));
  if(round===0){
   const candidate=await rpc('saveMarkdown',{kind:'idea',title:'删除验收素材',body:'只用于删除测试。'});
   const click=label=>{const labels=[label,({'刷新':'Refresh','删除':'Delete','确认删除':'Confirm deletion','取消':'Cancel','撤销删除':'Undo deletion'})[label]].filter(Boolean);return evaluate(`(()=>{const button=[...document.querySelectorAll('.sw-view button')].find(x=>${JSON.stringify(labels)}.includes(x.textContent.trim()));if(!button)throw Error('Button not found');button.click();})()`);};
   await click('刷新');
   await until(()=>evaluate("[...document.querySelectorAll('.sw-row')].some(x=>x.innerText.includes('删除验收素材'))"));
   await evaluate("[...document.querySelectorAll('.sw-row')].find(x=>x.innerText.includes('删除验收素材')).click()");
   await until(()=>evaluate("document.querySelector('.sw-detail h2')?.textContent==='删除验收素材'"));
   await click('删除');await until(()=>evaluate("Boolean(document.querySelector('dialog[open]'))"));
   for(const width of [1280,390]){
    await call('Emulation.setDeviceMetricsOverride',{width,height:850,deviceScaleFactor:1,mobile:false});
    await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    const bounds=await evaluate("(()=>{const d=document.querySelector('dialog[open]'),r=d.getBoundingClientRect();return {left:r.left,right:r.right,width:innerWidth,overflow:d.scrollWidth>d.clientWidth};})()");
    assert.ok(bounds.left>=0&&bounds.right<=bounds.width&&!bounds.overflow);
    await writeFile(join(data,`delete-confirm-${width}.png`),Buffer.from((await call('Page.captureScreenshot',{format:'png'})).data,'base64'));
   }
   await call('Emulation.clearDeviceMetricsOverride');
   await click('取消');assert.equal((await rpc('snapshot')).records.length,2);
   await click('删除');await click('确认删除');
   await until(async()=>(await rpc('snapshot')).records.length===1);
   await until(()=>evaluate("!document.querySelector('dialog[open]') && Boolean(document.querySelector('.sw-undo button'))"));
   assert.equal(await evaluate("[...document.querySelectorAll('.sw-row')].some(x=>x.innerText.includes('删除验收素材'))"),false);
   await click('撤销删除');
   await until(()=>evaluate("[...document.querySelectorAll('.sw-row')].some(x=>x.innerText.includes('删除验收素材'))"));
   assert.equal((await rpc('readMarkdown',{id:candidate.id})).markdown,'只用于删除测试。');
   await evaluate("[...document.querySelectorAll('.sw-row')].find(x=>x.innerText.includes('删除验收素材')).click()");
   await until(()=>evaluate("document.querySelector('.sw-detail h2')?.textContent==='删除验收素材'"));
   await click('删除');await click('确认删除');
   await until(async()=>(await rpc('snapshot')).records.length===1);
  }
  console.log(`Round ${round+1}: native chat, Shiwen panels, library, Pipi identity, record updates, attribution, deletion/undo and persistence passed.`);
  socket.close();socket=null;
 }finally{
  socket?.close();child.kill('SIGTERM');await Promise.race([exited,delay(5000)]);if(child.exitCode===null)child.kill('SIGKILL');
  await writeFile(join(data,`launch-${round+1}.log`),output);
 }
}
}finally{await stopServer(data);}
console.log('Isolated acceptance data:',data);
