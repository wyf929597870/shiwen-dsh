// Launch the real desktop Host through its IPC contract; no Electron UI or model calls.
// Both clients authenticate independently against this one Host and temporary library.
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import assert from 'node:assert/strict';
import {setupProfile} from './profile.mjs';
const root=resolve(import.meta.dirname,'..');
const resources=resolve(process.argv[2]??join(root,'debug/linux/linux-unpacked/resources'));
const runtime=join(resources,'dsh'),entry=join(runtime,'node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js');
const data=await mkdtemp(join(tmpdir(),'shiwen-shared-host-'));
const home=join(data,'dsh');
const pluginRoot=process.argv.includes('--packaged')?join(resources,'shiwen/plugins'):join(root,'plugins');
const {profile,appPatch}=await setupProfile({root,home,pluginRoot});
const env={...process.env,DSH_HOME:home,DSH_AGENTS_HOME:join(data,'agents'),SHIWEN_DATA_DIR:join(data,'library'),SHIWEN_APP_PATCH:appPatch,DSH_TELEMETRY_DISABLED:'1'};
for(const key of ['ELECTRON_RUN_AS_NODE','NODE_OPTIONS','NODE_PATH','SHIWEN_DESKTOP','SHIWEN_ROOT_DIR'])delete env[key];
let saved,previousLogin;
const delay=ms=>new Promise(done=>setTimeout(done,ms));
for(let round=0;round<2;round++){
 let output='';
 const host=spawn(process.execPath,['--expose-internals',entry,runtime,profile,join(resources,'runtime/primary-runtime')],{cwd:profile,env,stdio:['ignore','pipe','pipe','ipc']});
 host.stdout.on('data',c=>output+=c);host.stderr.on('data',c=>output+=c);
 const exited=new Promise(done=>host.once('exit',done));
 try{
  const ready=await new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>reject(Error('Desktop Host startup timed out')),60000);
   const fail=error=>{clearTimeout(timer);reject(error);};
   host.once('error',fail);host.once('exit',()=>fail(Error('Desktop Host exited before ready')));
   host.on('message',m=>{if(m.type==='ready'){clearTimeout(timer);resolve(m);}if(m.type==='fatal')fail(Error(m.message));});
  });
  const base=new URL(ready.url).origin;
  const authenticate=async url=>{
   const response=await fetch(url,{redirect:'manual'});assert.equal(response.status,303);
   const cookie=response.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ');assert.ok(cookie);
   const page=await fetch(base+'/',{headers:{cookie}});assert.equal(page.status,200);
   assert.match(await page.text(),/@shiwen\/dsh-workbench/);
   const forbidden=await fetch(base+'/api/shiwen',{method:'POST',headers:{cookie,origin:'https://untrusted.example','content-type':'application/json'},body:'{"method":"browserLogin"}'});
   assert.equal(forbidden.status,403);
   return async(method,args={})=>{
    const r=await fetch(base+'/api/shiwen',{method:'POST',headers:{cookie,origin:base,'content-type':'application/json'},body:JSON.stringify({method,args})});
    const body=await r.json();if(!r.ok)throw Error(body.error);return body.result;
   };
  };
  const desktop=await authenticate(ready.url);
  const status=await desktop('browserStatus');assert.equal(status.profile,'desktop');
  assert.equal(status.library,join(data,'library'));assert.equal('loginUrl' in status,false);
  const {loginUrl}=await desktop('browserLogin');assert.equal(new URL(loginUrl).origin,base);
  assert.equal((await fetch(base+'/api/shiwen',{method:'POST',headers:{'content-type':'application/json'},body:'{"method":"browserLogin"}'})).status,401);
  // A valid API owner must not exchange its connection-scoped Cookie for a browser login.
  for(const interactions of ['none','answer']){
   const connect=new URL(ready.url);connect.pathname='/connect';connect.searchParams.set('interactions',interactions);
   const admission=await fetch(connect,{redirect:'manual'});assert.equal(admission.status,302);
   const cookie=admission.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ');assert.ok(cookie);
   const api=method=>fetch(base+'/api/shiwen',{method:'POST',headers:{cookie,origin:base,'content-type':'application/json'},body:JSON.stringify({method})});
   assert.equal((await api('snapshot')).status,200);
   assert.equal((await fetch(base+'/',{headers:{cookie}})).status,401);
   const denied=await api('browserLogin');assert.equal(denied.status,403);
   assert.equal(denied.headers.get('cache-control'),'no-store');
   const body=await denied.json();assert.equal('result' in body,false);assert.ok(body.error);
   assert.equal(JSON.stringify(body).includes('token='),false);
  }
  const browser=await authenticate(loginUrl);
  if(previousLogin){
   const old=new URL(previousLogin);old.host=new URL(base).host;
   assert.equal((await fetch(old,{redirect:'manual'})).status,401);
   assert.equal((await browser('readMarkdown',{id:saved.id})).title,'浏览器修改');
  }else{
   saved=await desktop('saveMarkdown',{kind:'journal',title:'桌面创建',body:'同一个后端，同一条记录。'});
   const fromBrowser=await browser('readMarkdown',{id:saved.id});assert.equal(fromBrowser.title,'桌面创建');
   saved=await browser('updateRecord',{id:saved.id,revision:fromBrowser.revision,title:'浏览器修改',day:'2026-10-12',origin:'personal'});
   assert.equal((await desktop('readMarkdown',{id:saved.id})).title,'浏览器修改');
   await assert.rejects(()=>desktop('saveMarkdown',{id:saved.id,revision:fromBrowser.revision,kind:'journal',title:'过期草稿',body:'不能覆盖浏览器修改'}),/更新/);
   const receipt=await desktop('remove',{id:saved.id,revision:saved.revision});
   assert.equal((await browser('snapshot')).records.length,0);
   await browser('restoreRemoved',{id:saved.id,revision:receipt.revision});
   assert.equal((await desktop('snapshot')).records.length,1);
   assert.deepEqual(await desktop('review',{period:'month',month:'2026-10'}),await browser('review',{period:'month',month:'2026-10'}));
  }
  previousLogin=loginUrl;
  console.log(`Round ${round+1}: desktop Host IPC, browser login, API Peer credential denial, shared records, revision conflicts, deletion/restore and restart passed.`);
 }finally{
  if(host.connected)host.send({type:'shutdown'});
  await Promise.race([exited,delay(3000)]);
  if(host.exitCode===null){host.kill('SIGKILL');await exited;}
  await writeFile(join(data,`host-${round}.log`),output.replace(/([?&]token=)[^\s]+/g,'$1[redacted]'),{mode:0o600});
 }
}
console.log('Isolated shared Host verification:',data);
