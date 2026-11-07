import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {createStore} from '../plugins/library/legacy/store.mjs';
import {createMobileSyncAdapter} from '../plugins/mobile/src/sync-adapter.mjs';
import {canonicalJSON,sha256} from '../plugins/library/src/sync/canonical.mjs';

test('near-limit Unicode bootstrap record is referenced and range-download verifies canonical JSON',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'shiwen-sync-adapter-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const library=createStore(join(dir,'library.sqlite'));library.paths={library:dir};t.after(()=>library.close());
  const adapter=createMobileSyncAdapter({ctx:{connection:{browserPeer:{id:'owner'}}},library});t.after(()=>adapter.close());
  const saved=library.save({kind:'journal',title:'大正文',body:'中'.repeat(800_000)}),deviceId=randomUUID();
  const identity=adapter.identity({protocolVersion:'1.0.0-draft.2',deviceId});
  const begun=await adapter.execute('bootstrapBegin',{libraryId:identity.libraryId,epoch:identity.epoch,deviceId});
  const page=await adapter.execute('bootstrapPage',{libraryId:identity.libraryId,epoch:identity.epoch,deviceId,snapshotId:begun.snapshotId,entityType:'records',limit:1});
  assert.ok(page.items[0].payloadRef);assert.ok(page.items[0].byteLength>512*1024);
  const chunks=[];let offset=0;
  while(true){const part=await adapter.execute('payloadDownload',{libraryId:identity.libraryId,epoch:identity.epoch,deviceId,payloadRef:page.items[0].payloadRef,offset,byteLength:1024*1024});chunks.push(Buffer.from(part.dataBase64,'base64'));if(part.complete)break;offset=part.nextOffset;}
  const bytes=Buffer.concat(chunks);assert.equal(sha256(bytes),page.items[0].digest);
  const entity=JSON.parse(bytes.toString('utf8'));assert.equal(entity.id,saved.id);assert.equal(entity.markdown.length,800_000);
  assert.equal(createHash('sha256').update(canonicalJSON(entity)).digest('hex'),page.items[0].digest);
  const changes=await adapter.execute('changes',{libraryId:identity.libraryId,epoch:identity.epoch,deviceId,cursor:0});
  const event=changes.events.find(item=>item.recordId===saved.id);assert.ok(event.versionRef);assert.equal(event.version,null);
  const versionChunks=[];let versionOffset=0;
  while(true){const part=await adapter.execute('payloadDownload',{libraryId:identity.libraryId,epoch:identity.epoch,deviceId,
    payloadRef:event.versionRef.payloadRef,offset:versionOffset,byteLength:1024*1024});versionChunks.push(Buffer.from(part.dataBase64,'base64'));
    if(part.complete)break;versionOffset=part.nextOffset;}
  const versionBytes=Buffer.concat(versionChunks);assert.equal(sha256(versionBytes),event.versionRef.digest);
  const version=JSON.parse(versionBytes.toString('utf8'));assert.equal(version.id,event.versionId);assert.equal(version.recordId,saved.id);
  assert.equal(version.markdown.length,800_000);assert.equal(version.revision,event.revision);
});

test('attachment upload is chunked, idempotent and downloadable with a verified whole-object digest',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'shiwen-sync-blob-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const library=createStore(join(dir,'library.sqlite'));library.paths={library:dir};t.after(()=>library.close());
  const adapter=createMobileSyncAdapter({ctx:{connection:{browserPeer:{id:'owner'}}},library});t.after(()=>adapter.close());
  const record=library.save({kind:'reference',body:'资料'}),deviceId=randomUUID(),identity=adapter.identity({protocolVersion:'1.0.0-draft.2',deviceId});
  const bytes=Buffer.from('原始文件内容🌿'),attachmentId=randomUUID(),digest=sha256(bytes);
  const base={libraryId:identity.libraryId,epoch:identity.epoch,deviceId};
  const begin=await adapter.execute('blobBegin',{...base,recordId:record.id,attachmentId,name:'原件.md',byteLength:bytes.length,digest});
  const part=bytes.subarray(0,begin.partBytes);await adapter.execute('blobPart',{...base,uploadId:begin.uploadId,part:0,dataBase64:part.toString('base64'),partDigest:sha256(part)});
  const committed=await adapter.execute('blobCommit',{...base,uploadId:begin.uploadId,recordId:record.id,attachmentId,name:'原件.md'});
  assert.equal(committed.digest,digest);assert.equal(committed.attachmentId,attachmentId);
  const downloaded=await adapter.execute('blobDownload',{...base,attachmentId,offset:0,byteLength:1024});
  const restored=Buffer.from(downloaded.dataBase64,'base64');assert.equal(sha256(restored),digest);assert.deepEqual(restored,bytes);
});

test('setup can stage a large entity through authenticated payload chunks',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'shiwen-sync-setup-payload-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const source=createStore(join(dir,'source.sqlite')),target=createStore(join(dir,'target.sqlite'));source.paths={library:join(dir,'source')};target.paths={library:join(dir,'target')};t.after(()=>{source.close();target.close();});
  const sourceAdapter=createMobileSyncAdapter({ctx:{connection:{browserPeer:{id:'owner'}}},library:source}),targetAdapter=createMobileSyncAdapter({ctx:{connection:{browserPeer:{id:'owner'}}},library:target});t.after(()=>{sourceAdapter.close();targetAdapter.close();});
  source.save({kind:'journal',title:'large',body:'中'.repeat(800_000)});const deviceId=randomUUID(),sourceIdentity=sourceAdapter.identity({protocolVersion:'1.0.0-draft.2',deviceId}),targetIdentity=targetAdapter.identity({protocolVersion:'1.0.0-draft.2',deviceId});
  const snapshot=source.mobileSync().bootstrapBegin({libraryId:sourceIdentity.libraryId,epoch:sourceIdentity.epoch,deviceId}),page=source.mobileSync().bootstrapPage({snapshotId:snapshot.snapshotId,entityType:'records',limit:1}),item=page.items[0],bytes=Buffer.from(canonicalJSON(item));
  assert.ok(bytes.length>512*1024);const setupId=randomUUID(),base={setupId,targetLibraryId:targetIdentity.libraryId,fencingToken:1};
  const setup=await targetAdapter.execute('setupBegin',{setupId,mode:'initialize',libraryId:sourceIdentity.libraryId,sourceEpoch:sourceIdentity.epoch,manifestDigest:snapshot.manifest.manifestDigest,manifest:snapshot.manifest,expectedLibraryId:targetIdentity.libraryId,expectedEpoch:targetIdentity.epoch,targetGeneration:targetIdentity.targetGeneration});
  const upload=await targetAdapter.execute('setupPayloadBegin',{...base,fencingToken:setup.fencingToken,entityType:'records',ordinal:0,byteLength:bytes.length,digest:sha256(bytes)});
  for(let part=0;part*upload.partBytes<bytes.length;part++){const chunk=bytes.subarray(part*upload.partBytes,Math.min(bytes.length,(part+1)*upload.partBytes));await targetAdapter.execute('setupPayloadPart',{...base,fencingToken:setup.fencingToken,uploadId:upload.uploadId,part,dataBase64:chunk.toString('base64'),partDigest:sha256(chunk)});}
  const stored=await targetAdapter.execute('setupPayloadCommit',{...base,fencingToken:setup.fencingToken,uploadId:upload.uploadId,entityType:'records',ordinal:0});
  assert.equal(stored.receivedCounts.records,1);assert.equal(stored.receivedDigests.records,snapshot.manifest.entityDigests.records);
});
