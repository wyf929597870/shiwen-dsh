// Process/API smoke test. No GUI automation or personal data. Dialog choices have unit coverage.
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import assert from 'node:assert/strict';
import {controlServer,ensureServer,stopServer} from './server-control.mjs';
const repo=resolve(import.meta.dirname,'..'),packaged=process.argv[2]?resolve(process.argv[2]):null;
const root=await mkdtemp(join(tmpdir(),'shiwen-client-check-'));
const executable=packaged?join(packaged,'shiwen-dsh'):join(repo,'.runtime/electron-44.7.0/electron');
const args=packaged?[]:[join(repo,'desktop')];
const env={...process.env,SHIWEN_ROOT_DIR:root,SHIWEN_NODE_EXECUTABLE:process.execPath,DSH_AGENTS_HOME:join(root,'agents'),DSH_TELEMETRY_DISABLED:'1'};delete env.ELECTRON_RUN_AS_NODE;
const directory=join(root,'desktop');await mkdir(directory,{recursive:true});
const prefs=join(directory,'connection.json');
await writeFile(prefs,JSON.stringify({mode:'local',lan:process.argv.includes('--lan'),port:3099}));
const delay=ms=>new Promise(yes=>setTimeout(yes,ms));
let child;
async function launch(expected='[shiwen-client] connected '){
 let output='';child=spawn(executable,args,{cwd:tmpdir(),env,stdio:['ignore','pipe','pipe']});
 child.stdout.on('data',data=>output+=data);child.stderr.on('data',data=>output+=data);
 for(let n=0;n<600;n++){
  if(output.includes(expected))return output;
  if(expected.includes('connected')&&output.includes('[shiwen-client]')&&!output.includes('connected'))break;
  if(child.exitCode!==null)break;
  await delay(100);
 }
 await writeFile(join(root,'client-error.log'),output.replace(/([?&]token=)[^\s&]+/g,'$1[hidden]'));
 throw Error('Client did not connect; inspect '+join(root,'client-error.log'));
}
async function terminateClient(){
 if(!child||child.exitCode!==null)return;
 const exited=new Promise(yes=>child.once('exit',yes));child.kill('SIGKILL');await exited;child=null;
}
try{
 // OS termination is intentionally distinct from a normal, prompted desktop exit.
 const first=await launch();assert.match(first,/connected local/);
 const initial=await controlServer(root,'status');assert.ok(initial?.pid);
 await terminateClient();assert.equal((await controlServer(root,'status')).pid,initial.pid);
 const second=await launch();assert.match(second,/connected local/);assert.equal((await controlServer(root,'status')).pid,initial.pid);
 await terminateClient();
 const local=await controlServer(root,'url');assert.ok(local.loginUrl);
 await writeFile(prefs,JSON.stringify({mode:'remote',address:local.url}));
 const recognized=await launch();assert.match(recognized,/connected local/);
 assert.equal((await controlServer(root,'status')).pid,initial.pid);
 assert.equal(JSON.parse(await readFile(prefs,'utf8')).mode,'local');
 await terminateClient();
 const joined=await ensureServer({root,host:'127.0.0.1',port:3099},{node:'must-not-spawn'});assert.equal(joined.pid,initial.pid);assert.equal(joined.started,false);
 await assert.rejects(()=>stopServer(root,{secret:'different-instance'}),/Service changed/);
 assert.equal((await controlServer(root,'status')).pid,initial.pid);
 await stopServer(root,initial.state);assert.equal(await controlServer(root,'status'),null);
 await writeFile(prefs,JSON.stringify({mode:'remote',address:'http://127.0.0.1:1/'}));
 const failed=await launch('[shiwen-client]');assert.equal(failed.includes('connected remote'),false);assert.equal(await controlServer(root,'status'),null);
 await terminateClient();
 console.log('Desktop auto-start, authenticated page load, reuse, process independence, identity fencing, local-address recognition, stop and remote failure without local fallback passed:',root);
}finally{await terminateClient();try{await stopServer(root);}catch{}}
