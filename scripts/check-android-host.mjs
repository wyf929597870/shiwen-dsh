// Real Android-native -> isolated DSH Host check. Uses USB adb reverse; it is not a Wi-Fi/LAN test.
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {startServer,stopServer} from './server-control.mjs';

const root=await mkdtemp(join(tmpdir(),'shiwen-android-host-'));
const runtime=resolve(process.argv[2]??join(import.meta.dirname,'..'));
const password='Synthetic-Android-Host-9284';
let service,adb,serial,port,reverseInstalled=false;
const run=(args,{allowFailure=false}={})=>{
 const result=spawnSync(adb,args,{encoding:'utf8',timeout:180_000,maxBuffer:8*1024*1024});
 if(result.error)throw Error('Android command could not run');
 if(!allowFailure&&result.status!==0)throw Error(`Android command failed (${result.status??'signal'})`);
 return result;
};
const adbArgs=args=>serial?['-s',serial,...args]:args;
const cookieOf=response=>response.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');
const request=async(url,body,cookie='')=>fetch(url,{method:'POST',redirect:'manual',headers:{'content-type':'application/json','origin':service.url.slice(0,-1),...(cookie?{cookie}:{})},body:JSON.stringify(body)});
const redact=value=>String(value??'').replaceAll(password,'[redacted]')
 .replace(/(?:set-cookie|cookie):[^\r\n]*/gi,match=>match.slice(0,match.indexOf(':'))+':[redacted]')
 .replace(/sw_[A-Za-z0-9_-]{20,}/g,'[redacted]');
try{
 adb=process.env.ADB||'adb';
 const inventory=spawnSync(adb,['devices'],{encoding:'utf8',timeout:10_000});
 if(inventory.error||inventory.status!==0)throw Error('adb is unavailable');
 const devices=inventory.stdout.split(/\r?\n/).map(line=>line.trim().split(/\s+/))
  .filter(parts=>parts.length>1&&parts[1]==='device').map(parts=>parts[0]);
 serial=process.env.ANDROID_SERIAL||null;
 if(serial&&!devices.includes(serial))throw Error('ANDROID_SERIAL is not an authorized connected device');
 if(!serial){if(devices.length!==1)throw Error('Connect one authorized Android device or set ANDROID_SERIAL');serial=devices[0];}
 const userResult=process.env.ANDROID_USER?null:spawnSync(adb,['-s',serial,'shell','am','get-current-user'],{encoding:'utf8',timeout:10_000});
 const user=process.env.ANDROID_USER??userResult?.stdout.trim();
 if((!process.env.ANDROID_USER&&(userResult?.error||userResult?.status!==0))||!/^\d+$/.test(user??''))throw Error('Unable to determine Android user; set ANDROID_USER explicitly');

 service=await startServer({root,host:'127.0.0.1',port:0},{runtime});
 const base=service.url.slice(0,-1),hostPort=Number(new URL(service.url).port);
 port=hostPort;
 assert.ok(Number.isInteger(hostPort)&&hostPort>0);
 // Configure only the temporary host, then let Android perform its own password login.
 const bootstrap=await fetch(service.loginUrl,{redirect:'manual'});
 if(bootstrap.status!==303)throw Error(`Synthetic host bootstrap failed (${bootstrap.status})`);
 const bootstrapCookie=cookieOf(bootstrap);
 if(!bootstrapCookie)throw Error('Synthetic host bootstrap cookie is missing');
 const setup=await request(`${base}/auth/password`,{password},bootstrapCookie);
 if(setup.status!==200)throw Error(`Synthetic host password setup failed (${setup.status})`);

 run(adbArgs(['reverse',`tcp:${hostPort}`,`tcp:${hostPort}`]));reverseInstalled=true;
 const host='http://127.0.0.1:'+hostPort;
 const appId='io.github.wyf929597870.shiwen.probe.test';
 const instrumentation=run(adbArgs(['shell','am','instrument','--user',user,'-w',
  '-e','class','io.github.wyf929597870.shiwen.network.NodeRealHostTest',
  '-e','syntheticHost',host,'-e','syntheticPassword',password,
  `${appId}/androidx.test.runner.AndroidJUnitRunner`]),{allowFailure:true});
 const output=redact((instrumentation.stdout||'')+'\n'+(instrumentation.stderr||''));
 if(instrumentation.status!==0||!/OK \(1 test\)/.test(output)||/FAILURES!!!|INSTRUMENTATION_FAILED/.test(output)){
  const tail=output.trim().split(/\r?\n/).slice(-16).join('\n');
  throw Error(`Android real Host instrumentation failed (${instrumentation.status??'signal'}).\n${tail}`);
 }
 console.log('Android real Host integration passed: password login, profile sync, capabilities, plugin bundles, schedules list, external status.');
 console.log('Transport was USB adb reverse to a temporary isolated Host; Wi-Fi/LAN access was not tested.');
}finally{
 if(reverseInstalled&&port!==undefined){
  try{run(adbArgs(['reverse','--remove',`tcp:${port}`]),{allowFailure:true});}catch{}
 }
 try{if(service)await stopServer(root);}catch{}
 finally{await rm(root,{recursive:true,force:true});}
}
