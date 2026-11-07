import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {createStore} from '../plugins/library/legacy/store.mjs';
import {fingerprint} from '../plugins/library/src/sync/canonical.mjs';

function isolated(t){const directory=mkdtempSync(join(tmpdir(),'shiwen-attachment-range-'));const store=createStore(join(directory,'library.sqlite'));t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});return store;}
function attachment(store,bytes){
  const record=store.save({kind:'reference',title:'synthetic attachment owner',body:'synthetic body'});
  const id=store.attachmentAdd({record:record.id,name:'synthetic.bin',data:bytes.toString('base64')});
  const identity=store.mobileSync().identity({protocolVersion:'1.0.0-draft.2',deviceId:randomUUID()});
  return {record,id,identity,deviceId:randomUUID()};
}

test('attachment range returns null nextOffset only for complete final chunks',t=>{
  const store=isolated(t),sync=store.mobileSync(),bytes=Buffer.from('synthetic payload'),{record,id,identity,deviceId}=attachment(store,bytes);
  const first=sync.attachmentChunk({libraryId:identity.libraryId,epoch:identity.epoch,deviceId,attachmentId:id,offset:0,byteLength:4});
  assert.equal(first.nextOffset,4);assert.equal(first.complete,false);assert.equal(first.totalBytes,bytes.length);
  const last=sync.attachmentChunk({libraryId:identity.libraryId,epoch:identity.epoch,deviceId,attachmentId:id,offset:4,byteLength:1024});
  assert.equal(last.nextOffset,null);assert.equal(last.complete,true);assert.equal(last.offset,4);
  assert.equal(last.recordId,record.id);assert.equal(last.attachmentId,id);
});

test('zero byte attachment is a complete empty range with the empty-file digest',t=>{
  const store=isolated(t),sync=store.mobileSync(),{id,identity,deviceId}=attachment(store,Buffer.alloc(0));
  const response=sync.attachmentChunk({libraryId:identity.libraryId,epoch:identity.epoch,deviceId,attachmentId:id,offset:0,byteLength:1024});
  assert.equal(response.totalBytes,0);assert.equal(response.offset,0);assert.equal(response.nextOffset,null);assert.equal(response.complete,true);
  assert.equal(response.dataBase64,'');assert.equal(response.digest,createHash('sha256').update(Buffer.alloc(0)).digest('hex'));
});

test('branch range download is scoped to the branch and returns explicit branch identity',t=>{
  const source=isolated(t),sourceSync=source.mobileSync(),sourceDevice=randomUUID();
  const sourceIdentity=sourceSync.identity({protocolVersion:'1.0.0-draft.2',deviceId:sourceDevice});
  const saved=source.save({kind:'reference',title:'synthetic branch owner',body:'synthetic body'});
  const attachmentId=source.attachmentAdd({record:saved.id,name:'synthetic.bin',data:Buffer.from('branch bytes').toString('base64')});
  const rawAttachment=JSON.parse(source.exportBackup()).payload.tables.attachments.find(item=>item.id===attachmentId);
  const snapshot=sourceSync.bootstrapBegin({libraryId:sourceIdentity.libraryId,epoch:sourceIdentity.epoch,deviceId:sourceDevice}),entities={};
  for(const type of snapshot.manifest.entityTypes)entities[type]=sourceSync.bootstrapPage({snapshotId:snapshot.snapshotId,entityType:type}).items;
  const record=entities.records[0],branchId=randomUUID(),branch={branchId,recordId:record.id,state:'retained',sourceServerId:sourceIdentity.serverId,
    sourceEpoch:sourceIdentity.epoch,sourceDeviceId:sourceDevice,manifestDigest:'a'.repeat(64),head:entities.heads[0],record,
    versions:entities.versions.filter(item=>item.recordId===record.id),activities:entities.activities.filter(item=>item.recordId===record.id),
    links:[],provenance:null,attachments:[{...entities.attachments[0],branchId}],createdAt:'2026-11-07T00:00:00.000Z'};
  entities.branches=[branch];entities.attachments.push({...entities.attachments[0],branchId});
  const types=snapshot.manifest.entityTypes,counts=Object.fromEntries(types.map(type=>[type,entities[type].length]));
  const entityDigests=Object.fromEntries(types.map(type=>[type,fingerprint(entities[type])])),manifest={protocolVersion:'1.0.0-draft.2',libraryId:sourceIdentity.libraryId,
    epoch:sourceIdentity.epoch,snapshotId:randomUUID(),highWatermark:snapshot.highWatermark,counts,entityDigests,entityTypes:types};manifest.manifestDigest=fingerprint(manifest);
  const target=isolated(t),targetSync=target.mobileSync(),targetDevice=randomUUID(),targetIdentity=targetSync.identity({protocolVersion:'1.0.0-draft.2',deviceId:targetDevice}),setupId=randomUUID();
  const begun=targetSync.setupBegin({setupId,mode:'initialize',libraryId:sourceIdentity.libraryId,sourceEpoch:sourceIdentity.epoch,
    manifestDigest:manifest.manifestDigest,manifest,expectedLibraryId:targetIdentity.libraryId,expectedEpoch:targetIdentity.epoch,targetGeneration:targetIdentity.targetGeneration});
  for(const type of types)if(entities[type].length)targetSync.setupPage({setupId,fencingToken:begun.fencingToken,entityType:type,startOrdinal:0,items:entities[type]});
  const bytes=Buffer.from(rawAttachment.data,'base64'),digest=createHash('sha256').update(bytes).digest('hex');
  targetSync.setupBlobStore({setupId,fencingToken:begun.fencingToken,attachmentId,recordId:record.id,name:'synthetic.bin',bytes,digest,branchId:null});
  targetSync.setupBlobStore({setupId,fencingToken:begun.fencingToken,attachmentId,recordId:record.id,name:'synthetic.bin',bytes,digest,branchId});
  assert.equal(targetSync.setupStatus({setupId,fencingToken:begun.fencingToken}).state,'ready');targetSync.setupCommit({setupId,fencingToken:begun.fencingToken});
  const identity=targetSync.identity({protocolVersion:'1.0.0-draft.2',deviceId:targetDevice});
  const response=targetSync.attachmentChunk({libraryId:identity.libraryId,epoch:identity.epoch,deviceId:targetDevice,attachmentId,branchId,offset:0,byteLength:1024});
  assert.equal(response.branchId,branchId);assert.equal(response.recordId,record.id);assert.equal(response.digest,digest);
  assert.equal(response.nextOffset,null);assert.equal(response.complete,true);assert.equal(Buffer.from(response.dataBase64,'base64').toString(),'branch bytes');
});
