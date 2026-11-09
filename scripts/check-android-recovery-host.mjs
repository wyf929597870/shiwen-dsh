// Phone-first initialization against an empty isolated Host, never the user's service.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {startServer,stopServer} from './server-control.mjs';

const root=await mkdtemp(join(tmpdir(),'shiwen-android-recovery-host-'));
const runtime=resolve(process.argv[2]??join(import.meta.dirname,'..'));
const password='Synthetic-Recovery-Host-9284',adb=process.env.ADB||'adb';
let service,serial,port,reverseInstalled=false;
const keepRoot=process.env.SHIWEN_KEEP_RECOVERY_HOST_ROOT==='1';
const run=(args,{allowFailure=false}={})=>{
 const result=spawnSync(adb,serial?['-s',serial,...args]:args,{encoding:'utf8',timeout:180_000,maxBuffer:8*1024*1024});
 if(result.error){
  const reason=result.error.code==='ETIMEDOUT'?'timed out after 180000 ms':`could not run (${result.error.code??'unknown error'})`;
  throw Error(`Android command ${reason}`);
 }
 if(!allowFailure&&result.status!==0)throw Error(`Android command failed (${result.status??'signal'})`);
 return result;
};
const cookies=response=>response.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');
try{
 const inventory=run(['devices']);
 const devices=inventory.stdout.split(/\r?\n/).map(line=>line.trim().split(/\s+/)).filter(parts=>parts[1]==='device').map(parts=>parts[0]);
 serial=process.env.ANDROID_SERIAL||null;
 if(serial&&!devices.includes(serial))throw Error('ANDROID_SERIAL is not an authorized connected device');
 if(!serial){if(devices.length!==1)throw Error('Connect one authorized Android device');serial=devices[0];}
 const user=process.env.ANDROID_USER??run(['shell','am','get-current-user']).stdout.trim();
 assert.match(user,/^\d+$/);
 service=await startServer({root,host:'127.0.0.1',port:0},{runtime,
  env:{...process.env,SHIWEN_SYNC_DIAGNOSTICS:process.env.SHIWEN_SYNC_DIAGNOSTICS??'1'}});
 const base=service.url.slice(0,-1);port=Number(new URL(base).port);
 const bootstrap=await fetch(service.loginUrl,{redirect:'manual'});assert.equal(bootstrap.status,303);
 const post=(path,body,cookie)=>fetch(`${base}${path}`,{method:'POST',redirect:'manual',headers:{'content-type':'application/json',origin:base,cookie},body:JSON.stringify(body)});
 const setup=await post('/auth/password',{password},cookies(bootstrap));assert.equal(setup.status,200);
 const ownerCookie=cookies(setup);assert.ok(ownerCookie);
 const sync=async(action,request)=>{const response=await post('/api/shiwen',{method:'mobileSync',args:{action,request}},ownerCookie);
  const payload=await response.json();assert.equal(response.status,200,JSON.stringify(payload));return payload.result.data;};
 const deviceId=randomUUID();
 const before=await sync('identity',{protocolVersion:'1.0.0-draft.3',deviceId});
 run(['reverse',`tcp:${port}`,`tcp:${port}`]);reverseInstalled=true;
 const result=run(['shell','am','instrument','--user',user,'-w','-e','class','io.github.wyf929597870.shiwen.library.LibraryRecoveryHostTest',
  '-e','syntheticRecoveryHost',base,'-e','syntheticPassword',password,
  'io.github.wyf929597870.shiwen.probe.test/androidx.test.runner.AndroidJUnitRunner'],{allowFailure:true});
 const output=(result.stdout+'\n'+result.stderr).replaceAll(password,'[redacted]');
 if(result.status!==0||!/OK \(1 test\)/.test(output)||/FAILURES!!!|INSTRUMENTATION_FAILED/.test(output))throw Error('Android recovery test failed.\n'+output.trim().split(/\r?\n/).slice(-20).join('\n').slice(-8_000));
 const after=await sync('identity',{protocolVersion:'1.0.0-draft.3',deviceId});
 assert.notEqual(after.libraryId,before.libraryId);
 const snapshot=await sync('bootstrapBegin',{libraryId:after.libraryId,epoch:after.epoch,deviceId});
 assert.equal(snapshot.manifest.counts.records,2);assert.equal(snapshot.manifest.counts.versions,6);
 assert.equal(snapshot.manifest.counts.activities,6);assert.equal(snapshot.manifest.counts.attachments,1);
 console.log('Android coordinator rebuild and replica convergence passed: phone-first setup, second-device bootstrap, cross-device edit, original attachment, and full resync.');
 console.log('Uses a temporary isolated Host and USB reverse; no personal service or paid model calls.');
}finally{
 if(reverseInstalled)try{run(['reverse','--remove',`tcp:${port}`],{allowFailure:true});}catch{}
 try{if(service)await stopServer(root);}catch{}
 finally{if(keepRoot)console.log(`Synthetic Host root preserved for diagnostics: ${root}`);else await rm(root,{recursive:true,force:true});}
}
