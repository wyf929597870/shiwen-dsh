// Install the packed bundle into stock DSH, with a disposable home and no model calls.
import {spawn,execFileSync} from 'node:child_process';
import {mkdtemp,readFile,writeFile,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
const root=resolve(import.meta.dirname,'..'),cli=join(root,'node_modules/@deepseek-ai/dsh/lib/bin.js');
const archive=resolve(process.argv[2]??'release/dsh-shiwen-0.2.0-dev.0.tgz');
const data=await mkdtemp(join(tmpdir(),'shiwen-web-plugin-'));
const env={...process.env,DSH_HOME:join(data,'home'),DSH_AGENTS_HOME:join(data,'agents'),DSH_TELEMETRY_DISABLED:'1'};
for(const key of ['SHIWEN_DATA_DIR','SHIWEN_ROOT_DIR','SHIWEN_DESKTOP','SHIWEN_APP_PATCH','ELECTRON_RUN_AS_NODE'])delete env[key];
const run=args=>execFileSync(process.execPath,[cli,...args],{env,cwd:data,encoding:'utf8',stdio:['ignore','pipe','pipe']});
run(['--profile','web','--dump-config']);
run(['plugin','--profile','web','add',archive,'--ignore-scripts']);
const profile=join(env.DSH_HOME,'profiles/web'),patchPath=join(profile,'cordis.patch.yml');
const defaults=[{id:'workspace-controller',config:{documentsDirectory:join(data,'workspaces')}},{id:'locale',config:{preference:'zh'}}];
const appearance=JSON.parse(JSON.stringify([{id:'shiwen-theme',disabled:false},{id:'ui-brand-official',disabled:true},{id:'shiwen-personal-context',disabled:false},{id:'preset-shiwen',disabled:false},{id:'agent-preset-registry',config:{default:'shiwen'}}]));
const pause=ms=>new Promise(done=>setTimeout(done,ms));
async function until(fn){let last;for(let i=0;i<180;i++){try{const value=await fn();if(value)return value;}catch(error){last=error;}await pause(250);}throw last??Error('Web startup timed out');}
let record,issued,receipt;
const source={requestId:'web-plugin-mcp-retry',kind:'idea',origin:'personal',body:'通过 Web 插件保存的个人想法',day:'2026-10-15'};
for(let round=0;round<4;round++){
 if(round===2){
  await writeFile(patchPath,JSON.stringify(defaults));
  run(['plugin','--profile','web','remove','dsh-shiwen']);
 }else if(round===3){run(['plugin','--profile','web','add',archive,'--ignore-scripts']);}
 await writeFile(patchPath,JSON.stringify(round===1||round===3?[...defaults,...appearance]:defaults));
 let output='',mcp;
 const child=spawn(process.execPath,[cli,'web','--no-open','--port','0'],{cwd:data,env,stdio:['ignore','pipe','pipe']});
 child.stdout.on('data',c=>output+=c);child.stderr.on('data',c=>output+=c);
 const exited=new Promise(done=>child.once('exit',done));
 try{
  const url=await until(()=>{if(child.exitCode!==null)throw Error('DSH exited: '+output);return output.match(/dsh web: (https?:\/\/[^\s]+)/)?.[1];});
  const base=new URL(url).origin;
  assert.equal((await fetch(base+'/')).status,401);
  const landing=await fetch(url,{redirect:'manual'});assert.equal(landing.status,303);
  const cookie=landing.headers.getSetCookie().map(s=>s.split(';')[0]).join('; ');assert.ok(cookie);
  const page=await fetch(base+'/',{headers:{cookie}});assert.equal(page.status,200);const html=await page.text();
  assert.equal(html.includes('@shiwen/dsh-workbench'),round!==2);
  assert.equal(html.includes('@shiwen/dsh-theme'),round===1||round===3);
  const raw=(method,args={},origin=base)=>fetch(base+'/api/shiwen',{method:'POST',headers:{cookie,origin,'content-type':'application/json'},body:JSON.stringify({method,args})});
  const rpc=async(method,args={})=>{const r=await raw(method,args);const body=await r.json();assert.equal(r.status,200,JSON.stringify(body));return body.result;};
  if(round===2){
   assert.notEqual((await raw('snapshot')).status,200);
   assert.ok((await stat(join(env.DSH_HOME,'shiwen/web/library/library.sqlite'))).size>0);
   console.log('Uninstall: native DSH remains available; Shiwen routes removed and library retained.');
   continue;
  }
  assert.equal((await raw('snapshot',{},'https://untrusted.example')).status,403);
  if(round===0){
   assert.equal((await rpc('snapshot')).records.length,0);
   record=await rpc('saveMarkdown',{kind:'journal',title:'Web 插件验收日记',body:'# 标题\n\n我的原始日记。'});
   record=await rpc('updateRecord',{id:record.id,revision:record.revision,day:'2026-10-12',origin:'personal'});
   issued=await rpc('externalClientCreate',{name:'Web acceptance MCP',scopes:['create','read']});
  }else{
   assert.equal((await rpc('readMarkdown',{id:record.id})).dateInfo.day,'2026-10-12');
   const logo=await fetch(base+'/shiwen-brand.png',{headers:{cookie}});assert.equal(logo.status,200);assert.equal(logo.headers.get('content-type'),'image/png');
  }
  const status=await rpc('externalStatus');assert.equal(status.root,join(env.DSH_HOME,'shiwen/web'));
  assert.equal(status.command,process.execPath);assert.ok(status.args[0].endsWith('integration/cli.mjs'));
  mcp=new Client({name:'shiwen-web-acceptance',version:'1.0.0'});
  await mcp.connect(new StdioClientTransport({command:status.command,args:[...status.args,'mcp'],env:{...env,SHIWEN_ROOT_DIR:status.root,SHIWEN_TOKEN:issued.token},stderr:'pipe'}));
  const saved=await mcp.callTool({name:'shiwen_save',arguments:source});assert.ok(!saved.isError,JSON.stringify(saved));
  const next=JSON.parse(saved.content[0].text);if(receipt)assert.equal(next.id,receipt.id);else receipt=next;
  const records=(await rpc('snapshot')).records;assert.equal(records.length,2);assert.equal(records[0].id,receipt.id);
  assert.equal((await rpc('readMarkdown',{id:receipt.id})).origin,'personal');
  await rpc('review',{period:'month',month:'2026-10'});
  if(round===3){
   const deleted=await rpc('remove',{id:record.id,revision:record.revision});
   await rpc('restoreRemoved',{id:record.id,revision:deleted.revision});
   await rpc('externalClientRevoke',{id:issued.id});
   const denied=await mcp.callTool({name:'shiwen_save',arguments:{...source,requestId:'revoked'}});assert.equal(denied.isError,true);
  }
  await mcp.close();mcp=null;
  console.log(`Round ${round+1}: stock Web auth, client roster, record dates/order, MCP provenance and persistence passed.`);
 }finally{
  await mcp?.close();child.kill('SIGTERM');await Promise.race([exited,pause(3000)]);if(child.exitCode===null){child.kill('SIGKILL');await exited;}
  await writeFile(join(data,`host-${round}.log`),output.replace(/([?&]token=)[^\s]+/g,'$1[redacted]'));
 }
}
console.log('Isolated Web verification:',data);
