import {join} from 'node:path';
import {ChunkStore} from '../../library/src/sync/chunks.mjs';
import {canonicalJSON,fingerprint,sha256} from '../../library/src/sync/canonical.mjs';
import {fail,limits} from '../../../contracts/mobile/v1/schema.mjs';

const actions=new Set(['identity','bootstrapBegin','bootstrapPage','changes','push','receipts','ack','progress','recordHead']);
const setupActions=new Set(['setupBegin','setupPage','setupStatus','setupLease','setupCommit','setupAbort','reconcileBegin','reconcilePage','reconcileStatus','reconcileReceipts','reconcileLease','reconcileApply','reconcileComplete','reconcileAbort','reconcileCandidates','reconcileBranchRead','reconcileDecide']);
const uploadActions=new Set(['blobBegin','blobPart','blobStatus','blobCommit','blobDownload','operationPayloadBegin','operationPayloadPart','operationPayloadStatus','operationPayloadCommit','payloadDownload','setupBlobBegin','setupBlobPart','setupBlobStatus','setupBlobCommit','setupPayloadBegin','setupPayloadPart','setupPayloadStatus','setupPayloadCommit','reconcileBlobBegin','reconcileBlobPart','reconcileBlobStatus','reconcileBlobCommit','reconcilePayloadBegin','reconcilePayloadPart','reconcilePayloadStatus','reconcilePayloadCommit']);
const text=(value,name,max=256)=>{if(typeof value!=='string'||!value.trim()||value.length>max)fail('VALIDATION_ERROR',{field:name});return value;};
const int=(value,min=0,max=Number.MAX_SAFE_INTEGER)=>{if(!Number.isSafeInteger(value)||value<min||value>max)fail('VALIDATION_ERROR');return value;};
const decodeBase64=value=>{if(typeof value!=='string'||value.length>Math.ceil(limits.maxPartBytes*4/3)+16)fail('PAYLOAD_TOO_LARGE');const bytes=Buffer.from(value,'base64');if(bytes.toString('base64')!==value)fail('VALIDATION_ERROR',{field:'dataBase64'});return bytes;};

