// Real Node-only host, isolated library, no models or user data.
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import assert from 'node:assert/strict';
import {setupProfile} from './profile.mjs';
const root=await mkdtemp(join(tmpdir(),'shiwen-service-'));
const host=process.argv[2]??'127.0.0.1';
const env={...process.env,DSH_AGENTS_HOME:join(root,'agents'),DSH_TELEMETRY_DISABLED:'1'};
for(const key of ['DSH_HOME','SHIWEN_ROOT_DIR','SHIWEN_DATA_DIR','SHIWEN_DESKTOP','SHIWEN_APP_PATCH'])delete env[key];
async function cli(command,args=[],success=true){
 const child=spawn(process.execPath,[join(import.meta.dirname,'server.mjs'),command,'--root',root,...args],{env,stdio:['ignore','pipe','pipe']});
 let stdout='',stderr='';child.stdout.on('data',c=>stdout+=c);child.stderr.on('data',c=>stderr+=c);
 const code=await new Promise((yes,no)=>{child.once('error',no);child.once('exit',yes);});
 if(success)assert.equal(code,0,stderr);else assert.notEqual(code,0);
 return stdout;
}
const delay=ms=>new Promise(yes=>setTimeout(yes,ms));
async function stop(){
 await cli('stop');
 for(let n=0;n<80;n++){
  try{await readFile(join(root,'server/running.json'));}catch(error){if(error.code==='ENOENT')return;throw error;}
  await delay(100);
 }
 throw Error('Service did not stop');
}
let record,oldLogin;
try{
 for(let round=0;round<2;round++){
  await cli('start',['--host',host,'--port','0']);
  const status=JSON.parse(await cli('status'));assert.equal(status.library,join(root,'library'));
  assert.equal('loginUrl' in status,false);
  const manifest=join(root,'dsh/profiles/desktop/package.json'),before=await readFile(manifest,'utf8');
  await assert.rejects(()=>setupProfile({root:join(import.meta.dirname,'..'),home:join(root,'dsh'),relocate:true}),/Stop the server/);
  assert.equal(await readFile(manifest,'utf8'),before);
  assert.equal((await stat(join(root,'server/running.json'))).mode&0o777,0o600);
  await cli('start',['--host',host,'--port','0'],false);
  const login=(await cli('url')).trim(),base=new URL(login).origin;
  assert.equal((await fetch(base,{redirect:'manual'})).status,303);
  if(oldLogin){const expired=new URL(oldLogin);expired.host=new URL(base).host;assert.equal((await fetch(expired,{redirect:'manual'})).status,401);}
  const client=async()=>{
   const fresh=(await cli('url')).trim();
   const auth=await fetch(fresh,{redirect:'manual'});assert.equal(auth.status,303);
   const cookie=auth.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');
   assert.equal((await fetch(base,{headers:{cookie}})).status,200);
   const rejected=await fetch(base+'/api/shiwen',{method:'POST',headers:{cookie,origin:'https://untrusted.example','content-type':'application/json'},body:'{"method":"browserLogin"}'});assert.equal(rejected.status,403);
   return async(method,args={})=>{
    const response=await fetch(base+'/api/shiwen',{method:'POST',headers:{cookie,origin:base,'content-type':'application/json'},body:JSON.stringify({method,args})});
    const result=await response.json();assert.equal(response.status,200,result.error);return result.result;
   };
  };
  const a=await client(),b=await client();
  assert.equal((await a('browserStatus')).desktop,false);
  assert.equal(new URL((await a('browserLogin')).loginUrl).origin,base);
  if(!record){
   record=await a('saveMarkdown',{kind:'journal',title:'Shared service',body:'Created by browser A'});
   const fromB=await b('readMarkdown',{id:record.id});assert.equal(fromB.title,record.title);
   record=await b('updateRecord',{id:record.id,revision:fromB.revision,title:'Updated by browser B',day:'2026-10-12',origin:'personal'});
   assert.equal((await a('readMarkdown',{id:record.id})).title,'Updated by browser B');
  }else assert.equal((await b('readMarkdown',{id:record.id})).title,'Updated by browser B');
  const log=await readFile(join(root,'server/server.log'),'utf8');assert.equal(log.includes(new URL(login).searchParams.get('token')),false);
  assert.equal(log.includes('did not activate'),false);
  oldLogin=login;await stop();
  console.log(`Round ${round+1}: ${host}, authentication, two clients, owner exclusion and persistence passed.`);
 }
}finally{try{await cli('stop');}catch{}}
console.log('Isolated verification data:',root);
