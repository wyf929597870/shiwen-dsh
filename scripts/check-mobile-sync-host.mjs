// Production HTTP sync check against an isolated synthetic DSH library, never the personal service.
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {startServer,stopServer} from './server-control.mjs';
import {fingerprint,contentHash} from '../plugins/library/src/sync/canonical.mjs';
const root=await mkdtemp(join(tmpdir(),'shiwen-sync-host-'));let service;
try{
  service=await startServer({root,host:'127.0.0.1',port:0},{runtime:resolve(import.meta.dirname,'..')});
  const initial=await fetch(service.loginUrl,{redirect:'manual'});assert.equal(initial.status,303);
  const cookie=initial.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');
  const rpc=async(action,request,authenticated=true)=>{
    const response=await fetch(new URL('/api/shiwen',service.url),{method:'POST',headers:{'Content-Type':'application/json',origin:new URL(service.url).origin,...(authenticated?{cookie}:{})},body:JSON.stringify({method:'mobileSync',args:{action,request}})});
    const raw=await response.text();let body;try{body=JSON.parse(raw);}catch{body={error:raw};}
    return {status:response.status,body,data:body.result?.data};
  };
  const call=async(action,request)=>{const result=await rpc(action,request);assert.equal(result.status,200,`${action}: ${JSON.stringify(result.body)}`);return result.data;};
  const deviceId=randomUUID(),protocolVersion='1.0.0-draft.2';
  assert.equal((await rpc('identity',{deviceId,protocolVersion},false)).status,401);
  const identity=await call('identity',{deviceId,protocolVersion});
  const binding={libraryId:identity.libraryId,epoch:identity.epoch,deviceId};
  const recordId=randomUUID(),at='2024-03-01T12:00:00.000Z',markdown='# 以前的日记\n\n由自己口述，后来排版。\n\n- **重要想法**\n- [原始链接](https://example.com/article)';
  const sources=[{text:markdown,origin:'personal',sourceRef:'original:voice-1'}];
  const record={id:recordId,kind:'journal',title:'两年前的日记',markdown,origin:'personal',processing:'formatting',contentDay:'2024-03-01',dateBasis:'用户确认',url:'',annotation:'保留历史日期',stage:'draft',sourceIds:[],sources,attachmentDescriptors:[],createdAt:at,updatedAt:at,deleted:false,createdByDevice:deviceId};
  const operation={operationId:randomUUID(),recordId,changeId:randomUUID(),versionId:randomUUID(),baseVersionId:null,parentVersionIds:[],originDeviceId:deviceId,action:'create',baseRevision:null,localGeneration:1,occurredAt:at,timeZone:'Asia/Shanghai',payload:record,
    activities:[{activityId:randomUUID(),originDeviceId:deviceId,occurredAt:at,timeZone:'Asia/Shanghai',beforeHash:contentHash('',[]),afterHash:contentHash(markdown,sources),afterSegments:sources,action:'write',authorship:'personal'}]};
  const pushed=await call('push',{...binding,operations:[{inlineBody:operation}]});
  assert.equal(pushed.receipts[0].status,'applied',JSON.stringify(pushed));
  const webRead=await fetch(new URL('/api/shiwen',service.url),{method:'POST',headers:{'Content-Type':'application/json',cookie,origin:new URL(service.url).origin},body:JSON.stringify({method:'readMarkdown',args:{id:recordId}})});
  assert.equal((await webRead.json()).result.markdown,markdown,'mobile edits must retain Markdown in the existing web editor');
  const repeated=await call('push',{...binding,operations:[{inlineBody:operation}]});assert.deepEqual(repeated,pushed);
  const receipt=await call('receipts',{...binding,operationIds:[operation.operationId]});assert.deepEqual(receipt,pushed);
  const changed=await rpc('push',{...binding,operations:[{inlineBody:{...operation,localGeneration:2}}]});
  assert.equal(changed.body.code??changed.data?.receipts?.[0]?.code,'OPERATION_REUSED','same operation id must bind the entire immutable request');
  const snapshot=await call('bootstrapBegin',binding);const entities={};
  for(const entityType of snapshot.manifest.entityTypes){let pageToken=null;entities[entityType]=[];
    do{const page=await call('bootstrapPage',{...binding,snapshotId:snapshot.snapshotId,entityType,pageToken,limit:2});
      assert.equal(page.highWatermark,snapshot.highWatermark);entities[entityType].push(...page.items);pageToken=page.nextPageToken;
    }while(pageToken!==null);
    assert.equal(entities[entityType].length,snapshot.manifest.counts[entityType]);
  }
  const replica=entities.records.find(row=>(row.record??row).id===recordId);assert.ok(replica);
  const payload=replica.record??replica;
  for(const key of ['markdown','processing','createdAt','updatedAt','createdByDevice','contentDay','dateBasis','sources'])assert.deepEqual(payload[key],record[key],`snapshot must preserve ${key}`);
  assert.equal(entities.activities.filter(row=>row.activityId===operation.activities[0].activityId).length,1);
  const delta=await call('changes',{...binding,cursor:0,limit:100});
  assert.equal(delta.events.filter(row=>row.changeId===operation.changeId).length,1);
  assert.ok(delta.events.some(row=>row.versionId===operation.versionId));
  const wrong=await rpc('changes',{...binding,epoch:randomUUID(),cursor:0});assert.equal(wrong.body.code,'EPOCH_CHANGED');
  const ack=await call('ack',{...binding,appliedCursor:delta.nextCursor,completeCursor:delta.nextCursor,manifestDigest:snapshot.manifest.manifestDigest});
  assert.equal(ack.completeCursor,delta.nextCursor);
  assert.equal(typeof fingerprint(entities),'string');
  console.log('Real isolated Host sync passed: owner authentication, immutable receipts, stable identities, full snapshot pages, historic dates/provenance, activity deduplication, incremental cursor and epoch fence.');
}finally{try{if(service)await stopServer(root);}finally{await rm(root,{recursive:true,force:true});}}
