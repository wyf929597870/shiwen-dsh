// Real Android-native -> isolated DSH Host check. Uses USB adb reverse; it is not a Wi-Fi/LAN test.
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {contentHash} from '../plugins/library/src/sync/canonical.mjs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {startServer,stopServer} from './server-control.mjs';

const root=await mkdtemp(join(tmpdir(),'shiwen-android-sync-host-'));
const runtime=resolve(process.argv[2]??join(import.meta.dirname,'..'));
const password='Synthetic-Android-Host-9284';
let service,adb,serial,port,reverseInstalled=false,passed=false;
const run=(args,{allowFailure=false}={})=>{
 const result=spawnSync(adb,args,{encoding:'utf8',timeout:180_000,maxBuffer:8*1024*1024});
 if(result.error){
  const reason=result.error.code==='ETIMEDOUT'?'timed out after 180000 ms':`could not run (${result.error.code??'unknown error'})`;
  throw Error(`Android command ${reason}`);
 }
 if(!allowFailure&&result.status!==0)throw Error(`Android command failed (${result.status??'signal'})`);
 return result;
};
const adbArgs=args=>serial?['-s',serial,...args]:args;
const cookieOf=response=>response.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');
const request=async(url,body,cookie='')=>fetch(url,{method:'POST',redirect:'manual',headers:{'content-type':'application/json','connection':'close','origin':service.url.slice(0,-1),...(cookie?{cookie}:{})},body:JSON.stringify(body)});
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

 const ownerCookie=cookieOf(setup);assert.ok(ownerCookie);
 const sync=async(action,body)=>{
  let response;
  try{response=await request(`${base}/api/shiwen`,{method:'mobileSync',args:{action,request:body}},ownerCookie);}
  catch(error){let alive=false;try{process.kill(service.pid,0);alive=true;}catch{};console.error(`Synthetic sync HTTP failed: action=${action}, hostAlive=${alive}`);throw error;}
  const result=await response.json();assert.equal(response.status,200,JSON.stringify(result));return result.result.data;
 };
 const deviceId=randomUUID(),protocolVersion='1.0.0-draft.3';
 const identity=await sync('identity',{protocolVersion,deviceId});
 const binding={libraryId:identity.libraryId,epoch:identity.epoch,deviceId};
 const recordId=randomUUID(),at='2024-03-01T12:00:00.000Z',markdown='# 历史素材\n\n手机应收到完整原文和来源。';
 const sources=[{text:markdown,origin:'personal',sourceRef:'original:fixture-voice'}];
 const record={id:recordId,kind:'journal',title:'Historical fixture',markdown,origin:'personal',processing:'formatting',contentDay:'2024-03-01',dateBasis:'用户确认',url:'',annotation:'Synthetic',stage:'draft',sourceIds:[],sources,attachmentDescriptors:[],createdAt:at,updatedAt:at,deleted:false,createdByDevice:deviceId};
 const operation={operationId:randomUUID(),recordId,changeId:randomUUID(),versionId:randomUUID(),baseVersionId:null,parentVersionIds:[],originDeviceId:deviceId,action:'create',baseRevision:null,localGeneration:1,occurredAt:at,timeZone:'Asia/Shanghai',payload:record,
  activities:[{activityId:randomUUID(),originDeviceId:deviceId,occurredAt:at,timeZone:'Asia/Shanghai',beforeHash:contentHash('',[]),afterHash:contentHash(markdown,sources),afterSegments:sources,action:'write',authorship:'personal'}]};
 assert.equal((await sync('push',{...binding,operations:[{inlineBody:operation}]})).receipts[0].status,'applied');
 run(adbArgs(['reverse',`tcp:${hostPort}`,`tcp:${hostPort}`]));reverseInstalled=true;
 const host='http://127.0.0.1:'+hostPort;
 const appId='io.github.wyf929597870.shiwen.probe.test';
 const instrumentation=run(adbArgs(['shell','am','instrument','--user',user,'-w',
  '-e','class','io.github.wyf929597870.shiwen.library.LibrarySyncHostTest',
  '-e','syntheticHost',host,'-e','syntheticPassword',password,'-e','syntheticRecordId',recordId,
  `${appId}/androidx.test.runner.AndroidJUnitRunner`]),{allowFailure:true});
 const output=redact((instrumentation.stdout||'')+'\n'+(instrumentation.stderr||''));
 if(instrumentation.status!==0||!/OK \(1 test\)/.test(output)||/FAILURES!!!|INSTRUMENTATION_FAILED/.test(output)){
  const tail=output.trim().split(/\r?\n/).slice(-16).join('\n').slice(-8_000);
  throw Error(`Android real Host instrumentation failed (${instrumentation.status??'signal'}).\n${tail}`);
 }
 const snapshot=await sync('bootstrapBegin',binding);
 const resolvePayload=async item=>{
  if(!item.payloadRef)return item;
  const chunks=[];let offset=0;
  while(offset<item.byteLength){
   const part=await sync('payloadDownload',{...binding,payloadRef:item.payloadRef,offset,byteLength:1024*1024});
   assert.equal(part.offset,offset);assert.equal(part.digest,item.digest);
   const bytes=Buffer.from(part.dataBase64,'base64');assert.ok(bytes.length>0);chunks.push(bytes);offset+=bytes.length;
  }
  const bytes=Buffer.concat(chunks);assert.equal(bytes.length,item.byteLength);
  assert.equal(createHash('sha256').update(bytes).digest('hex'),item.digest);return JSON.parse(bytes);
 };
 const readEntity=async entityType=>{
  const items=[];let pageToken=null;
  do{const page=await sync('bootstrapPage',{...binding,snapshotId:snapshot.snapshotId,entityType,limit:100,pageToken});
   for(const item of page.items)items.push(await resolvePayload(item));pageToken=page.nextPageToken;
  }while(pageToken!==null);return items;
 };
 const records=await readEntity('records');
 const created=records.filter(item=>item.title==='Android sync fixture');
 assert.equal(created.length,1);assert.equal(created[0].markdown,'服务端并发编辑');
 const longRecord=records.find(item=>item.title==='Android long fixture');
 assert.ok(longRecord,`Synthetic snapshot records: ${JSON.stringify(records.map(item=>({title:item.title,keys:Object.keys(item)})))}`);
 assert.equal(longRecord.markdown,'长文资料'.repeat(200_000));assert.equal(longRecord.attachmentDescriptors.length,1);
 const activities=await readEntity('activities');
 assert.equal(activities.filter(item=>item.recordId===created[0].id).length,4);
 console.log('Android real sync passed: full snapshot, historic provenance, consecutive offline edits, repeat-sync deduplication, 800k Chinese text and original attachment upload, concurrent conflict with preserved phone history.');
 console.log('Transport was USB adb reverse to a temporary isolated Host; Wi-Fi/LAN access was not tested.');
 passed=true;
}finally{
 if(reverseInstalled&&port!==undefined){
  try{run(adbArgs(['reverse','--remove',`tcp:${port}`]),{allowFailure:true});}catch{}
 }
 try{if(service)await stopServer(root);}catch{}
 finally{if(!passed&&process.env.SHIWEN_KEEP_TEST_ROOT==='1')console.error('Synthetic test root retained:',root);else await rm(root,{recursive:true,force:true});}
}
