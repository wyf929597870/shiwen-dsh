// Installed-app smoke check. All writes go to a new temporary user-data root.
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import assert from 'node:assert/strict';
const executable=resolve(process.argv[2]??'release/linux-unpacked/shiwen-dsh');
const data=await mkdtemp(join(tmpdir(),'shiwen-order-check-'));
const delay=ms=>new Promise(done=>setTimeout(done,ms));
async function until(fn){const deadline=Date.now()+90000;let last;while(Date.now()<deadline){try{const result=await fn();if(result)return result;}catch(error){last=error;}await delay(300);}throw last??Error('Timed out waiting for packaged app');}
for(let round=0;round<1;round++){
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
  const old=await rpc('saveMarkdown',{kind:'journal',title:'排序验收 旧日记',body:'排序验收'});
  const newer=await rpc('saveMarkdown',{kind:'idea',title:'排序验收 新想法',body:'排序验收'});
  const newest=await rpc('saveMarkdown',{kind:'journal',title:'排序验收 最新日记',body:'排序验收'});
  const unknown=await rpc('saveMarkdown',{kind:'journal',title:'排序验收 未知日期',body:'排序验收'});
  for(const [row,day] of [[newest,'2026-11-05'],[newer,'2026-10-20'],[old,'2026-09-01'],[unknown,'']])await rpc('updateRecord',{id:row.id,revision:row.revision,day});
  await evaluate("[...document.querySelectorAll('button,[role=button]')].find(x=>x.innerText.includes('素材')).click()");
  const titles=()=>evaluate("[...document.querySelectorAll('.sw-row strong')].map(x=>x.textContent)");
  await until(async()=>(await titles()).length===4);
  const expected=['排序验收 最新日记','排序验收 新想法','排序验收 旧日记','排序验收 未知日期'];
  assert.deepEqual(await titles(),expected);
  assert.deepEqual(await evaluate("[...document.querySelectorAll('.sw-row small')].map(x=>x.textContent)"),['日记 · 2026-11-05','想法 · 2026-10-20','日记 · 2026-09-01','日记 · 日期待确认']);
  const setInput=(selector,value,event='input')=>evaluate(`(()=>{const x=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(x.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype,'value').set.call(x,${JSON.stringify(value)});x.dispatchEvent(new Event(${JSON.stringify(event)},{bubbles:true}));})()`);
  await setInput('.sw-toolbar input','日记');await until(async()=>(await titles()).length===2);
  assert.deepEqual(await titles(),[expected[0],expected[2]]);
  await setInput('.sw-toolbar input','');await setInput('.sw-filter select','journal','change');
  await until(async()=>(await titles()).length===3);
  assert.deepEqual(await titles(),[expected[0],expected[2],expected[3]]);
  await setInput('.sw-filter select','','change');await until(async()=>(await titles()).length===4);
  await writeFile(join(data,'record-order.png'),Buffer.from((await call('Page.captureScreenshot',{format:'png'})).data,'base64'));
  console.log('Desktop content-date order, displayed dates, keyword search and type filter passed.');
  socket.close();socket=null;
 }finally{
  socket?.close();child.kill('SIGTERM');await Promise.race([exited,delay(5000)]);if(child.exitCode===null)child.kill('SIGKILL');
  await writeFile(join(data,`launch-${round+1}.log`),output);
 }
}
console.log('Isolated acceptance data:',data);
