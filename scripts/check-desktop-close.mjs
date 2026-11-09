// Real Electron window lifecycle against an isolated, loopback-only service.
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import assert from 'node:assert/strict';
import {startServer,stopServer,controlServer} from './server-control.mjs';
const executable=resolve(process.argv[2]),resources=join(dirname(executable),'resources/shiwen');
const root=await mkdtemp(join(tmpdir(),'shiwen-close-check-'));
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){const end=Date.now()+30000;let error;while(Date.now()<end){try{const value=await fn();if(value)return value;}catch(e){error=e;}await pause(100);}throw error??Error('Desktop close check timed out');}
const service=await startServer({root,host:'127.0.0.1',port:0,discoverLan:false},{runtime:resources,worker:join(resources,'scripts/server-worker.mjs'),node:join(resources,'../runtime/primary-runtime/dependencies/node/bin/node')});
const login=await fetch(service.loginUrl,{redirect:'manual'}),cookie=login.headers.getSetCookie().map(s=>s.split(';')[0]).join('; ');
assert.equal((await fetch(new URL('/auth/password',service.url),{method:'POST',headers:{'Content-Type':'application/json',Origin:new URL(service.url).origin,cookie},body:JSON.stringify({password:'Isolated-close-acceptance-8321'})})).status,200);
await mkdir(join(root,'desktop'),{recursive:true});await writeFile(join(root,'desktop/connection.json'),JSON.stringify({mode:'local',lan:false,port:Number(new URL(service.url).port)}));
let child,socket;
try{
 for(let round=0;round<2;round++){
  const env={...process.env,SHIWEN_ROOT_DIR:root};for(const key of ['ELECTRON_RUN_AS_NODE','NODE_OPTIONS','NODE_PATH','DSH_HOME'])delete env[key];
  let output='';child=spawn(executable,['--no-sandbox','--inspect=0'],{env,stdio:['ignore','pipe','pipe']});child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
  const inspector=await until(()=>output.match(/Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[^\s]+)/)?.[1]);
  socket=new WebSocket(inspector);await new Promise((yes,no)=>{socket.onopen=yes;socket.onerror=no;});
  let next=0;const waiting=new Map();socket.onmessage=e=>{const value=JSON.parse(e.data);if(value.id){const task=waiting.get(value.id);waiting.delete(value.id);value.error?task?.reject(Error(value.error.message)):task?.resolve(value.result);}};
  const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++next;waiting.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));});
  const evaluate=async expression=>{const reply=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(reply.exceptionDetails)throw Error(JSON.stringify(reply.exceptionDetails));return reply.result.value;};
  await evaluate("globalThis.testElectron=process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron');globalThis.prompts=[];globalThis.choice=2;testElectron.dialog.showMessageBox=async (...args)=>{prompts.push(args.at(-1));return {response:choice};};");
  await until(()=>evaluate("testElectron.BrowserWindow.getAllWindows().some(w=>w.isVisible()&&w.webContents.getURL().startsWith('http'))"));
  await evaluate("globalThis.mainWindow=testElectron.BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().startsWith('http'));globalThis.menu=()=>testElectron.Menu.getApplicationMenu().items[0].submenu.items;");
  const settings=async()=>{
   await evaluate("menu().find(i=>i.label.includes('桌面设置')||i.label.includes('desktop settings')).click()");
   await until(()=>evaluate("testElectron.BrowserWindow.getAllWindows().some(w=>w.webContents.getURL().endsWith('/connection.html'))"));
   await evaluate("globalThis.settingsWindow=testElectron.BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('/connection.html'))");
   await until(()=>evaluate("settingsWindow.webContents.executeJavaScript(\"!document.querySelector('#closeAction').disabled\")"));
  };
  const choose=async action=>{
   await settings();
   const code=`document.querySelector('#closeAction').value=${JSON.stringify(action)};document.querySelector('#closeAction').dispatchEvent(new Event('change',{bubbles:true}));`;
   await evaluate(`settingsWindow.webContents.executeJavaScript(${JSON.stringify(code)})`);
   await until(async()=>JSON.parse(await readFile(join(root,'desktop/preferences.json'),'utf8')).closeAction===action);
   await until(()=>evaluate("settingsWindow.webContents.executeJavaScript(\"!document.querySelector('#closeAction').disabled\")"));
   await evaluate('settingsWindow.close()');
  };
  if(round===0)await choose('tray');
  else{await settings();assert.equal(await evaluate("settingsWindow.webContents.executeJavaScript(\"document.querySelector('#closeAction').value\")"),'tray');await evaluate('settingsWindow.close()');}
  await evaluate('mainWindow.close()');await until(()=>evaluate('!mainWindow.isVisible()'));
  assert.equal(await evaluate('mainWindow.isDestroyed()'),false);assert.equal(await evaluate('prompts.length'),0);assert.ok(await controlServer(root,'status'));
  if(round===0){
   await evaluate("menu().find(i=>i.label==='退出'||i.label==='Quit').click()");await until(()=>evaluate('prompts.length===1'));
   assert.equal(await evaluate('mainWindow.isVisible()'),true);assert.equal(await evaluate('prompts[0].buttons.length'),3);
   const labels=await evaluate('prompts[0].buttons.join("|")');assert.match(labels,/保留服务并退出|Keep service and quit/);assert.match(labels,/停止服务并退出|Stop service and quit/);assert.match(labels,/取消|Cancel/);
   await choose('quit');await evaluate('mainWindow.close()');await until(()=>evaluate('prompts.length===2'));assert.equal(await evaluate('mainWindow.isVisible()'),true);assert.ok(await controlServer(root,'status'));
   await choose('tray');await evaluate("choice=0;setTimeout(()=>menu().find(i=>i.label==='退出'||i.label==='Quit').click(),100);true");
  }else{
   await choose('quit');await evaluate('choice=1;setTimeout(()=>mainWindow.close(),100);true');
  }
  socket.close();socket=null;
  await until(()=>child.exitCode!==null||child.signalCode!==null);
  if(round===0)assert.ok(await controlServer(root,'status'));else assert.equal(await controlServer(root,'status'),null);
  console.log(`Round ${round+1}: tray hide, persisted preference and ${round===0?'cancel/keep service':'stop service'} passed.`);child=null;
 }
 console.log('Desktop close lifecycle verified in isolated root:',root);
}finally{socket?.close();if(child&&child.exitCode===null)child.kill('SIGKILL');await stopServer(root).catch(()=>{});}