export class MobileSyncAdapter {
  constructor({ctx,library,chunkStore}={}){
    if(!ctx||!library)throw new TypeError('MobileSyncAdapter requires host context and library');
    this.ctx=ctx;this.library=library;this.chunkStore=chunkStore;this.compatibleDevices=new Set();
  }
  ownerId(){return String(this.ctx.connection?.browserPeer?.id??'shiwen-owner');}
  syncStore(){return this.library.mobileSync({ownerId:this.ownerId()});}
  identity(args){const key=`${this.ownerId()}:${args?.deviceId}`;this.compatibleDevices.delete(key);const result=this.syncStore().identity(args);this.compatibleDevices.add(key);return result;}
  chunks(){
    if(this.chunkStore)return this.chunkStore;
    return this.chunkStore=new ChunkStore(join(this.library.paths.library,'mobile-sync-transfers'),{partBytes:limits.maxPartBytes});
  }
  context(request){
    const {libraryId,epoch,deviceId}=request??{};if(!this.compatibleDevices.has(`${this.ownerId()}:${deviceId}`))fail('PROTOCOL_UNSUPPORTED');const identity=this.syncStore().identity({protocolVersion:'1.0.0-draft.3',deviceId});
    if(libraryId!==identity.libraryId)fail('LIBRARY_MISMATCH');if(epoch!==identity.epoch)fail('EPOCH_CHANGED',{epoch:identity.epoch});
    return {authenticated:true,ownerId:String(this.ctx.connection?.browserPeer?.id??'shiwen-owner'),libraryId:identity.libraryId};
  }
  setupContext(request){
    const targetLibraryId=text(request.targetLibraryId??request.expectedLibraryId,'targetLibraryId',100),deviceId=request.deviceId??'00000000-0000-4000-8000-000000000000';
    const identity=this.syncStore().identity({protocolVersion:'1.0.0-draft.3',deviceId});if(identity.libraryId!==targetLibraryId)fail('SETUP_TARGET_CHANGED');
    return {authenticated:true,ownerId:this.ownerId(),libraryId:targetLibraryId};
  }
  beginUpload(kind,request){
    const ctx=this.context(request),byteLength=int(request.byteLength,0,limits.maxCanonicalOperationBytes),digest=text(request.digest,'digest',64);
    let metadata={};
    if(kind==='blob')metadata={recordId:text(request.recordId,'recordId',100),attachmentId:text(request.attachmentId,'attachmentId',100),name:text(request.name,'name',500),...(request.stageOnly===true?{stageOnly:true}:{})};
    const status=this.chunks().begin(ctx,{uploadId:request.uploadId,kind,byteLength,digest,metadata});
    return {uploadId:status.uploadId,partBytes:status.partBytes,byteLength:status.byteLength,digest:status.digest,missingParts:status.missingParts};
  }
  putPart(kind,request){
    const ctx=this.context(request),uploadId=text(request.uploadId,'uploadId'),part=int(request.part),bytes=decodeBase64(request.dataBase64),digest=text(request.partDigest,'partDigest',64);
    const result=this.chunks().putPart(ctx,uploadId,part,bytes,digest);return result;
  }
  transferStatus(kind,request){const status=this.chunks().status(this.context(request),text(request.uploadId,'uploadId'));if(status.kind!==kind)fail('PERMISSION_DENIED');return status;}
  commitOperation(request){
    const ctx=this.context(request),uploadId=text(request.uploadId,'uploadId'),chunk=this.chunks();
    const receipt=chunk.commit(ctx,uploadId),payload=chunk.readBytes(ctx,uploadId,{kind:'operation'});
    let operation;try{operation=JSON.parse(payload.bytes.toString('utf8'));}catch{fail('VALIDATION_ERROR',{field:'operationPayload'});}
    if(canonicalJSON(operation)!==payload.bytes.toString('utf8')||operation.operationId!==request.operationId||fingerprint(operation)!==request.requestFingerprint)fail('MANIFEST_MISMATCH');
    return {...receipt,operationId:operation.operationId,requestFingerprint:request.requestFingerprint};
  }
  publishPayload(ctx,value,metadata){const bytes=Buffer.from(canonicalJSON(value)),published=this.chunks().publish(ctx,{kind:'payload',bytes,digest:sha256(bytes),metadata});return {payloadRef:published.payloadRef,digest:published.digest,byteLength:published.byteLength,encodingVersion:'shiwen-json-v1'};}
  downloadPayload(request){
    const ctx=this.context(request),payloadRef=text(request.payloadRef,'payloadRef'),offset=int(request.offset),byteLength=int(request.byteLength,1,limits.maxPartBytes);
    const state=this.chunks().readBytes(ctx,payloadRef,{kind:'payload'}),end=Math.min(state.bytes.length,offset+byteLength);
    if(offset>state.bytes.length)fail('VALIDATION_ERROR');const data=state.bytes.subarray(offset,end);
    return {payloadRef,digest:state.digest,byteLength:state.bytes.length,offset,nextOffset:end<state.bytes.length?end:null,complete:end===state.bytes.length,dataBase64:data.toString('base64')};
  }
  async execute(action,request={},signal){
    signal?.throwIfAborted?.();
    if(actions.has(action)){
      const sync=this.syncStore();
      if(action!=='identity')this.context(request);
      if(action==='push'||action==='receipts'){
        this.context(request);const operations=[];
        for(const item of request.operations??[]){
          if(item.inlineBody){operations.push(item);continue;}
          const ref=item.payloadReference,ctx=this.context(request),file=this.chunks().readBytes(ctx,ref?.payloadRef,{kind:'operation'});
          if(file.digest!==ref.digest||file.bytes.length!==ref.byteLength||ref.encodingVersion!=='shiwen-json-v1')fail('MANIFEST_MISMATCH');
          let operation;try{operation=JSON.parse(file.bytes.toString('utf8'));}catch{fail('VALIDATION_ERROR',{field:'operationPayload'});}
          if(canonicalJSON(operation)!==file.bytes.toString('utf8')||operation.operationId!==item.operationId||fingerprint(operation)!==item.requestFingerprint)fail('MANIFEST_MISMATCH');
          operations.push({inlineBody:operation});
        }
        const result=action==='push'?sync.push({...request,operations}):sync.receipts(request),ctx=this.context(request);
        for(const receipt of result.receipts??[]){
          if(receipt.currentRecord&&Buffer.byteLength(canonicalJSON(receipt.currentRecord))>limits.maxInlineBytes){receipt.currentRecordRef=this.publishPayload(ctx,receipt.currentRecord,{sourceAction:'pushConflictRecord',operationId:receipt.operationId});receipt.currentRecord=null;}
          if(receipt.currentVersion&&Buffer.byteLength(canonicalJSON(receipt.currentVersion))>limits.maxInlineBytes){receipt.currentVersionRef=this.publishPayload(ctx,receipt.currentVersion,{sourceAction:'pushConflictVersion',operationId:receipt.operationId});receipt.currentVersion=null;}
        }
        return result;
      }
      if(action==='bootstrapPage'){
        const page=sync.bootstrapPage(request),ctx=this.context({libraryId:sync.identity({protocolVersion:'1.0.0-draft.3',deviceId:request.deviceId}).libraryId,
          epoch:sync.identity({protocolVersion:'1.0.0-draft.3',deviceId:request.deviceId}).epoch,deviceId:request.deviceId});
        page.items=page.items.map(item=>{
          const bytes=Buffer.from(canonicalJSON(item));if(bytes.length<=limits.maxInlineBytes)return item;
          const published=this.chunks().publish(ctx,{kind:'payload',bytes,digest:sha256(bytes),metadata:{snapshotId:page.snapshotId,entityType:page.entityType,manifestDigest:page.manifestDigest}});
          return {payloadRef:published.payloadRef,digest:published.digest,byteLength:published.byteLength,encodingVersion:'shiwen-json-v1'};
        });return page;
      }
      if(action==='changes'){
        const page=sync.changes(request),ctx=this.context(request);
        for(const event of page.events){if(event.record&&Buffer.byteLength(canonicalJSON(event.record))>limits.maxInlineBytes){event.recordRef=this.publishPayload(ctx,event.record,{sourceAction:'changesRecord',seq:event.seq,changeId:event.changeId});event.record=null;}
          if(event.version&&Buffer.byteLength(canonicalJSON(event.version))>limits.maxInlineBytes){event.versionRef=this.publishPayload(ctx,event.version,{sourceAction:'changesVersion',seq:event.seq,changeId:event.changeId});event.version=null;}
          if(event.activities&&Buffer.byteLength(canonicalJSON(event.activities))>limits.maxInlineBytes){event.activitiesRef=this.publishPayload(ctx,event.activities,{sourceAction:'changesActivities',seq:event.seq,changeId:event.changeId});event.activities=null;}
          if(event.provenance&&Buffer.byteLength(canonicalJSON(event.provenance))>limits.maxInlineBytes){event.provenanceRef=this.publishPayload(ctx,event.provenance,{sourceAction:'changesProvenance',seq:event.seq,changeId:event.changeId});event.provenance=null;}
        }
        return page;
      }
      if(action==='recordHead'){
        const head=sync.recordHead(request),ctx=this.context(request);
        for(const key of ['record','version'])if(Buffer.byteLength(canonicalJSON(head[key]))>limits.maxInlineBytes){head[`${key}Ref`]=this.publishPayload(ctx,head[key],{sourceAction:`recordHead:${key}`,recordId:request.recordId});head[key]=null;}
        return head;
      }
      const result=action==='identity'?this.identity(request):sync[action](request);
      if(action==='identity')result.capabilities={...result.capabilities,stagedRecordAttachments:true};
      return result;
    }
    if(setupActions.has(action)){
      const sync=this.syncStore();if(typeof sync[action]!=='function')fail('VALIDATION_ERROR',{field:'action'});
      if(action==='reconcileBranchRead'){
        const branch=sync.reconcileBranchRead(request),bytes=Buffer.from(canonicalJSON(branch));
        if(bytes.length<=limits.maxInlineBytes)return branch;
        const ctx=this.context(request);
        return {branchRef:this.publishPayload(ctx,branch,{sourceAction:'reconcileBranchRead',taskId:request.taskId,branchId:request.branchId})};
      }
      return sync[action](request);
    }
    if(!uploadActions.has(action))fail('VALIDATION_ERROR',{field:'action'});
    if(action==='blobBegin')return this.beginUpload('blob',request);
    if(action==='blobPart')return this.putPart('blob',request);
    if(action==='blobStatus')return this.transferStatus('blob',request);
    if(action==='blobCommit'){
      const ctx=this.context(request),uploadId=text(request.uploadId,'uploadId'),chunk=this.chunks(),transfer=chunk.commit(ctx,uploadId),data=chunk.readBytes(ctx,uploadId,{kind:'blob'}),metadata=data.metadata;
      if(metadata.recordId!==request.recordId||metadata.attachmentId!==request.attachmentId||metadata.name!==request.name)fail('OPERATION_REUSED');
      const result=this.syncStore().putAttachment({...request,attachmentId:metadata.attachmentId,recordId:metadata.recordId,name:metadata.name,stageOnly:metadata.stageOnly===true,bytes:data.bytes,digest:transfer.digest});
      return {...transfer,...result};
    }
    if(action==='blobDownload')return this.syncStore().attachmentChunk(request);
    if(action==='setupBlobBegin'){
      const sync=this.syncStore();sync.setupBlobCheck(request);const ctx=this.setupContext(request),metadata={setupId:text(request.setupId,'setupId'),fencingToken:int(request.fencingToken),recordId:text(request.recordId,'recordId',100),attachmentId:text(request.attachmentId,'attachmentId',100),name:text(request.name,'name',500),...(request.branchId?{branchId:text(request.branchId,'branchId',100)}:{})};
      const transfer=this.chunks().begin(ctx,{uploadId:request.uploadId,kind:'blob',byteLength:int(request.byteLength,0,limits.maxCanonicalOperationBytes),digest:text(request.digest,'digest',64),metadata});return {uploadId:transfer.uploadId,partBytes:transfer.partBytes,byteLength:transfer.byteLength,digest:transfer.digest,missingParts:transfer.missingParts};
    }
    if(action==='setupBlobPart'){
      const bytes=decodeBase64(request.dataBase64);return this.chunks().putPart(this.setupContext(request),text(request.uploadId,'uploadId'),int(request.part),bytes,text(request.partDigest,'partDigest',64));
    }
    if(action==='setupBlobStatus'){
      const state=this.chunks().status(this.setupContext(request),text(request.uploadId,'uploadId'));if(state.kind!=='blob'||state.metadata.setupId!==request.setupId||state.metadata.fencingToken!==request.fencingToken)fail('PERMISSION_DENIED');return state;
    }
    if(action==='setupBlobCommit'){
      const ctx=this.setupContext(request),chunk=this.chunks(),uploadId=text(request.uploadId,'uploadId'),transfer=chunk.commit(ctx,uploadId),data=chunk.readBytes(ctx,uploadId,{kind:'blob'}),metadata=data.metadata;
      if(metadata.setupId!==request.setupId||metadata.fencingToken!==request.fencingToken)fail('SETUP_LEASE_EXPIRED');
      return {...transfer,...this.syncStore().setupBlobStore({...request,recordId:metadata.recordId,attachmentId:metadata.attachmentId,name:metadata.name,branchId:metadata.branchId??null,bytes:data.bytes,digest:transfer.digest})};
    }
    if(action==='setupPayloadBegin'){
      const sync=this.syncStore();sync.setupPayloadCheck(request);const ctx=this.setupContext(request),metadata={setupId:text(request.setupId,'setupId'),fencingToken:int(request.fencingToken),entityType:text(request.entityType,'entityType',32),ordinal:int(request.ordinal)};
      const transfer=this.chunks().begin(ctx,{uploadId:request.uploadId,kind:'payload',byteLength:int(request.byteLength,0,limits.maxCanonicalOperationBytes),digest:text(request.digest,'digest',64),metadata});return {uploadId:transfer.uploadId,partBytes:transfer.partBytes,byteLength:transfer.byteLength,digest:transfer.digest,missingParts:transfer.missingParts};
    }
    if(action==='setupPayloadPart'){
      const bytes=decodeBase64(request.dataBase64);return this.chunks().putPart(this.setupContext(request),text(request.uploadId,'uploadId'),int(request.part),bytes,text(request.partDigest,'partDigest',64));
    }
    if(action==='setupPayloadStatus'){
      const state=this.chunks().status(this.setupContext(request),text(request.uploadId,'uploadId'));if(state.kind!=='payload'||state.metadata.setupId!==request.setupId||state.metadata.fencingToken!==request.fencingToken||state.metadata.entityType!==request.entityType||state.metadata.ordinal!==request.ordinal)fail('PERMISSION_DENIED');return state;
    }
    if(action==='setupPayloadCommit'){
      const ctx=this.setupContext(request),chunk=this.chunks(),uploadId=text(request.uploadId,'uploadId'),transfer=chunk.commit(ctx,uploadId),data=chunk.readBytes(ctx,uploadId,{kind:'payload'}),metadata=data.metadata;
      if(metadata.setupId!==request.setupId||metadata.fencingToken!==request.fencingToken||metadata.entityType!==request.entityType||metadata.ordinal!==request.ordinal)fail('SETUP_LEASE_EXPIRED');
      let item;try{item=JSON.parse(data.bytes.toString('utf8'));}catch{fail('VALIDATION_ERROR',{field:'setupPayload'});}
      if(canonicalJSON(item)!==data.bytes.toString('utf8'))fail('MANIFEST_MISMATCH');
      return {...transfer,...this.syncStore().setupPayloadStore({...request,entityType:metadata.entityType,ordinal:metadata.ordinal,item})};
    }
    if(action==='reconcileBlobBegin'){
      this.syncStore().reconcileBlobCheck(request);const ctx={authenticated:true,ownerId:this.ownerId(),libraryId:text(request.libraryId,'libraryId')},metadata={taskId:text(request.taskId,'taskId'),fencingToken:int(request.fencingToken),attachmentId:text(request.attachmentId,'attachmentId'),recordId:text(request.recordId,'recordId',100),name:text(request.name,'name',500),branchId:request.branchId?text(request.branchId,'branchId',100):null};
      const transfer=this.chunks().begin(ctx,{uploadId:request.uploadId,kind:'blob',byteLength:int(request.byteLength,0,limits.maxCanonicalOperationBytes),digest:text(request.digest,'digest',64),metadata});return {uploadId:transfer.uploadId,partBytes:transfer.partBytes,byteLength:transfer.byteLength,digest:transfer.digest,missingParts:transfer.missingParts};
    }
    if(action==='reconcileBlobPart'){
      const bytes=decodeBase64(request.dataBase64),ctx={authenticated:true,ownerId:this.ownerId(),libraryId:text(request.libraryId,'libraryId')};return this.chunks().putPart(ctx,text(request.uploadId,'uploadId'),int(request.part),bytes,text(request.partDigest,'partDigest',64));
    }
    if(action==='reconcileBlobStatus'){
      const ctx={authenticated:true,ownerId:this.ownerId(),libraryId:text(request.libraryId,'libraryId')},state=this.chunks().status(ctx,text(request.uploadId,'uploadId'));if(state.kind!=='blob'||state.metadata.taskId!==request.taskId||state.metadata.fencingToken!==request.fencingToken)fail('PERMISSION_DENIED');return state;
    }
    if(action==='reconcileBlobCommit'){
      const ctx={authenticated:true,ownerId:this.ownerId(),libraryId:text(request.libraryId,'libraryId')},chunk=this.chunks(),uploadId=text(request.uploadId,'uploadId'),transfer=chunk.commit(ctx,uploadId),data=chunk.readBytes(ctx,uploadId,{kind:'blob'}),metadata=data.metadata;if(metadata.taskId!==request.taskId||metadata.fencingToken!==request.fencingToken)fail('SETUP_LEASE_EXPIRED');return {...transfer,...this.syncStore().reconcileBlobStore({...request,...metadata,bytes:data.bytes,digest:transfer.digest})};
    }
    if(action==='reconcilePayloadBegin'){
      this.syncStore().reconcileItemCheck(request);const ctx={authenticated:true,ownerId:this.ownerId(),libraryId:text(request.libraryId,'libraryId')},metadata={taskId:text(request.taskId,'taskId'),fencingToken:int(request.fencingToken),entityType:text(request.entityType,'entityType',32),ordinal:int(request.ordinal)};
      const transfer=this.chunks().begin(ctx,{uploadId:request.uploadId,kind:'payload',byteLength:int(request.byteLength,0,limits.maxCanonicalOperationBytes),digest:text(request.digest,'digest',64),metadata});return {uploadId:transfer.uploadId,partBytes:transfer.partBytes,byteLength:transfer.byteLength,digest:transfer.digest,missingParts:transfer.missingParts};
    }
    if(action==='reconcilePayloadPart'){
      const bytes=decodeBase64(request.dataBase64),ctx={authenticated:true,ownerId:this.ownerId(),libraryId:text(request.libraryId,'libraryId')};return this.chunks().putPart(ctx,text(request.uploadId,'uploadId'),int(request.part),bytes,text(request.partDigest,'partDigest',64));
    }
    if(action==='reconcilePayloadStatus'){
      const ctx={authenticated:true,ownerId:this.ownerId(),libraryId:text(request.libraryId,'libraryId')},state=this.chunks().status(ctx,text(request.uploadId,'uploadId'));if(state.kind!=='payload'||state.metadata.taskId!==request.taskId||state.metadata.fencingToken!==request.fencingToken||state.metadata.entityType!==request.entityType||state.metadata.ordinal!==request.ordinal)fail('PERMISSION_DENIED');return state;
    }
    if(action==='reconcilePayloadCommit'){
      const ctx={authenticated:true,ownerId:this.ownerId(),libraryId:text(request.libraryId,'libraryId')},chunk=this.chunks(),uploadId=text(request.uploadId,'uploadId'),transfer=chunk.commit(ctx,uploadId),data=chunk.readBytes(ctx,uploadId,{kind:'payload'}),metadata=data.metadata;if(metadata.taskId!==request.taskId||metadata.fencingToken!==request.fencingToken||metadata.entityType!==request.entityType||metadata.ordinal!==request.ordinal)fail('SETUP_LEASE_EXPIRED');let item;try{item=JSON.parse(data.bytes.toString('utf8'));}catch{fail('VALIDATION_ERROR',{field:'reconcilePayload'});}if(canonicalJSON(item)!==data.bytes.toString('utf8'))fail('MANIFEST_MISMATCH');return {...transfer,...this.syncStore().reconcilePage({taskId:metadata.taskId,fencingToken:metadata.fencingToken,entityType:metadata.entityType,startOrdinal:metadata.ordinal,items:[item]})};
    }
    if(action==='operationPayloadBegin')return this.beginUpload('operation',request);
    if(action==='operationPayloadPart')return this.putPart('operation',request);
    if(action==='operationPayloadStatus')return this.transferStatus('operation',request);
    if(action==='operationPayloadCommit')return this.commitOperation(request);
    return this.downloadPayload(request);
  }
  close(){this.chunkStore?.close();this.chunkStore=undefined;}
}

export const createMobileSyncAdapter=options=>new MobileSyncAdapter(options);
