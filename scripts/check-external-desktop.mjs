// Real desktop UI + packaged MCP verification. Uses only a new temporary profile.
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import assert from 'node:assert/strict';
const executable=resolve(process.argv[2]??'debug/linux/linux-unpacked/shiwen-dsh');
const data=await mkdtemp(join(tmpdir(),'shiwen-external-desktop-'));
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn){const deadline=Date.now()+90000;let last;while(Date.now()<deadline){try{const result=await fn();if(result)return result;}catch(e){last=e;}await delay(250);}throw last??Error('Timed out');}
let config,saved;
for(let round=0;round<2;round++){
 let output='',socket,mcp;
 await rm(join(data,'desktop/DevToolsActivePort'),{force:true});
 const env={...process.env,SHIWEN_ROOT_DIR:data};for(const key of ['ELECTRON_RUN_AS_NODE','NODE_PATH','NODE_OPTIONS','DSH_HOME','SHIWEN_DATA_DIR','SHIWEN_APP_PATCH'])delete env[key];
 const app=spawn(executable,['--remote-debugging-port=0'],{cwd:tmpdir(),env,stdio:['ignore','pipe','pipe']});
 app.stdout.on('data',chunk=>output+=chunk);app.stderr.on('data',chunk=>output+=chunk);const exited=new Promise(resolve=>app.once('exit',resolve));
 try{
  const port=await until(async()=>Number((await readFile(join(data,'desktop/DevToolsActivePort'),'utf8')).split('\n')[0]));
  const page=await until(async()=>(await(await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(p=>p.url.startsWith('dsh-app://app/')));
  socket=new WebSocket(page.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
  let id=0;const pending=new Map();socket.onmessage=event=>{const reply=JSON.parse(event.data),entry=pending.get(reply.id);if(entry){pending.delete(reply.id);reply.error?entry.reject(reply.error):entry.resolve(reply.result);}};
  const call=(method,params={})=>new Promise((resolve,reject)=>{const key=++id;pending.set(key,{resolve,reject});socket.send(JSON.stringify({id:key,method,params}));});
  const evaluate=async expression=>{const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
  const rpc=(method,args={})=>evaluate(`(async()=>{const r=await fetch('/api/shiwen',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(${JSON.stringify({method,args})})});const value=await r.json();if(!r.ok)throw Error(value.error);return value.result;})()`);
  await until(()=>evaluate("document.body.innerText.includes('素材')"));
  const click=label=>evaluate(`(()=>{const b=[...document.querySelectorAll('button,[role=button]')].find(x=>x.innerText.trim().endsWith(${JSON.stringify(label)})&&x.getBoundingClientRect().height>0);if(!b)return false;b.click();return true;})()`);
  if(!await click('外部接入')){await click('更多');await until(()=>click('外部接入'));}
  await until(()=>evaluate("document.querySelector('.sw-external')?.innerText.includes('添加客户端')"));
  if(round===0){
   await evaluate("(()=>{const input=document.querySelector('input[aria-label=\"客户端名称\"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'MCP 桌面验收');input.dispatchEvent(new Event('input',{bubbles:true}));})()");
   await until(()=>evaluate("!Array.from(document.querySelectorAll('.sw-external button')).find(x=>x.textContent==='创建凭据').disabled"));
   await click('创建凭据');await until(()=>evaluate("Boolean(document.querySelector('textarea[aria-label=\"MCP JSON\"]'))"));
   config=JSON.parse(await evaluate("document.querySelector('textarea[aria-label=\"MCP JSON\"]').value")).mcpServers.shiwen;
   assert.equal(config.command.startsWith(executable.slice(0,executable.lastIndexOf('/'))),true);
   await click('已保存，关闭显示');
   assert.equal(await evaluate("Boolean(document.querySelector('textarea[aria-label=\"Access token\"]'))"),false);
   for(const width of [1280,390]){
    await call('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});
    await delay(600); // Allow the native responsive sidebar transition to settle.
    await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    assert.equal(await evaluate("(()=>{const p=document.querySelector('.sw-external'),r=p.getBoundingClientRect();return p.scrollWidth>p.clientWidth+1||r.left<0||r.right>innerWidth+1;})()"),false);
    await writeFile(join(data,`external-access-${width}.png`),Buffer.from((await call('Page.captureScreenshot',{format:'png'})).data,'base64'));
   }
   await call('Emulation.clearDeviceMetricsOverride');
  }
  mcp=new Client({name:'packaged-mcp-test',version:'1.0.0'});
  await mcp.connect(new StdioClientTransport({command:config.command,args:config.args,env:{...env,...config.env},stderr:'pipe'}));
  assert.deepEqual((await mcp.listTools()).tools.map(tool=>tool.name),['shiwen_save','shiwen_collect']);
  const args={requestId:'desktop-mcp-journal',kind:'journal',origin:'personal',title:'外部 Agent 日记',body:'# 外部保存\n这是用户自己的日记。',day:'2026-11-05',source:{sessionId:'test-session',messageId:'test-message'}};
  const result=await mcp.callTool({name:'shiwen_save',arguments:args});assert.ok(!result.isError,JSON.stringify(result));
  const receipt=JSON.parse(result.content[0].text);if(round===0)saved=receipt;else assert.equal(receipt.id,saved.id);
  const record=await rpc('readMarkdown',{id:saved.id});assert.equal(record.origin,'personal');assert.equal(record.externalSources[0].client_name,'MCP 桌面验收');
  assert.equal((await rpc('snapshot')).records.length,1);
  if(round===0){
   await click('素材');await until(()=>evaluate("document.querySelector('.sw-library-view')?.innerText.includes('外部 Agent 日记')"));
   await evaluate("[...document.querySelectorAll('.sw-row')].find(x=>x.innerText.includes('外部 Agent 日记')).click()");
   await until(()=>evaluate("document.querySelector('.sw-detail')?.innerText.includes('外部保存与修改记录')"));
   await evaluate("[...document.querySelectorAll('.sw-detail details')].find(x=>x.innerText.includes('外部保存与修改记录')).open=true");
   assert.equal(await evaluate("document.querySelector('.sw-detail').innerText.includes('MCP 桌面验收')"),true);
   await writeFile(join(data,'external-record.png'),Buffer.from((await call('Page.captureScreenshot',{format:'png'})).data,'base64'));
  }else{
   await click('撤销凭据');await click('确认撤销');
   await until(async()=>(await rpc('externalStatus')).clients.every(c=>c.revoked));
   const refused=await mcp.callTool({name:'shiwen_save',arguments:{...args,requestId:'after-revocation'}});assert.equal(refused.isError,true);
  }
  await mcp.close();mcp=null;socket.close();socket=null;
  console.log(`External round ${round+1}: UI, packaged MCP, source identity, permissions, retry persistence and revocation passed.`);
 }finally{
  await mcp?.close();socket?.close();app.kill('SIGTERM');await Promise.race([exited,delay(5000)]);if(app.exitCode===null)app.kill('SIGKILL');
  await writeFile(join(data,`launch-${round+1}.log`),output);
 }
}
console.log('Isolated external verification:',data);
