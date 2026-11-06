// Installed-app smoke check. All writes go to a new temporary user-data root.
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import assert from 'node:assert/strict';
const executable=resolve(process.argv[2]??'release/linux-unpacked/shiwen-dsh');
const data=await mkdtemp(join(tmpdir(),'shiwen-packaged-check-'));
const delay=ms=>new Promise(done=>setTimeout(done,ms));
async function until(fn){const deadline=Date.now()+90000;let last;while(Date.now()<deadline){try{const result=await fn();if(result)return result;}catch(error){last=error;}await delay(300);}throw last??Error('Timed out waiting for packaged app');}
let saved;
for(let round=0;round<2;round++){
 let output='',socket;
 await rm(join(data,'desktop/DevToolsActivePort'),{force:true});
 const env={...process.env,SHIWEN_ROOT_DIR:data};
 for(const name of ['ELECTRON_RUN_AS_NODE','NODE_PATH','NODE_OPTIONS','DSH_HOME','SHIWEN_DATA_DIR','SHIWEN_APP_PATCH'])delete env[name];
 const child=spawn(executable,['--remote-debugging-port=0'],{cwd:tmpdir(),env,stdio:['ignore','pipe','pipe']});
 child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
 const exited=new Promise(done=>child.once('exit',done));
 try{
  const port=await until(async()=>Number((await readFile(join(data,'desktop/DevToolsActivePort'),'utf8')).split('\n')[0]));
  const page=await until(async()=>(await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(page=>page.url.startsWith('dsh-app://app/')));
  socket=new WebSocket(page.webSocketDebuggerUrl);await new Promise((ok,no)=>{socket.onopen=ok;socket.onerror=no;});
  let id=0;const pending=new Map();socket.onmessage=event=>{const reply=JSON.parse(event.data),entry=pending.get(reply.id);if(entry){pending.delete(reply.id);reply.error?entry.reject(reply.error):entry.resolve(reply.result);}};
  const call=(method,params={})=>new Promise((resolve,reject)=>{const key=++id;pending.set(key,{resolve,reject});socket.send(JSON.stringify({id:key,method,params}));});
  const evaluate=async expression=>{const reply=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(reply.exceptionDetails)throw Error(JSON.stringify(reply.exceptionDetails));return reply.result.value;};
  await until(()=>evaluate("document.body.innerText.includes('素材') && document.body.innerText.includes('回顾')"));
  const rpc=(method,args={})=>evaluate(`(async()=>{const r=await fetch('/api/shiwen',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(${JSON.stringify({method,args})})});const b=await r.json();if(!r.ok)throw Error(b.error);return b.result;})()`);
  if(round===0){
   assert.equal((await rpc('snapshot')).records.length,0);
   saved=await rpc('saveMarkdown',{kind:'journal',title:'安装包验收日记',body:'# 测试标题\n\n独立运行与重启持久化。'});
   saved=await rpc('updateRecord',{id:saved.id,revision:saved.revision,kind:'idea',origin:'external',url:'https://example.org/test',day:'2026-10-12',annotation:'接口修改验收'});
   await assert.rejects(()=>rpc('updateRecord',{id:saved.id,revision:1,title:'过期修改'}),/更新/);
  }else{
   const records=(await rpc('snapshot')).records;assert.equal(records.length,1);assert.equal(records[0].id,saved.id);
  }
  const record=await rpc('readMarkdown',{id:saved.id});assert.match(record.markdown,/独立运行与重启持久化/);assert.equal(record.kind,'idea');assert.equal(record.origin,'external');assert.equal(record.dateInfo.day,'2026-10-12');assert.equal(record.annotation,'接口修改验收');
  assert.match((await rpc('agentState')).identity.body,/皮皮/);
  await rpc('review',{period:'7'});
  await evaluate("[...document.querySelectorAll('button,[role=button]')].find(x=>x.innerText.includes('素材')).click()");
  await until(()=>evaluate("document.querySelector('.sw-library-view')?.innerText.includes('安装包验收日记')"));
  if(round===0){
   const candidate=await rpc('saveMarkdown',{kind:'idea',title:'删除验收素材',body:'只用于删除测试。'});
   const click=label=>evaluate(`(()=>{const button=[...document.querySelectorAll('.sw-view button')].find(x=>x.textContent.trim()===${JSON.stringify(label)});if(!button)throw Error('Button not found');button.click();})()`);
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
console.log('Isolated acceptance data:',data);
