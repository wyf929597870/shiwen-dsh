import {randomUUID} from 'node:crypto';
import {fail,limits,protocolVersion,parseOperation,record as recordSchema,version as versionSchema,head as headSchema,attachment as attachmentSchema,branch as branchSchema,activity as activitySchema} from '../../../../contracts/mobile/v1/schema.mjs';
import {canonicalJSON,fingerprint,businessFingerprint,contentHash,sha256} from './canonical.mjs';
import {markdownSource,markdownSegments} from '../../legacy/markdown.mjs';
import {readDoc,dateKey} from '../../legacy/content.mjs';
import {changes as textChanges} from '../../legacy/content.mjs';

const PAGE_SIZE=100, SNAPSHOT_TTL_MS=24*60*60*1000;
const entityTypes=['records','heads','versions','activities','links','attachments','provenance','branches'];
const now=()=>new Date().toISOString();
const validUuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const integer=(value,min=0,max=Number.MAX_SAFE_INTEGER)=>Number.isSafeInteger(value)&&value>=min&&value<=max;
const parse=value=>JSON.parse(value);
const deterministicUuid=value=>{const h=sha256(value);return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`;};
const blobKey=(id,branchId)=>`${id}\0${branchId??''}`;

export function createMobileSyncStore({db,get,save,syncMeta,syncRecord,hash,appendSyncChange,bumpSyncRevision,consolidateJournals,journalForDay,ownerId='owner'}) {
  // Keep the sender's accepted text as well as the merged head. A subsequent
  // offline append is a delta against the sender's version, not the merged text.
  const libraryId=()=>syncMeta('sync_library_id'), epoch=()=>syncMeta('sync_epoch');
  const currentCursor=()=>Number(db.prepare('SELECT COALESCE(MAX(seq),0) AS n FROM sync_changes').get().n);
  const assertLibrary=(request)=>{
    const currentLibraryId=libraryId(),currentEpoch=epoch();
    if(request?.libraryId!==currentLibraryId)fail('LIBRARY_MISMATCH');
    if(request?.epoch!==currentEpoch)fail('EPOCH_CHANGED',{epoch:currentEpoch});
    return {libraryId:currentLibraryId,epoch:currentEpoch};
  };
  const validateDevice=deviceId=>{if(!validUuid(deviceId))fail('VALIDATION_ERROR',{field:'deviceId'});return deviceId;};
  const docFromSources=sources=>{
    const paragraphs=[[]];
    for(const segment of sources){
      const pieces=segment.text.split('\n');
      for(const [index,text] of pieces.entries()){
        if(index)paragraphs.push([]);
        if(!text)continue;
        const marks=segment.origin!=='personal'||segment.sourceRef?[{type:'provenance',attrs:{origin:segment.origin,...(segment.sourceRef?{sourceRef:segment.sourceRef}:{})}}]:undefined;
        paragraphs.at(-1).push({type:'text',text,...(marks?{marks}:{})});
      }
    }
    return {type:'doc',content:paragraphs.map(content=>({type:'paragraph',content}))};
  };
  const journalInput=id=>{const row=db.prepare('SELECT payload FROM sync_journal_inputs WHERE version_id=?').get(id);return row?{journalInput:parse(row.payload)}:{};};
  const relation=id=>{const row=db.prepare('SELECT original_id,version_id,content_hash FROM annotation_relations WHERE record_id=?').get(id);return row?{annotationOf:{recordId:row.original_id,versionId:row.version_id,contentHash:row.content_hash}}:{};};
  const recordRows=()=>db.prepare('SELECT id FROM records ORDER BY id').all().map(x=>syncRecord(x.id));
  const recordProvenance=record=>{
      const storedProvenance=db.prepare('SELECT payload FROM sync_provenance WHERE record_id=?').get(record.id);
      if(storedProvenance)return parse(storedProvenance.payload);
      const imp=db.prepare('SELECT path,day,date_basis,duplicate_of,metadata,links FROM imports WHERE record=?').get(record.id);
      const sourceRows=db.prepare('SELECT s.source_record,s.source_message,s.source_role,s.source_revision,s.excerpt,m.thread AS source_session FROM record_sources s LEFT JOIN messages m ON m.id=s.source_message WHERE s.record=? ORDER BY s.rowid').all(record.id);
      const dshRows=db.prepare('SELECT session_id,message_id,role,excerpt FROM dsh_record_sources WHERE record=? ORDER BY rowid').all(record.id);
      const externalRows=db.prepare('SELECT client_name,action,session_id,message_id,at FROM external_sources WHERE record=? ORDER BY at,id').all(record.id);
      const importData=imp?parse(imp.metadata):null,importLinks=imp?parse(imp.links):[];
      const safeRelative=value=>typeof value==='string'&&!value.startsWith('/')&&!/^[a-zA-Z]:[\\/]|^[\\/]{2}/.test(value)&&!value.split(/[\\/]/).includes('..')?value:'';
      const payload={recordId:record.id,...(imp?{import:{sourceName:safeRelative(imp.path),contentDay:imp.day,dateBasis:imp.date_basis,duplicateOf:imp.duplicate_of,
        originalAttachmentId:importData?._import?.originalAttachment??null,dateCandidates:importData?._import?.dateCandidates??[],warnings:importData?._import?.warnings??[],
        assetArchive:Boolean(importData?.assetArchive),files:(importData?.files??[]).filter(file=>typeof file.id==='string').map(file=>({attachmentId:file.id,relativePath:safeRelative(file.path),hash:file.sha256??'',byteLength:file.bytes??0})),
        links:importLinks.map(link=>({kind:link.kind??'',label:link.label??'',targetRecordId:link.record??null,targetAttachmentId:link.attachment??null,relativePath:safeRelative(link.path)}))}}:{ }),
        sources:[...sourceRows.map(row=>({kind:'conversation',sourceServerId:syncMeta('sync_server_id'),sessionId:row.source_session??null,messageId:row.source_message??null,sourceRecordId:row.source_record??null,role:row.source_role,revision:row.source_revision??null,excerpt:row.excerpt})),...dshRows.map(row=>({kind:'conversation',sourceServerId:syncMeta('sync_server_id'),sessionId:row.session_id,messageId:row.message_id,role:row.role,excerpt:row.excerpt}))],
        externalSources:externalRows.map(row=>({sourceServerId:syncMeta('sync_server_id'),clientName:row.client_name,action:row.action,sessionId:row.session_id||null,messageId:row.message_id||null,occurredAt:row.at}))};
      return payload.import||payload.sources.length||payload.externalSources.length?payload:null;
  };
  const snapshotEntities=()=>{
    const records=recordRows();
    const heads=db.prepare('SELECT id,revision,deleted FROM records ORDER BY id').all().map(row=>{
      const version=db.prepare('SELECT id FROM versions WHERE record=? ORDER BY revision DESC LIMIT 1').get(row.id);
      const change=db.prepare('SELECT change_id FROM sync_changes WHERE record_id=? ORDER BY seq DESC LIMIT 1').get(row.id);
      return {recordId:row.id,revision:row.revision,versionId:version?.id??null,changeId:change?.change_id??null,deleted:Boolean(row.deleted)};
    });
    const versions=db.prepare('SELECT * FROM versions ORDER BY record,revision,id').all().map(row=>{const doc=parse(row.doc),markdown=markdownSource(doc),stored=db.prepare('SELECT markdown,sources FROM sync_version_sources WHERE version_id=?').get(row.id),parentRow=db.prepare('SELECT parents FROM sync_version_parents WHERE version_id=?').get(row.id);return {id:row.id,recordId:row.record,revision:row.revision,markdown,doc,...relation(row.record),...journalInput(row.id),sources:stored?.markdown===markdown?parse(stored.sources):markdownSegments(doc,records.find(item=>item.id===row.record)?.origin??'unknown'),parentVersionIds:parentRow?parse(parentRow.parents):[],title:row.title,createdAt:row.at,reason:row.reason};});
    const activities=db.prepare('SELECT * FROM sync_activities ORDER BY record_id,occurred_at,activity_id').all().map(row=>({activityId:row.activity_id,recordId:row.record_id,changeId:row.change_id,originDeviceId:row.origin_device_id,occurredAt:row.occurred_at,timeZone:row.time_zone,beforeHash:row.before_hash,afterHash:row.after_hash,afterSegments:parse(row.after_segments),action:row.action,authorship:row.authorship}));
    for(const version of db.prepare('SELECT * FROM versions ORDER BY record,revision,id').all()){
      if(db.prepare('SELECT 1 FROM sync_changes WHERE version_id=?').get(version.id))continue;
      const edits=db.prepare('SELECT origin,at FROM edits WHERE record=? AND at=? ORDER BY origin').all(version.record,version.at);
      if(!edits.length)continue;
      const currentDoc=parse(version.doc),currentMarkdown=markdownSource(currentDoc),record=records.find(item=>item.id===version.record),currentSegments=markdownSegments(currentDoc,record?.origin??'unknown');
      const previous=db.prepare('SELECT doc FROM versions WHERE record=? AND revision<? ORDER BY revision DESC LIMIT 1').get(version.record,version.revision);
      const previousDoc=previous?parse(previous.doc):{type:'doc',content:[]},beforeMarkdown=previous?markdownSource(previousDoc):'',beforeSegments=previous?markdownSegments(previousDoc,record?.origin??'unknown'):[];
      for(const edit of edits){const beforeHash=contentHash(beforeMarkdown,beforeSegments),afterHash=contentHash(currentMarkdown,currentSegments);if(!activities.some(a=>a.recordId===version.record&&a.occurredAt===edit.at&&a.action==='write'&&a.authorship===edit.origin&&a.beforeHash===beforeHash&&a.afterHash===afterHash))activities.push({activityId:deterministicUuid(`${version.record}\0${version.id}\0${edit.origin}`),recordId:version.record,changeId:null,originDeviceId:null,occurredAt:edit.at,timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone,beforeHash,afterHash,afterSegments:currentSegments,action:'write',authorship:edit.origin});}
    }
    activities.sort((a,b)=>a.recordId.localeCompare(b.recordId)||a.occurredAt.localeCompare(b.occurredAt)||a.activityId.localeCompare(b.activityId));
    const links=db.prepare('SELECT article,material FROM links ORDER BY article,material').all().map(row=>({articleId:row.article,materialId:row.material}));
    const attachments=[];
    for(const row of db.prepare('SELECT id,record,name,data,created FROM attachments ORDER BY id').all()){
      const bytes=Buffer.from(row.data,'base64');attachments.push({id:row.id,recordId:row.record,name:row.name,createdAt:row.created,hash:hash(bytes),byteLength:bytes.length});
    }
    const provenance=records.map(recordProvenance).filter(Boolean);
    const branches=db.prepare('SELECT * FROM sync_branches ORDER BY created_at,branch_id').all().map(row=>{const value=parse(row.payload),blobs=db.prepare('SELECT attachment_id,name,digest,byte_length FROM sync_branch_blobs WHERE branch_id=? ORDER BY attachment_id').all(row.branch_id);return {...value,attachments:blobs.map(blob=>({id:blob.attachment_id,recordId:row.record_id,name:blob.name,createdAt:value.createdAt,hash:blob.digest,byteLength:blob.byte_length,branchId:row.branch_id}))};});
    for(const branch of branches)attachments.push(...branch.attachments);
    return {records,heads,versions,activities,links,attachments,provenance,branches};
  };
  const setupTask=(request,{allowExpired=false}={})=>{
    const row=db.prepare('SELECT * FROM sync_setups WHERE id=?').get(request?.setupId);
    if(!row||row.owner_id!==ownerId)fail('PERMISSION_DENIED');
    if(request.fencingToken!==row.fencing_token)fail('SETUP_LEASE_EXPIRED');
    if(row.state==='committed')return row;
    if(row.state==='aborted')fail('SETUP_NOT_READY',{state:row.state});
    if(!allowExpired&&Date.parse(row.lease_expires_at)<=Date.now())fail('SETUP_LEASE_EXPIRED');
    return row;
  };
  const reconcileTask=(request,{allowExpired=false}={})=>{
    const row=db.prepare('SELECT * FROM sync_reconciliations WHERE id=?').get(request?.taskId);
    if(!row||row.owner_id!==ownerId)fail('PERMISSION_DENIED');
    if(request.fencingToken!==row.fencing_token)fail('SETUP_LEASE_EXPIRED');
    if(row.state==='completed')return row;
    if(row.state==='aborted')fail('SETUP_NOT_READY',{state:row.state});
    if(!allowExpired&&Date.parse(row.lease_expires_at)<=Date.now())fail('SETUP_LEASE_EXPIRED');
    if(libraryId()!==row.library_id||epoch()!==row.target_epoch)fail('EPOCH_CHANGED',{epoch:epoch()});
    return row;
  };
  const assertReconcileTarget=task=>{const generation=Number(syncMeta('sync_target_generation')??'0'),cursor=currentCursor();if(generation!==task.target_generation||cursor!==task.target_cursor)fail('SETUP_TARGET_CHANGED',{targetGeneration:generation,cursor,expectedTargetGeneration:task.target_generation,expectedCursor:task.target_cursor});};
  const advanceReconcileTarget=taskId=>db.prepare('UPDATE sync_reconciliations SET target_cursor=?,updated_at=? WHERE id=?').run(currentCursor(),now(),taskId);
  const reconcileItems=(task,type)=>db.prepare('SELECT payload FROM sync_reconciliation_items WHERE task_id=? AND entity_type=? ORDER BY ordinal').all(task.id,type).map(row=>parse(row.payload));
  const reconcileProgress=task=>{
    const metadata=parse(task.metadata),receivedCounts={},receivedDigests={},missingEntities=[];
    for(const type of [...entityTypes,'operations']){const items=reconcileItems(task,type),expected=type==='operations'?task.operation_count:metadata.sourceManifest?.counts?.[type]??0,expectedDigest=type==='operations'?(metadata.operationDigest??task.manifest_digest):metadata.sourceManifest?.entityDigests?.[type];
      receivedCounts[type]=items.length;receivedDigests[type]=fingerprint(items);
      if(items.length!==expected||expectedDigest&&receivedDigests[type]!==expectedDigest)missingEntities.push({entityType:type,received:items.length,expected,digestMatches:receivedDigests[type]===expectedDigest});}
    const resolvedRows=db.prepare("SELECT payload FROM sync_reconciliation_items WHERE task_id=? AND entity_type='resolution' ORDER BY ordinal").all(task.id),resolutions=resolvedRows.map(row=>parse(row.payload)),resolved=resolutions.filter(value=>['applied','discarded','retained','merged'].includes(value.status)).length;
    const resolvedCounts=Object.fromEntries(['retained','merged','discarded','applied'].map(status=>[status,resolutions.filter(value=>value.status===status).length]));
    const entitiesReady=missingEntities.length===0,attachments=reconcileItems(task,'attachments');
    const missingAttachments=attachments.filter(item=>!db.prepare('SELECT 1 FROM sync_reconciliation_blobs WHERE task_id=? AND attachment_id=? AND branch_id=?').get(task.id,item.id,item.branchId??'')).map(item=>item.branchId?`${item.branchId}/${item.id}`:item.id);
    const ready=entitiesReady&&missingAttachments.length===0,candidates=ready?reconcileCandidatesFor(task):[],resolvedBranches=new Set(resolutions.filter(value=>value.branchId&&['retained','merged','discarded'].includes(value.status)).map(value=>value.branchId));
    return {taskId:task.id,state:task.state==='completed'?'completed':ready?'ready':'receiving',manifestDigest:task.manifest_digest,digestMatches:entitiesReady,receivedCounts,receivedDigests,expectedCounts:{...metadata.sourceManifest?.counts,operations:task.operation_count},missingEntities,missingAttachmentIds:missingAttachments,resolvedOperations:resolved,resolvedCounts,candidateCount:candidates.length,resolvedCandidateCount:candidates.filter(item=>resolvedBranches.has(item.branchId)).length,sourceEpoch:task.source_epoch,targetEpoch:task.target_epoch,leaseExpiresAt:task.lease_expires_at,fencingToken:task.fencing_token};
  };
  const reconcileOperation=(task,operationId)=>{
    const row=db.prepare("SELECT payload FROM sync_reconciliation_items WHERE task_id=? AND item_id=? AND entity_type='operations'").get(task.id,operationId);
    if(!row)fail('PERMISSION_DENIED',{operationId});return parse(row.payload);
  };
  const mappedJournalProof=(operation,change)=>{
    if(operation.payload.kind!=='journal'||!change.payload)return {};
    const input=db.prepare('SELECT record_id,payload FROM sync_journal_inputs WHERE version_id=?').get(operation.versionId),source=db.prepare('SELECT record,revision,doc FROM versions WHERE id=?').get(operation.versionId),head=db.prepare('SELECT * FROM versions WHERE id=? AND record=?').get(change.version_id,change.record_id);
    if(!input||!source||!head||input.record_id!==change.record_id||source.record!==change.record_id||canonicalJSON(parse(input.payload))!==canonicalJSON(operation.payload)||markdownSource(parse(source.doc))!==operation.payload.markdown)return {};
    const record=parse(change.payload),doc=parse(head.doc),markdown=markdownSource(doc),stored=db.prepare('SELECT markdown,sources FROM sync_version_sources WHERE version_id=?').get(head.id),sources=stored?.markdown===markdown?parse(stored.sources):markdownSegments(doc,record.origin);if(record.id!==change.record_id||record.markdown!==markdown)return {};
    return {journalMerged:true,inputVersionId:operation.versionId,inputVersionRevision:source.revision,currentRecord:record,currentVersion:{id:head.id,recordId:head.record,revision:head.revision,markdown,doc,...journalInput(head.id),sources,parentVersionIds:parse(db.prepare('SELECT parents FROM sync_version_parents WHERE version_id=?').get(head.id)?.parents??'[]'),title:head.title,createdAt:head.at,reason:head.reason}};
  };
  const reconcileReceiptFor=(task,item)=>{
    const {deviceId,operation}=item,requestHash=fingerprint(operation),receipt=db.prepare('SELECT * FROM sync_receipts WHERE operation_id=?').get(operation.operationId);
    if(receipt&&receipt.device_id===deviceId&&receipt.epoch===task.source_epoch&&receipt.fingerprint===requestHash)return {operationId:operation.operationId,status:JSON.parse(receipt.result).status,result:parse(receipt.result),receiptEpoch:receipt.epoch};
    const change=db.prepare('SELECT seq,record_id,version_id,revision,payload,operation_fingerprint FROM sync_changes WHERE change_id=?').get(operation.changeId),businessHash=businessFingerprint(operation);
    if(change?.operation_fingerprint===businessHash)return {operationId:operation.operationId,status:'applied',result:{operationId:operation.operationId,status:'applied',recordId:change.record_id,changeId:operation.changeId,versionId:change.version_id,revision:change.revision,seq:change.seq,duplicateChange:true,...mappedJournalProof(operation,change)},receiptEpoch:epoch()};
    if(change)return {operationId:operation.operationId,status:'conflict',code:'CHANGE_ID_MISMATCH',changeId:operation.changeId};
    return {operationId:operation.operationId,status:'unknown'};
  };
  const reconcileCandidatesFor=task=>{
    const records=reconcileItems(task,'records'),heads=new Map(reconcileItems(task,'heads').map(head=>[head.recordId,head])),versions=reconcileItems(task,'versions'),activities=reconcileItems(task,'activities'),provenance=reconcileItems(task,'provenance');
    const target=snapshotEntities(),targetVersions=new Map(target.versions.map(value=>[value.id,value])),targetActivities=new Map(target.activities.map(value=>[value.activityId,value])),targetProvenance=new Map(target.provenance.map(value=>[value.recordId,value]));
    const metadata=parse(task.metadata),serverId=metadata.sourceServerId;
    return records.flatMap(record=>{
      const sourceHead=heads.get(record.id);if(!sourceHead)fail('MANIFEST_MISMATCH',{recordId:record.id,entityType:'heads'});
      const current=get(record.id),currentVersion=current&&db.prepare('SELECT id FROM versions WHERE record=? ORDER BY revision DESC LIMIT 1').get(record.id),targetHead=current?{recordId:record.id,revision:current.revision,versionId:currentVersion?.id??null,changeId:db.prepare('SELECT change_id FROM sync_changes WHERE record_id=? ORDER BY seq DESC LIMIT 1').get(record.id)?.change_id??null,deleted:Boolean(current.deleted)}:null;
      const sourceVersions=versions.filter(value=>value.recordId===record.id),sourceActivities=activities.filter(value=>value.recordId===record.id);
      const versionsMatch=sourceVersions.every(value=>{const found=targetVersions.get(value.id);if(!found)return false;const {revision:ignoredSourceRevision,...source}=value,{revision:ignoredTargetRevision,...local}=found;return fingerprint(source)===fingerprint(local);});
      const activitiesMatch=sourceActivities.every(value=>{const found=targetActivities.get(value.activityId);return found&&fingerprint(found)===fingerprint(value);});
      const sourceProvenance=provenance.find(value=>value.recordId===record.id)??null,localProvenance=targetProvenance.get(record.id)??null;
      const provenanceMatch=!sourceProvenance||localProvenance&&fingerprint(sourceProvenance)===fingerprint(localProvenance);
      // A coordinator may reconnect with an old, already acknowledged snapshot
      // after the target epoch has rotated. If the exact source head and its
      // history are already present (either in the canonical version DAG or in a
      // retained recovery branch), this is not a new branch to import again.
      const sourceHeadVersion=targetVersions.get(sourceHead.versionId);
      const sourceHeadPresent=sourceHeadVersion&&sourceHeadVersion.recordId===record.id&&
        versionsMatch&&activitiesMatch&&provenanceMatch;
      if(sourceHeadPresent)return [];
      const priorBranchRows=db.prepare('SELECT source_server_id,source_epoch,source_device_id,payload FROM sync_branches WHERE record_id=?').all(record.id);
      const priorBranch=priorBranchRows.map(row=>({row,value:parse(row.payload)})).find(({row,value})=>
        row.source_server_id===serverId&&row.source_epoch===task.source_epoch&&row.source_device_id===task.source_device_id&&
        value.head?.versionId===sourceHead.versionId);
      if(priorBranch){
        const value=priorBranch.value;
        const sourceLinks=reconcileItems(task,'links').filter(link=>link.articleId===record.id||link.materialId===record.id);
        const sourceAttachments=reconcileItems(task,'attachments').filter(item=>item.recordId===record.id&&!item.branchId);
        const same= fingerprint(value.record)===fingerprint(record)&&fingerprint(value.head)===fingerprint(sourceHead)&&
          fingerprint(value.versions??[])===fingerprint(sourceVersions)&&fingerprint(value.activities??[])===fingerprint(sourceActivities)&&
          fingerprint(value.links??[])===fingerprint(sourceLinks)&&fingerprint(value.attachments??[])===fingerprint(sourceAttachments)&&
          fingerprint(value.provenance??null)===fingerprint(sourceProvenance);
        if(!same)fail('OPERATION_REUSED',{recordId:record.id,versionId:sourceHead.versionId});
        return [];
      }
      const branchId=deterministicUuid(`${task.id}\0${record.id}\0${task.source_epoch}\0${sourceHead.versionId}`);
      return [{branchId,recordId:record.id,classification:!current?'source-only':sourceHead.deleted!==targetHead.deleted?'delete-conflict':'diverged',sourceHead,targetHead,sourceServerId:serverId,sourceEpoch:task.source_epoch}];
    });
  };
  const projectActivitiesToEdits=(recordId,activities,initialSegments=[])=>{
    let before=initialSegments;
    for(const activity of activities){const after=activity.afterSegments??[];
      if(activity.action==='write')for(const authorship of ['personal','external','ai','translation','unknown']){
        const prior=before.filter(segment=>segment.origin===authorship).map(segment=>segment.text).join(''),next=after.filter(segment=>segment.origin===authorship).map(segment=>segment.text).join(''),delta=textChanges(prior,next);
        if(delta.added||delta.removed){const editId=deterministicUuid(`mobile-edit\0${activity.activityId}\0${authorship}`);db.prepare('INSERT OR IGNORE INTO edits VALUES(?,?,?,?,?,?)').run(editId,recordId,activity.occurredAt,authorship,delta.added,delta.removed);}
      }
      before=after;
    }
  };
  const setupProgress=task=>{
    const manifest=parse(task.manifest),missingEntities=[],receivedCounts={},receivedDigests={};
    for(const type of manifest.entityTypes){const rows=db.prepare('SELECT payload FROM sync_setup_items WHERE setup_id=? AND entity_type=? ORDER BY ordinal').all(task.id,type),items=rows.map(row=>parse(row.payload));
      receivedCounts[type]=items.length;receivedDigests[type]=fingerprint(items);
      if(items.length!==manifest.counts[type]||receivedDigests[type]!==manifest.entityDigests[type])missingEntities.push({entityType:type,received:items.length,expected:manifest.counts[type],digestMatches:receivedDigests[type]===manifest.entityDigests[type]});
    }
    const descriptors=db.prepare("SELECT payload FROM sync_setup_items WHERE setup_id=? AND entity_type='attachments' ORDER BY ordinal").all(task.id).map(row=>parse(row.payload));
    const staged=new Set(db.prepare('SELECT attachment_id,branch_id FROM sync_setup_blobs WHERE setup_id=?').all(task.id).map(row=>blobKey(row.attachment_id,row.branch_id)));
    const missingAttachments=descriptors.filter(item=>!staged.has(blobKey(item.id,item.branchId))).map(item=>item.branchId?`${item.branchId}/${item.id}`:item.id);
    const ready=missingEntities.length===0&&missingAttachments.length===0;
    if(ready&&task.state==='receiving')db.prepare("UPDATE sync_setups SET state='ready',updated_at=? WHERE id=?").run(now(),task.id);
    return {setupId:task.id,state:ready?'ready':task.state==='ready'?'receiving':task.state,manifestDigest:task.manifest_digest,missingEntities,missingAttachmentIds:missingAttachments,receivedCounts,receivedDigests,leaseExpiresAt:task.lease_expires_at,fencingToken:task.fencing_token};
  };
  const validateSetupItem=(type,item)=>{
    if(type==='records'){const parsed=recordSchema.safeParse(item);if(!parsed.success||parsed.data.sources.map(s=>s.text).join('')!==parsed.data.markdown)fail('VALIDATION_ERROR',{entityType:type});}
    else if(type==='heads'){if(typeof item.recordId!=='string'||!integer(item.revision,1)||!validUuid(item.versionId)||item.changeId!==null&&!validUuid(item.changeId)||typeof item.deleted!=='boolean')fail('VALIDATION_ERROR',{entityType:type});}
    else if(type==='versions'){const parsed=versionSchema.safeParse(item);if(!parsed.success||item.sources.map(s=>s.text).join('')!==item.markdown||item.parentVersionIds.includes(item.id)||new Set(item.parentVersionIds).size!==item.parentVersionIds.length)fail('VALIDATION_ERROR',{entityType:type});}
    else if(type==='activities'){const parsed=activitySchema.safeParse(item);if(!parsed.success||typeof item.recordId!=='string')fail('VALIDATION_ERROR',{entityType:type});}
    else if(type==='links'){if(typeof item.articleId!=='string'||typeof item.materialId!=='string')fail('VALIDATION_ERROR',{entityType:type});}
    else if(type==='attachments'){const parsed=attachmentSchema.safeParse(item);if(!parsed.success||!validUuid(item.id)||item.branchId!==undefined&&!validUuid(item.branchId))fail('VALIDATION_ERROR',{entityType:type});}
    else if(type==='provenance'){if(typeof item.recordId!=='string'||item.import!==undefined&&(!item.import||typeof item.import!=='object')||!Array.isArray(item.sources)||!Array.isArray(item.externalSources))fail('VALIDATION_ERROR',{entityType:type});}
    else if(type==='branches'){const parsed=branchSchema.safeParse(item);if(!parsed.success||item.record.id!==item.recordId||item.head.recordId!==item.recordId||!item.versions.some(version=>version.id===item.head.versionId)||item.versions.some(version=>version.recordId!==item.recordId)||item.activities.some(activity=>activity.recordId&&activity.recordId!==item.recordId)||item.attachments.some(attachment=>attachment.recordId!==item.recordId||attachment.branchId!==item.branchId))fail('VALIDATION_ERROR',{entityType:type});}
  };
  const stageSetupItem=(task,entityType,ordinal,item)=>{
    if(!entityTypes.includes(entityType)||!integer(ordinal))fail('VALIDATION_ERROR');
    const count=parse(task.manifest).counts[entityType];if(ordinal>=count)fail('MANIFEST_MISMATCH',{entityType,ordinal});
    validateSetupItem(entityType,item);const payload=canonicalJSON(item),digest=fingerprint(item);
    if(Buffer.byteLength(payload)>limits.maxCanonicalOperationBytes)fail('PAYLOAD_TOO_LARGE');
    const old=db.prepare('SELECT digest,payload FROM sync_setup_items WHERE setup_id=? AND entity_type=? AND ordinal=?').get(task.id,entityType,ordinal);
    if(old){if(old.digest!==digest||old.payload!==payload)fail('OPERATION_REUSED',{entityType,ordinal});return {alreadyPresent:true,digest};}
    db.prepare('INSERT INTO sync_setup_items VALUES(?,?,?,?,?)').run(task.id,entityType,ordinal,digest,payload);return {alreadyPresent:false,digest};
  };
  return {
    setupBegin(request={}){
      const {setupId,mode,libraryId:sourceLibraryId,sourceEpoch,manifestDigest,manifest,expectedLibraryId,expectedEpoch,targetGeneration}=request;
      if(!validUuid(setupId)||!['initialize','recover'].includes(mode)||!validUuid(sourceLibraryId)||!validUuid(sourceEpoch)||!validUuid(expectedLibraryId)||!validUuid(expectedEpoch)||!integer(targetGeneration)||!/^([a-f0-9]{64})$/.test(manifestDigest)||!manifest||manifest.protocolVersion!==protocolVersion||manifest.libraryId!==sourceLibraryId||manifest.epoch!==sourceEpoch)fail('VALIDATION_ERROR');
      const manifestCore={...manifest};delete manifestCore.manifestDigest;
      if(fingerprint(manifestCore)!==manifestDigest||!Array.isArray(manifest.entityTypes)||manifest.entityTypes.join(',')!==entityTypes.join(',')||!manifest.counts||!manifest.entityDigests)fail('MANIFEST_MISMATCH');
      for(const type of entityTypes)if(!integer(manifest.counts[type])||!/^([a-f0-9]{64})$/.test(manifest.entityDigests[type]))fail('MANIFEST_MISMATCH',{entityType:type});
      const requestHash=fingerprint({setupId,mode,libraryId:sourceLibraryId,sourceEpoch,manifestDigest,expectedLibraryId,expectedEpoch,targetGeneration});
      return db.transaction(()=>{
        const prior=db.prepare('SELECT * FROM sync_setups WHERE id=?').get(setupId);
        if(prior){if(prior.owner_id!==ownerId||prior.request_fingerprint!==requestHash)fail('OPERATION_REUSED');return prior.result?parse(prior.result):setupProgress(prior);}
        const active=db.prepare("SELECT * FROM sync_setups WHERE state IN ('receiving','ready') ORDER BY created_at LIMIT 1").get();
        if(active&&Date.parse(active.lease_expires_at)>Date.now())fail('SETUP_TARGET_BUSY',{setupId:active.id,leaseExpiresAt:active.lease_expires_at});
        if(active)db.prepare("UPDATE sync_setups SET state='aborted',updated_at=? WHERE id=?").run(now(),active.id);
        const currentGeneration=Number(syncMeta('sync_target_generation')??'0');
        if(currentGeneration!==targetGeneration||libraryId()!==expectedLibraryId||epoch()!==expectedEpoch)fail('SETUP_TARGET_CHANGED',{targetGeneration:currentGeneration,libraryId:libraryId(),epoch:epoch()});
        if(mode==='initialize'&&db.prepare('SELECT 1 FROM records LIMIT 1').get())fail('SETUP_TARGET_NOT_EMPTY');
        if(mode==='recover'&&sourceLibraryId!==expectedLibraryId)fail('LIBRARY_MISMATCH');
        const token=Number(syncMeta('sync_fencing_token')??'0')+1,at=now(),expires=new Date(Date.now()+120_000).toISOString();
        db.prepare("INSERT INTO meta(key,value) VALUES('sync_fencing_token',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(token));
        const targetCursor=currentCursor();
        db.prepare('INSERT INTO sync_setups(id,owner_id,request_fingerprint,mode,library_id,source_epoch,manifest_digest,manifest,expected_library_id,expected_epoch,target_generation,target_cursor,fencing_token,lease_expires_at,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(setupId,ownerId,requestHash,mode,sourceLibraryId,sourceEpoch,manifestDigest,JSON.stringify(manifest),expectedLibraryId,expectedEpoch,targetGeneration,targetCursor,token,expires,'receiving',at,at);
        return {setupId,state:'receiving',fencingToken:token,leaseExpiresAt:expires,manifestDigest};
      })();
    },
    setupPage(request={}){
      const task=setupTask(request),{entityType,startOrdinal,items}=request;if(task.state==='committed')fail('SETUP_ALREADY_COMMITTED');
      if(!entityTypes.includes(entityType)||!integer(startOrdinal)||!Array.isArray(items)||items.length<1||items.length>PAGE_SIZE)fail('VALIDATION_ERROR');
      const manifest=parse(task.manifest),count=manifest.counts[entityType];if(startOrdinal+items.length>count)fail('MANIFEST_MISMATCH',{entityType});
      const bytes=Buffer.byteLength(canonicalJSON(items));if(bytes>limits.maxRequestBytes)fail('PAYLOAD_TOO_LARGE',{byteLength:bytes});
      return db.transaction(()=>{
        for(let index=0;index<items.length;index++){
          stageSetupItem(task,entityType,startOrdinal+index,items[index]);
        }
        const fresh=db.prepare('SELECT * FROM sync_setups WHERE id=?').get(task.id);return {setupId:task.id,entityType,startOrdinal,accepted:items.length,digest:fingerprint(items),...setupProgress(fresh)};
      })();
    },
    setupPayloadCheck(request={}){
      const task=setupTask(request),{entityType,ordinal}=request;if(task.state==='committed')fail('SETUP_ALREADY_COMMITTED');
      if(!entityTypes.includes(entityType)||!integer(ordinal)||ordinal>=parse(task.manifest).counts[entityType])fail('VALIDATION_ERROR');
      return {setupId:task.id,entityType,ordinal,accepted:true};
    },
    setupPayloadStore(request={}){
      const task=setupTask(request),{entityType,ordinal,item}=request;if(task.state==='committed')fail('SETUP_ALREADY_COMMITTED');
      return db.transaction(()=>{const result=stageSetupItem(task,entityType,ordinal,item),fresh=db.prepare('SELECT * FROM sync_setups WHERE id=?').get(task.id);return {setupId:task.id,entityType,ordinal,...result,...setupProgress(fresh)};})();
    },
    setupStatus(request={}){const task=setupTask(request,{allowExpired:true});return {...setupProgress(task),state:task.state==='committed'?'committed':task.state==='aborted'?'aborted':setupProgress(task).state,...(task.result?{result:parse(task.result)}:{})};},
    setupLease(request={}){
      return db.transaction(()=>{
        const task=setupTask(request,{allowExpired:true});if(task.state==='committed')return {setupId:task.id,state:'committed',result:parse(task.result)};
        if(Number(syncMeta('sync_target_generation')??'0')!==task.target_generation||libraryId()!==task.expected_library_id||epoch()!==task.expected_epoch||currentCursor()!==task.target_cursor)fail('SETUP_TARGET_CHANGED',{targetGeneration:Number(syncMeta('sync_target_generation')??'0'),cursor:currentCursor(),expectedCursor:task.target_cursor});
        const expired=Date.parse(task.lease_expires_at)<=Date.now(),token=expired?Number(syncMeta('sync_fencing_token')??'0')+1:task.fencing_token;
        if(expired)db.prepare("INSERT INTO meta(key,value) VALUES('sync_fencing_token',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(token));
        const expires=new Date(Date.now()+120_000).toISOString();db.prepare('UPDATE sync_setups SET fencing_token=?,lease_expires_at=?,updated_at=? WHERE id=?').run(token,expires,now(),task.id);
        return {setupId:task.id,state:task.state,fencingToken:token,leaseExpiresAt:expires};
      })();
    },
    setupBlobStore(request={}){
      const task=setupTask(request),{attachmentId,recordId,name,bytes,digest,branchId=null}=request;if(task.state==='committed')fail('SETUP_ALREADY_COMMITTED');
      if(!validUuid(attachmentId)||typeof recordId!=='string'||typeof name!=='string'||!Buffer.isBuffer(bytes)||hash(bytes)!==digest)fail('VALIDATION_ERROR');
      const expected=db.prepare("SELECT payload FROM sync_setup_items WHERE setup_id=? AND entity_type='attachments' ORDER BY ordinal").all(task.id).map(row=>parse(row.payload)).find(row=>row.id===attachmentId&&(row.branchId??null)===branchId);
      if(!expected||expected.recordId!==recordId||expected.name!==name||expected.hash!==digest||expected.byteLength!==bytes.length||(expected.branchId??null)!==branchId)fail('MANIFEST_MISMATCH',{attachmentId});
      const storedBranchId=branchId??'';
      const old=db.prepare('SELECT record_id,name,digest,byte_length,branch_id FROM sync_setup_blobs WHERE setup_id=? AND attachment_id=? AND branch_id=?').get(task.id,attachmentId,storedBranchId);
      if(old){if(old.record_id!==recordId||old.name!==name||old.digest!==digest||old.byte_length!==bytes.length||(old.branch_id||null)!==branchId)fail('OPERATION_REUSED');return {attachmentId,alreadyPresent:true,digest,byteLength:bytes.length};}
      db.prepare('INSERT INTO sync_setup_blobs(setup_id,attachment_id,record_id,name,branch_id,digest,byte_length,data) VALUES(?,?,?,?,?,?,?,?)').run(task.id,attachmentId,recordId,name,storedBranchId,digest,bytes.length,bytes);
      return {attachmentId,alreadyPresent:false,digest,byteLength:bytes.length};
    },
    setupBlobCheck(request={}){
      const task=setupTask(request),{attachmentId,recordId,name,digest,byteLength,branchId=null}=request;
      const expected=db.prepare("SELECT payload FROM sync_setup_items WHERE setup_id=? AND entity_type='attachments' ORDER BY ordinal").all(task.id).map(row=>parse(row.payload)).find(row=>row.id===attachmentId&&(row.branchId??null)===branchId);
      if(!expected||expected.recordId!==recordId||expected.name!==name||expected.hash!==digest||expected.byteLength!==byteLength||(expected.branchId??null)!==branchId)fail('MANIFEST_MISMATCH',{attachmentId});
      return {setupId:task.id,attachmentId,accepted:true};
    },
    setupCommit(request={}){
      return db.transaction(()=>{
        const task=setupTask(request);if(task.state==='committed')return parse(task.result);
        const progress=setupProgress(task);if(progress.state!=='ready')fail('SETUP_NOT_READY',{missingEntities:progress.missingEntities,missingAttachmentIds:progress.missingAttachmentIds});
        if(Number(syncMeta('sync_target_generation')??'0')!==task.target_generation||libraryId()!==task.expected_library_id||epoch()!==task.expected_epoch||currentCursor()!==task.target_cursor)fail('SETUP_TARGET_CHANGED',{targetGeneration:Number(syncMeta('sync_target_generation')??'0'),cursor:currentCursor(),expectedCursor:task.target_cursor});
        const manifest=parse(task.manifest),entities={};
        for(const type of entityTypes)entities[type]=db.prepare('SELECT payload FROM sync_setup_items WHERE setup_id=? AND entity_type=? ORDER BY ordinal').all(task.id,type).map(row=>parse(row.payload));
        const records=new Map(entities.records.map(item=>{const valid=recordSchema.safeParse(item);if(!valid.success)fail('VALIDATION_ERROR',{entityType:'records'});return [item.id,item];}));
        const heads=new Map(entities.heads.map(item=>[item.recordId,item]));
        const versionsByRecord=new Map();for(const version of entities.versions){let list=versionsByRecord.get(version.recordId);if(!list)versionsByRecord.set(version.recordId,list=[]);list.push(version);}
        const versionsById=new Map(entities.versions.map(item=>[item.id,item]));
        if(heads.size!==records.size||[...records.keys()].some(id=>!heads.has(id)))fail('MANIFEST_MISMATCH',{entityType:'heads'});
        for(const [recordId,record] of records){const head=heads.get(recordId),versions=versionsByRecord.get(recordId)??[],currentVersion=versionsById.get(head.versionId);
          if(!currentVersion||currentVersion.recordId!==recordId||head.deleted!==record.deleted||currentVersion.revision!==head.revision||currentVersion.markdown!==record.markdown||currentVersion.sources.map(s=>s.text).join('')!==currentVersion.markdown)fail('MANIFEST_MISMATCH',{recordId,field:'head'});
          for(const version of versions)if(markdownSource(version.doc)!==version.markdown||version.sources.map(s=>s.text).join('')!==version.markdown)fail('MANIFEST_MISMATCH',{recordId,versionId:version.id});
        }
        if(versionsById.size!==entities.versions.length)fail('MANIFEST_MISMATCH',{entityType:'versions'});
        for(const version of entities.versions)if(version.journalInput){const input=version.journalInput,owner=records.get(version.recordId);if(owner?.kind!=='journal'||input.kind!=='journal'||input.sources.map(x=>x.text).join('')!==input.markdown||!entities.versions.some(v=>v.recordId===version.recordId&&v.markdown===input.markdown&&canonicalJSON(v.sources)===canonicalJSON(input.sources)&&v.journalInput&&canonicalJSON(v.journalInput)===canonicalJSON(input)))fail('MANIFEST_MISMATCH',{versionId:version.id,field:'journalInput'});}
        for(const version of entities.versions)for(const parentId of version.parentVersionIds){const parent=versionsById.get(parentId);if(!parent||parent.recordId!==version.recordId)fail('MANIFEST_MISMATCH',{recordId:version.recordId,versionId:version.id,parentVersionId:parentId});}
        const visiting=new Set(),visited=new Set(),visitVersion=id=>{if(visiting.has(id))fail('MANIFEST_MISMATCH',{entityType:'versions',cycleAt:id});if(visited.has(id))return;visiting.add(id);for(const parentId of versionsById.get(id).parentVersionIds)visitVersion(parentId);visiting.delete(id);visited.add(id);};
        for(const id of versionsById.keys())visitVersion(id);
        for(const link of entities.links){const article=records.get(link.articleId),material=records.get(link.materialId);if(!article||article.kind!=='article'||!material||material.kind==='article')fail('VALIDATION_ERROR',{entityType:'links'});}
        for(const record of entities.records){const linked=entities.links.filter(link=>link.articleId===record.id).map(link=>link.materialId).sort(),declared=[...record.sourceIds].sort();if(record.kind==='article'&&JSON.stringify(linked)!==JSON.stringify(declared)||record.kind!=='article'&&record.sourceIds.length)fail('MANIFEST_MISMATCH',{recordId:record.id,field:'sourceIds'});}
        for(const activity of entities.activities){const parsed=activitySchema.safeParse(activity);if(!parsed.success||!records.has(activity.recordId)||activity.afterSegments.map(s=>s.text).join('')===''&&activity.afterHash!==contentHash('',[])||activity.afterHash!==contentHash(activity.afterSegments.map(s=>s.text).join(''),activity.afterSegments))fail('VALIDATION_ERROR',{entityType:'activities',activityId:activity.activityId});}
        const blobs=new Map(db.prepare('SELECT * FROM sync_setup_blobs WHERE setup_id=?').all(task.id).map(row=>[blobKey(row.attachment_id,row.branch_id),row]));
        for(const attachment of entities.attachments){const blob=blobs.get(blobKey(attachment.id,attachment.branchId));if(!records.has(attachment.recordId)||attachment.branchId&&!entities.branches.some(branch=>branch.branchId===attachment.branchId&&branch.recordId===attachment.recordId)||!blob||blob.record_id!==attachment.recordId||blob.name!==attachment.name||blob.digest!==attachment.hash||blob.byte_length!==attachment.byteLength||hash(blob.data)!==attachment.hash)fail('SETUP_NOT_READY',{attachmentId:attachment.id,branchId:attachment.branchId??null});}
        for(const record of records.values())for(const descriptor of record.attachmentDescriptors)if(!entities.attachments.some(item=>item.id===descriptor.id&&item.recordId===record.id&&item.hash===descriptor.hash&&item.byteLength===descriptor.byteLength&&item.name===descriptor.name))fail('MANIFEST_MISMATCH',{recordId:record.id,attachmentId:descriptor.id});
        const targetGeneration=task.target_generation+1,newEpoch=randomUUID(),serverId=syncMeta('sync_server_id');
        for(const table of ['annotation_relations','conversation_sources','links','versions','edits','attachments','imports','record_dates','dsh_record_sources','record_sources','external_sources','sync_changes','sync_activities','sync_journal_inputs','sync_record_sources','sync_version_sources','sync_version_parents','sync_provenance','sync_branch_blobs','sync_branches','sync_acks','sync_manifests','sync_snapshots'])db.prepare(`DELETE FROM ${table}`).run();
        db.prepare('DELETE FROM records').run();db.prepare('DELETE FROM sync_snapshot_items').run();
        db.prepare("UPDATE meta SET value=? WHERE key='sync_library_id'").run(task.library_id);db.prepare("UPDATE meta SET value=? WHERE key='sync_epoch'").run(newEpoch);db.prepare("INSERT INTO meta(key,value) VALUES('sync_target_generation',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(targetGeneration));
        const insertRecord=db.prepare('INSERT INTO records(id,kind,title,doc,body,origin,url,annotation,stage,revision,created,updated,deleted,processing,created_by_device) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
        for(const record of entities.records){const head=heads.get(record.id),version=versionsById.get(head.versionId),doc=version.doc,body=readDoc(doc,record.origin).text;
          insertRecord.run(record.id,record.kind,record.title,JSON.stringify(doc),body,record.origin,record.url,record.annotation,record.stage,head.revision,record.createdAt,record.updatedAt,Number(head.deleted),record.processing,record.createdByDevice);
        }
        const insertVersion=db.prepare('INSERT INTO versions VALUES(?,?,?,?,?,?,?)');
        for(const version of entities.versions){insertVersion.run(version.id,version.recordId,version.revision,JSON.stringify(version.doc),version.title,version.createdAt,version.reason);db.prepare('INSERT INTO sync_version_sources VALUES(?,?,?)').run(version.id,version.markdown,JSON.stringify(version.sources));db.prepare('INSERT INTO sync_version_parents VALUES(?,?)').run(version.id,JSON.stringify(version.parentVersionIds));}
        for(const version of entities.versions)if(version.journalInput)db.prepare('INSERT INTO sync_journal_inputs VALUES(?,?,?)').run(version.id,version.recordId,JSON.stringify(version.journalInput));
        for(const record of entities.records){if(record.kind==='ai_annotation'){const anchor=record.annotationOf,parent=anchor&&records.get(anchor.recordId),version=anchor&&versionsById.get(anchor.versionId);if(!parent||parent.kind==='ai_annotation'||!version||version.recordId!==parent.id||hash(version.markdown)!==anchor.contentHash||record.origin!=='ai'||(versionsByRecord.get(record.id)??[]).some(v=>JSON.stringify(v.annotationOf)!==JSON.stringify(anchor)))fail('MANIFEST_MISMATCH',{recordId:record.id,field:'annotationOf'});db.prepare('INSERT INTO annotation_relations VALUES(?,?,?,?)').run(record.id,anchor.recordId,anchor.versionId,anchor.contentHash);}else if(record.annotationOf)fail('MANIFEST_MISMATCH',{recordId:record.id,field:'annotationOf'});}
        for(const head of entities.heads){const record=records.get(head.recordId);db.prepare('INSERT INTO sync_record_sources VALUES(?,?,?,?)').run(record.id,record.markdown,JSON.stringify(record.sources),now());}
        const insertLink=db.prepare('INSERT INTO links VALUES(?,?)');for(const link of entities.links)insertLink.run(link.articleId,link.materialId);
        for(const attachment of entities.attachments){if(attachment.branchId)continue;const blob=blobs.get(blobKey(attachment.id,null));db.prepare('INSERT INTO attachments VALUES(?,?,?,?,?)').run(attachment.id,attachment.recordId,attachment.name,Buffer.from(blob.data).toString('base64'),attachment.createdAt);}
        for(const activity of entities.activities)db.prepare('INSERT INTO sync_activities VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(activity.activityId,activity.recordId,activity.changeId??activity.activityId,activity.originDeviceId,activity.occurredAt,activity.timeZone,activity.beforeHash,activity.afterHash,JSON.stringify(activity.afterSegments),activity.action,activity.authorship);
        const provenanceById=new Map(entities.provenance.map(item=>[item.recordId,item]));
        for(const record of entities.records){
          const data=provenanceById.get(record.id);if(data)db.prepare('INSERT INTO sync_provenance VALUES(?,?)').run(record.id,canonicalJSON(data));
          if(data?.import){const relativePath=typeof data.import.sourceName==='string'&&data.import.sourceName&&!data.import.sourceName.startsWith('/')?data.import.sourceName:record.id;const metadata={assetArchive:Boolean(data.import.assetArchive),files:(data.import.files??[]).map(file=>({id:file.attachmentId,path:file.relativePath,sha256:file.hash,bytes:file.byteLength})),_import:{originalAttachment:data.import.originalAttachmentId,dateCandidates:data.import.dateCandidates??[],warnings:data.import.warnings??[]}};
            const links=(data.import.links??[]).map(link=>({kind:link.kind,label:link.label,record:link.targetRecordId,attachment:link.targetAttachmentId,path:link.relativePath}));
            const importDay=Object.hasOwn(data.import,'contentDay')?data.import.contentDay:record.contentDay;
            const importDateBasis=Object.hasOwn(data.import,'dateBasis')?data.import.dateBasis:record.dateBasis;
            db.prepare('INSERT INTO imports VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(record.id,`mobile-sync:${task.library_id}`,relativePath,'',importDay??null,importDateBasis??'',record.markdown.length,data.import.duplicateOf??null,JSON.stringify(metadata),JSON.stringify(links),now());
          }else db.prepare('INSERT INTO record_dates VALUES(?,?,?)').run(record.id,record.contentDay,record.dateBasis);
          for(const source of data?.sources??[]){if(source.kind==='conversation'&&source.sessionId&&source.messageId)db.prepare('INSERT OR IGNORE INTO dsh_record_sources VALUES(?,?,?,?,?)').run(record.id,source.sessionId,source.messageId,source.role,source.excerpt??'');else if(source.sourceRecordId||source.messageId)db.prepare('INSERT INTO record_sources VALUES(?,?,?,?,?,?,?)').run(randomUUID(),record.id,source.sourceRecordId??null,source.messageId??null,source.role??'unknown',source.revision??null,source.excerpt??'');}
          for(const source of data?.externalSources??[])db.prepare('INSERT INTO external_sources VALUES(?,?,?,?,?,?,?,?,?)').run(randomUUID(),record.id,source.sourceServerId??'remote',source.clientName??'远端来源',source.action??'sync',source.sessionId??'',source.messageId??'','',source.occurredAt??now());
        }
        for(const branch of entities.branches){const payload=canonicalJSON(branch);db.prepare('INSERT INTO sync_branches VALUES(?,?,?,?,?,?,?,?,?,?)').run(branch.branchId,branch.recordId,branch.state,branch.sourceServerId,branch.sourceEpoch,branch.sourceDeviceId,branch.manifestDigest,payload,branch.createdAt,now());for(const attachment of branch.attachments){const blob=blobs.get(blobKey(attachment.id,branch.branchId));db.prepare('INSERT INTO sync_branch_blobs VALUES(?,?,?,?,?,?)').run(branch.branchId,attachment.id,attachment.name,attachment.hash,attachment.byteLength,blob.data);}}
        for(const record of entities.records)appendSyncChange(record.id,'restore',{createActivity:false,preserveSources:true});
        consolidateJournals();
        const result={setupId:task.id,state:'committed',libraryId:task.library_id,serverId,epoch:newEpoch,sourceEpoch:task.source_epoch,targetGeneration,highWatermark:currentCursor(),records:entities.records.length,versions:entities.versions.length,activities:entities.activities.length,attachments:entities.attachments.length};
        db.prepare("UPDATE sync_setups SET state='committed',result=?,updated_at=? WHERE id=?").run(JSON.stringify(result),now(),task.id);return result;
      })();
    },
    setupAbort(request={}){
      return db.transaction(()=>{const task=setupTask(request,{allowExpired:true});if(task.state==='committed')fail('SETUP_ALREADY_COMMITTED');db.prepare("UPDATE sync_setups SET state='aborted',updated_at=? WHERE id=?").run(now(),task.id);return {setupId:task.id,state:'aborted',retained:true};})();
    },
    reconcileBegin(request={}){
      const {taskId,mode,libraryId:requestedLibrary,sourceEpoch,targetEpoch,sourceDeviceId,sourceServerId,sourceManifest,manifestDigest,operationCount,operationDigest,targetGeneration}=request;
      if(!validUuid(taskId)||!['coordinator-recovery','device-restore'].includes(mode)||requestedLibrary!==libraryId()||!validUuid(sourceEpoch)||targetEpoch!==epoch()||!validUuid(sourceDeviceId)||!/^([a-f0-9]{64})$/.test(manifestDigest)||!integer(operationCount,0,1_000_000)||!integer(targetGeneration))fail('VALIDATION_ERROR');
      if(sourceManifest){if(sourceManifest.libraryId!==requestedLibrary)fail('LIBRARY_MISMATCH');const core={...sourceManifest};delete core.manifestDigest;if(sourceManifest.protocolVersion!==protocolVersion||sourceManifest.epoch!==sourceEpoch||sourceManifest.manifestDigest!==fingerprint(core)||sourceManifest.entityTypes?.join(',')!==entityTypes.join(',')||!sourceManifest.counts||!sourceManifest.entityDigests||!/^([a-f0-9]{64})$/.test(operationDigest)||!validUuid(sourceServerId))fail('MANIFEST_MISMATCH');for(const type of entityTypes)if(!integer(sourceManifest.counts[type])||!/^([a-f0-9]{64})$/.test(sourceManifest.entityDigests[type]))fail('MANIFEST_MISMATCH',{entityType:type});
        if(manifestDigest!==fingerprint({sourceServerId,sourceDeviceId,sourceManifest,operationCount,operationDigest}))fail('MANIFEST_MISMATCH');}
      const requestHash=fingerprint({taskId,mode,libraryId:requestedLibrary,sourceEpoch,targetEpoch,sourceDeviceId,...(sourceServerId?{sourceServerId}:{}),...(sourceManifest?{sourceManifest}:{}),manifestDigest,operationCount,...(operationDigest?{operationDigest}:{}),targetGeneration});
      return db.transaction(()=>{
        const prior=db.prepare('SELECT * FROM sync_reconciliations WHERE id=?').get(taskId);if(prior){if(prior.owner_id!==ownerId||prior.request_fingerprint!==requestHash)fail('OPERATION_REUSED');return prior.result?parse(prior.result):reconcileProgress(prior);}
        if(Number(syncMeta('sync_target_generation')??'0')!==targetGeneration)fail('SETUP_TARGET_CHANGED',{targetGeneration:Number(syncMeta('sync_target_generation')??'0')});
        const token=Number(syncMeta('sync_reconcile_fencing_token')??'0')+1,at=now(),expires=new Date(Date.now()+120_000).toISOString(),cursor=currentCursor();
        db.prepare("INSERT INTO meta(key,value) VALUES('sync_reconcile_fencing_token',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(token));
        db.prepare('INSERT INTO sync_reconciliations(id,owner_id,request_fingerprint,mode,library_id,source_epoch,target_epoch,manifest_digest,state,created_at,updated_at,source_device_id,operation_count,target_generation,target_cursor,fencing_token,lease_expires_at,metadata) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(taskId,ownerId,requestHash,mode,requestedLibrary,sourceEpoch,targetEpoch,manifestDigest,'receiving',at,at,sourceDeviceId,operationCount,targetGeneration,cursor,token,expires,canonicalJSON({sourceDeviceId,sourceServerId:sourceServerId??libraryId(),sourceManifest:sourceManifest??null,operationDigest:operationDigest??null}));
        return {taskId,state:'receiving',fencingToken:token,leaseExpiresAt:expires,manifestDigest,targetEpoch};
      })();
    },
    reconcilePage(request={}){
      const task=reconcileTask(request);if(task.state==='completed')fail('SETUP_ALREADY_COMMITTED');
      const {startOrdinal,items}=request,entityType=request.entityType??'operations',metadata=parse(task.metadata),expected=entityType==='operations'?task.operation_count:metadata.sourceManifest?.counts?.[entityType];if(!integer(startOrdinal)||!Array.isArray(items)||items.length<1||items.length>PAGE_SIZE||!integer(expected)||startOrdinal+items.length>expected)fail('VALIDATION_ERROR');
      const validated=items.map(item=>{if(entityType==='operations'){if(!item||item.deviceId!==task.source_device_id)fail('PERMISSION_DENIED');const operation=parseOperation(item.operation);return {deviceId:item.deviceId,operation};}if(!entityTypes.includes(entityType))fail('VALIDATION_ERROR',{field:'entityType'});validateSetupItem(entityType,item);return item;});
      if(Buffer.byteLength(canonicalJSON(validated))>limits.maxRequestBytes)fail('PAYLOAD_TOO_LARGE');
      return db.transaction(()=>{
        for(let index=0;index<validated.length;index++){const item=validated[index],ordinal=startOrdinal+index,itemId=entityType==='operations'?item.operation.operationId:`${entityType}:${ordinal}`,payload=canonicalJSON(item),digest=fingerprint(item),byOrdinal=db.prepare('SELECT item_id,digest,payload FROM sync_reconciliation_items WHERE task_id=? AND entity_type=? AND ordinal=?').get(task.id,entityType,ordinal),byId=db.prepare('SELECT ordinal,digest,payload FROM sync_reconciliation_items WHERE task_id=? AND item_id=?').get(task.id,itemId);
          if(byOrdinal||byId){const old=byOrdinal??byId;if(old.digest!==digest||old.payload!==payload||byId&&byId.ordinal!==ordinal)fail('OPERATION_REUSED',{operationId:itemId});continue;}
          db.prepare('INSERT INTO sync_reconciliation_items(task_id,item_id,digest,payload,ordinal,entity_type) VALUES(?,?,?,?,?,?)').run(task.id,itemId,digest,payload,ordinal,entityType);
        }
        const fresh=db.prepare('SELECT * FROM sync_reconciliations WHERE id=?').get(task.id),progress=reconcileProgress(fresh);if(progress.state==='ready')db.prepare("UPDATE sync_reconciliations SET state='ready',updated_at=? WHERE id=?").run(now(),task.id);return {...progress,entityType,startOrdinal,accepted:validated.length,pageDigest:fingerprint(validated)};
      })();
    },
    reconcileItemCheck(request={}){const task=reconcileTask(request),metadata=parse(task.metadata),type=request.entityType,expected=type==='operations'?task.operation_count:metadata.sourceManifest?.counts?.[type];if(!(type==='operations'||entityTypes.includes(type))||!integer(request.ordinal)||request.ordinal>=expected)fail('VALIDATION_ERROR');return {taskId:task.id,entityType:type,ordinal:request.ordinal,accepted:true};},
    reconcileStatus(request={}){
      const task=reconcileTask(request,{allowExpired:true}),progress=reconcileProgress(task);return {...progress,...(task.result?{result:parse(task.result)}:{})};
    },
    reconcileBlobStore(request={}){
      const task=reconcileTask(request),{attachmentId,bytes,digest}=request;if(!validUuid(attachmentId)||!Buffer.isBuffer(bytes)||hash(bytes)!==digest)fail('VALIDATION_ERROR');
      const descriptor=reconcileItems(task,'attachments').find(item=>item.id===attachmentId&&(item.branchId??null)===(request.branchId??null));if(!descriptor||descriptor.hash!==digest||descriptor.byteLength!==bytes.length)fail('MANIFEST_MISMATCH',{attachmentId});
      const branchId=descriptor.branchId??'',old=db.prepare('SELECT * FROM sync_reconciliation_blobs WHERE task_id=? AND attachment_id=? AND branch_id=?').get(task.id,attachmentId,branchId);
      if(old){if(old.digest!==digest||old.byte_length!==bytes.length||!Buffer.from(old.data).equals(bytes))fail('OPERATION_REUSED');return {taskId:task.id,attachmentId,alreadyPresent:true,digest,byteLength:bytes.length};}
      db.prepare('INSERT INTO sync_reconciliation_blobs VALUES(?,?,?,?,?,?,?,?)').run(task.id,attachmentId,branchId,descriptor.recordId,descriptor.name,digest,bytes.length,bytes);
      return {taskId:task.id,attachmentId,alreadyPresent:false,digest,byteLength:bytes.length};
    },
    reconcileBlobCheck(request={}){const task=reconcileTask(request),item=reconcileItems(task,'attachments').find(value=>value.id===request.attachmentId&&(value.branchId??null)===(request.branchId??null));if(!item||item.hash!==request.digest||item.byteLength!==request.byteLength||item.recordId!==request.recordId||item.name!==request.name)fail('MANIFEST_MISMATCH',{attachmentId:request.attachmentId});return {taskId:task.id,attachmentId:item.id,accepted:true};},
    reconcileCandidates(request={}){
      const task=reconcileTask(request,{allowExpired:true});if(reconcileProgress(task).state!=='ready')fail('SETUP_NOT_READY');const cursor=integer(request.cursor??0)?request.cursor:fail('VALIDATION_ERROR'),limit=integer(request.limit??50,1,100)?(request.limit??50):fail('VALIDATION_ERROR'),all=reconcileCandidatesFor(task),items=all.slice(cursor,cursor+limit),resolutions=db.prepare("SELECT payload FROM sync_reconciliation_items WHERE task_id=? AND entity_type='resolution'").all(task.id).map(row=>parse(row.payload)),byBranch=new Map(resolutions.filter(value=>value.branchId).map(value=>[value.branchId,value]));return {taskId:task.id,items:items.map(item=>{const decision=byBranch.get(item.branchId);return {...item,resolution:decision?.status??null,resolved:Boolean(decision&&['retained','merged','discarded'].includes(decision.status))};}),nextCursor:cursor+items.length<all.length?cursor+items.length:null,total:all.length};
    },
    reconcileBranchRead(request={}){
      const task=reconcileTask(request,{allowExpired:true});if(reconcileProgress(task).state!=='ready')fail('SETUP_NOT_READY');const candidate=reconcileCandidatesFor(task).find(item=>item.branchId===request.branchId);if(!candidate)fail('DEPENDENCY_MISSING',{branchId:request.branchId});const recordId=candidate.recordId,records=reconcileItems(task,'records'),record=records.find(item=>item.id===recordId),head=reconcileItems(task,'heads').find(item=>item.recordId===recordId),versions=reconcileItems(task,'versions').filter(item=>item.recordId===recordId),activities=reconcileItems(task,'activities').filter(item=>item.recordId===recordId),links=reconcileItems(task,'links').filter(item=>item.articleId===recordId||item.materialId===recordId),provenance=reconcileItems(task,'provenance').find(item=>item.recordId===recordId)??null,attachments=reconcileItems(task,'attachments').filter(item=>item.recordId===recordId&&!item.branchId);
      return {branchId:candidate.branchId,recordId,state:'candidate',sourceServerId:parse(task.metadata).sourceServerId,sourceEpoch:task.source_epoch,sourceDeviceId:task.source_device_id,manifestDigest:parse(task.metadata).sourceManifest.manifestDigest,head,record,versions,activities,links,provenance,attachments,createdAt:now()};
    },
    reconcileDecide(request={}){
      const task=reconcileTask(request);if(reconcileProgress(task).state!=='ready')fail('SETUP_NOT_READY');const {branchId,resolution,resolutionId=randomUUID(),deviceId,expectedTargetHead}=request;if(!validUuid(branchId)||!validUuid(resolutionId)||!['retain-branch','use-branch','discard'].includes(resolution))fail('VALIDATION_ERROR');
      const bundle=this.reconcileBranchRead({taskId:task.id,fencingToken:task.fencing_token,branchId});
      const requestHash=fingerprint({taskId:task.id,branchId,resolution,expectedTargetHead:expectedTargetHead??null}),key=`resolution:${resolutionId}`;
      return db.transaction(()=>{
        assertReconcileTarget(task);
        const prior=db.prepare('SELECT digest,payload FROM sync_reconciliation_items WHERE task_id=? AND item_id=?').get(task.id,key);if(prior){if(prior.digest!==requestHash)fail('OPERATION_REUSED');return parse(prior.payload);}
        const priorBranch=db.prepare("SELECT payload FROM sync_reconciliation_items WHERE task_id=? AND entity_type='resolution' ORDER BY ordinal").all(task.id).map(row=>parse(row.payload)).find(value=>value.branchId===branchId);if(priorBranch){if(priorBranch.status!==({ 'retain-branch':'retained','use-branch':'merged','discard':'discarded'}[resolution]))fail('OPERATION_REUSED',{branchId});return priorBranch;}
        const current=get(bundle.recordId),currentVersion=current&&db.prepare('SELECT id FROM versions WHERE record=? ORDER BY revision DESC LIMIT 1').get(bundle.recordId),actualHead=current?{recordId:bundle.recordId,revision:current.revision,versionId:currentVersion?.id??null,changeId:db.prepare('SELECT change_id FROM sync_changes WHERE record_id=? ORDER BY seq DESC LIMIT 1').get(bundle.recordId)?.change_id??null,deleted:Boolean(current.deleted)}:null;
        if(resolution==='use-branch'&&fingerprint(actualHead)!==fingerprint(expectedTargetHead??null))fail('REVISION_CONFLICT',{currentHead:actualHead});
        const state=resolution==='retain-branch'?'retained':resolution==='discard'?'discarded':'merged';const stored={...bundle,state};
        const payload=canonicalJSON(stored);db.prepare('INSERT INTO sync_branches VALUES(?,?,?,?,?,?,?,?,?,?)').run(bundle.branchId,bundle.recordId,state,bundle.sourceServerId,bundle.sourceEpoch,bundle.sourceDeviceId,bundle.manifestDigest,payload,bundle.createdAt,now());
        for(const item of bundle.attachments){const blob=db.prepare('SELECT * FROM sync_reconciliation_blobs WHERE task_id=? AND attachment_id=? AND branch_id=?').get(task.id,item.id,item.branchId??'');if(!blob)fail('SETUP_NOT_READY',{attachmentId:item.id});db.prepare('INSERT INTO sync_branch_blobs VALUES(?,?,?,?,?,?)').run(bundle.branchId,item.id,item.name,item.hash,item.byteLength,blob.data);}
        if(resolution==='use-branch'){
          if(current && (current.kind==='ai_annotation'||bundle.record.kind==='ai_annotation') && (current.kind!==bundle.record.kind||JSON.stringify(current.annotationOf)!==JSON.stringify(bundle.record.annotationOf)))fail('VALIDATION_ERROR',{field:'annotationOf'});
          if(bundle.record.kind==='ai_annotation'){const a=bundle.record.annotationOf,parent=a&&get(a.recordId),version=a&&db.prepare('SELECT record,doc FROM versions WHERE id=?').get(a.versionId);if(!parent||!version)fail('DEPENDENCY_MISSING',{field:'annotationOf'});if(parent.kind==='ai_annotation'||version.record!==parent.id||hash(markdownSource(parse(version.doc)))!==a.contentHash||bundle.record.origin!=='ai'||bundle.versions.some(v=>JSON.stringify(v.annotationOf)!==JSON.stringify(a)))fail('VALIDATION_ERROR',{field:'annotationOf'});}
          if(bundle.record.kind==='article'&&bundle.record.sourceIds.some(id=>!get(id)))fail('DEPENDENCY_MISSING',{recordId:bundle.recordId,missingRecordIds:bundle.record.sourceIds.filter(id=>!get(id))});
          if(!current){const initialDoc=docFromSources(bundle.record.sources),initialBody=readDoc(initialDoc,bundle.record.origin).text;db.prepare('INSERT INTO records(id,kind,title,doc,body,origin,url,annotation,stage,revision,created,updated,deleted,processing,created_by_device) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(bundle.recordId,bundle.record.kind,bundle.record.title,JSON.stringify(initialDoc),initialBody,bundle.record.origin,bundle.record.url,bundle.record.annotation,bundle.record.stage,0,bundle.record.createdAt,bundle.record.updatedAt,Number(bundle.head.deleted),bundle.record.processing,bundle.record.createdByDevice);}
          if(!current&&bundle.record.kind==='ai_annotation'){const a=bundle.record.annotationOf;db.prepare('INSERT INTO annotation_relations VALUES(?,?,?,?)').run(bundle.recordId,a.recordId,a.versionId,a.contentHash);}
          for(const value of bundle.versions)if(value.journalInput){const input=value.journalInput;if(bundle.record.kind!=='journal'||input.kind!=='journal'||input.sources.map(x=>x.text).join('')!==input.markdown||!bundle.versions.some(v=>v.markdown===input.markdown&&canonicalJSON(v.sources)===canonicalJSON(input.sources)&&v.journalInput&&canonicalJSON(v.journalInput)===canonicalJSON(input)))fail('MANIFEST_MISMATCH',{versionId:value.id,field:'journalInput'});}
          const sourceVersionIds=new Set(bundle.versions.map(value=>value.id));for(const version of bundle.versions){const old=db.prepare('SELECT * FROM versions WHERE id=?').get(version.id);if(old&&(old.record!==bundle.recordId||canonicalJSON(parse(old.doc))!==canonicalJSON(version.doc)))fail('OPERATION_REUSED',{versionId:version.id});}
          const versionMap=new Map(bundle.versions.map(value=>[value.id,value])),pending=new Set(bundle.versions.filter(value=>!db.prepare('SELECT 1 FROM versions WHERE id=?').get(value.id)).map(value=>value.id));let revision=Number(db.prepare('SELECT COALESCE(MAX(revision),0) AS n FROM versions WHERE record=?').get(bundle.recordId).n);
          while(pending.size){let progressed=false;for(const id of [...pending]){const value=versionMap.get(id);if(value.parentVersionIds.every(parent=>!sourceVersionIds.has(parent)||!pending.has(parent))){for(const parent of value.parentVersionIds)if(!sourceVersionIds.has(parent)&&!db.prepare('SELECT 1 FROM versions WHERE id=? AND record=?').get(parent,bundle.recordId))fail('MANIFEST_MISMATCH',{versionId:id,parentVersionId:parent});revision++;db.prepare('INSERT INTO versions VALUES(?,?,?,?,?,?,?)').run(value.id,bundle.recordId,revision,JSON.stringify(value.doc),value.title,value.createdAt,value.reason);db.prepare('INSERT INTO sync_version_sources VALUES(?,?,?)').run(value.id,value.markdown,JSON.stringify(value.sources));db.prepare('INSERT INTO sync_version_parents VALUES(?,?)').run(value.id,JSON.stringify(value.parentVersionIds));pending.delete(id);progressed=true;}}if(!progressed)fail('MANIFEST_MISMATCH',{field:'versionParents'});}
          for(const value of bundle.versions)if(value.journalInput){const existing=db.prepare('SELECT record_id,payload FROM sync_journal_inputs WHERE version_id=?').get(value.id);if(existing&&(existing.record_id!==bundle.recordId||canonicalJSON(parse(existing.payload))!==canonicalJSON(value.journalInput)))fail('OPERATION_REUSED',{versionId:value.id});if(!existing)db.prepare('INSERT INTO sync_journal_inputs VALUES(?,?,?)').run(value.id,bundle.recordId,JSON.stringify(value.journalInput));}
          const before=current?.sources??[],doc=docFromSources(bundle.record.sources),body=readDoc(doc,bundle.record.origin).text,createdAt=current?.created??bundle.record.createdAt,updatedAt=now();revision++;
          if(current)db.prepare('UPDATE records SET kind=?,title=?,doc=?,body=?,origin=?,url=?,annotation=?,stage=?,revision=?,created=?,updated=?,deleted=?,processing=?,created_by_device=? WHERE id=?').run(bundle.record.kind,bundle.record.title,JSON.stringify(doc),body,bundle.record.origin,bundle.record.url,bundle.record.annotation,bundle.record.stage,revision,createdAt,updatedAt,Number(bundle.head.deleted),bundle.record.processing,bundle.record.createdByDevice,bundle.recordId);
          else db.prepare('UPDATE records SET kind=?,title=?,doc=?,body=?,origin=?,url=?,annotation=?,stage=?,revision=?,created=?,updated=?,deleted=?,processing=?,created_by_device=? WHERE id=?').run(bundle.record.kind,bundle.record.title,JSON.stringify(doc),body,bundle.record.origin,bundle.record.url,bundle.record.annotation,bundle.record.stage,revision,createdAt,updatedAt,Number(bundle.head.deleted),bundle.record.processing,bundle.record.createdByDevice,bundle.recordId);
          if(current?.kind==='article'||bundle.record.kind==='article'){db.prepare('DELETE FROM links WHERE article=?').run(bundle.recordId);if(bundle.record.kind==='article')for(const sourceId of bundle.record.sourceIds)db.prepare('INSERT INTO links VALUES(?,?)').run(bundle.recordId,sourceId);}
          for(const item of bundle.attachments.filter(value=>!value.branchId)){const blob=db.prepare("SELECT data FROM sync_reconciliation_blobs WHERE task_id=? AND attachment_id=? AND branch_id=''").get(task.id,item.id),existing=db.prepare('SELECT data,record,name FROM attachments WHERE id=?').get(item.id);if(existing&&(existing.record!==bundle.recordId||existing.name!==item.name||hash(Buffer.from(existing.data,'base64'))!==item.hash))fail('OPERATION_REUSED',{attachmentId:item.id});if(!existing)db.prepare('INSERT INTO attachments VALUES(?,?,?,?,?)').run(item.id,bundle.recordId,item.name,Buffer.from(blob.data).toString('base64'),item.createdAt);}
          if(bundle.record.contentDay!==null){if(db.prepare('SELECT 1 FROM imports WHERE record=?').get(bundle.recordId))db.prepare('UPDATE imports SET day=?,date_basis=? WHERE record=?').run(bundle.record.contentDay,bundle.record.dateBasis,bundle.recordId);else db.prepare('INSERT INTO record_dates(record,day,basis) VALUES(?,?,?) ON CONFLICT(record) DO UPDATE SET day=excluded.day,basis=excluded.basis').run(bundle.recordId,bundle.record.contentDay,bundle.record.dateBasis);}
          const mergeVersionId=randomUUID(),mergeParents=[...(actualHead?.versionId?[actualHead.versionId]:[]),bundle.head.versionId];db.prepare('INSERT INTO versions VALUES(?,?,?,?,?,?,?)').run(mergeVersionId,bundle.recordId,revision,JSON.stringify(doc),bundle.record.title,updatedAt,'移动端分支合并');db.prepare('INSERT INTO sync_version_sources VALUES(?,?,?)').run(mergeVersionId,bundle.record.markdown,JSON.stringify(bundle.record.sources));db.prepare('INSERT INTO sync_version_parents VALUES(?,?)').run(mergeVersionId,JSON.stringify(mergeParents));
          if(bundle.provenance)db.prepare('INSERT INTO sync_provenance VALUES(?,?) ON CONFLICT(record_id) DO UPDATE SET payload=excluded.payload').run(bundle.recordId,canonicalJSON(bundle.provenance));
          for(const activity of bundle.activities)db.prepare('INSERT OR IGNORE INTO sync_activities VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(activity.activityId,bundle.recordId,activity.changeId??activity.activityId,activity.originDeviceId,activity.occurredAt,activity.timeZone,activity.beforeHash,activity.afterHash,JSON.stringify(activity.afterSegments),activity.action,activity.authorship);
          appendSyncChange(bundle.recordId,'update',{versionId:mergeVersionId,createActivity:false,preserveSources:true});const storedActivities=bundle.activities.map(activity=>({activityId:activity.activityId,occurredAt:activity.occurredAt,afterSegments:activity.afterSegments,action:activity.action}));projectActivitiesToEdits(bundle.recordId,storedActivities,before);advanceReconcileTarget(task.id);
        }
        const result={resolutionId,branchId,recordId:bundle.recordId,status:state,targetHead:actualHead,sourceHead:bundle.head};db.prepare('INSERT INTO sync_reconciliation_items(task_id,item_id,digest,payload,ordinal,entity_type) VALUES(?,?,?,?,?,?)').run(task.id,key,requestHash,canonicalJSON(result),Number(db.prepare("SELECT COALESCE(MAX(ordinal),0)+1 AS n FROM sync_reconciliation_items WHERE task_id=? AND entity_type='resolution'").get(task.id).n),'resolution');return result;
      })();
    },
    reconcileReceipts(request={}){
      const task=reconcileTask(request,{allowExpired:true});if(reconcileProgress(task).state!=='ready')fail('SETUP_NOT_READY');
      if(!Array.isArray(request.operationIds)||request.operationIds.length<1||request.operationIds.length>limits.maxBatchOperations)fail('VALIDATION_ERROR');
      return {taskId:task.id,receipts:request.operationIds.map(id=>reconcileReceiptFor(task,reconcileOperation(task,id)))};
    },
    reconcileLease(request={}){
      return db.transaction(()=>{const task=reconcileTask(request,{allowExpired:true});if(task.state==='completed')return {taskId:task.id,state:'completed',result:parse(task.result)};
        assertReconcileTarget(task);
        const expired=Date.parse(task.lease_expires_at)<=Date.now(),token=expired?Number(syncMeta('sync_reconcile_fencing_token')??'0')+1:task.fencing_token;if(expired)db.prepare("INSERT INTO meta(key,value) VALUES('sync_reconcile_fencing_token',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(token));
        const expires=new Date(Date.now()+120_000).toISOString();db.prepare('UPDATE sync_reconciliations SET fencing_token=?,lease_expires_at=?,updated_at=? WHERE id=?').run(token,expires,now(),task.id);return {taskId:task.id,state:task.state,fencingToken:token,leaseExpiresAt:expires};})();
    },
    reconcileApply(request={}){
      const task=reconcileTask(request);if(reconcileProgress(task).state!=='ready')fail('SETUP_NOT_READY');
      if(!validUuid(request.resolutionId)||!['push','discard'].includes(request.resolution)||!validUuid(request.deviceId))fail('VALIDATION_ERROR');
      const oldItem=reconcileOperation(task,request.operationId),key=`resolution:${request.resolutionId}`,replacement=request.resolution==='push'?parseOperation(request.operation):null;
      if(replacement&&(replacement.recordId!==oldItem.operation.recordId||replacement.changeId!==oldItem.operation.changeId||replacement.operationId===oldItem.operation.operationId))fail('VALIDATION_ERROR',{field:'operation'});
      const requestHash=fingerprint({taskId:task.id,resolutionId:request.resolutionId,operationId:request.operationId,resolution:request.resolution,operation:replacement});
      return db.transaction(()=>{
        assertReconcileTarget(task);
        const existing=db.prepare('SELECT digest,payload FROM sync_reconciliation_items WHERE task_id=? AND item_id=?').get(task.id,key);if(existing){if(existing.digest!==requestHash)fail('OPERATION_REUSED');return parse(existing.payload);}
        let result;if(request.resolution==='discard')result={resolutionId:request.resolutionId,operationId:request.operationId,status:'discarded'};
        else {const already=reconcileReceiptFor(task,oldItem);if(already.status==='applied')result={resolutionId:request.resolutionId,operationId:request.operationId,status:'applied',mapped:already};else {const pushed=this.push({libraryId:task.library_id,epoch:task.target_epoch,deviceId:request.deviceId,operations:[{inlineBody:replacement}]}).receipts[0];if(pushed.status==='applied')advanceReconcileTarget(task.id);result={resolutionId:request.resolutionId,operationId:request.operationId,status:pushed.status,result:pushed};}}
        const nextOrdinal=Number(db.prepare("SELECT COALESCE(MAX(ordinal),0)+1 AS n FROM sync_reconciliation_items WHERE task_id=? AND entity_type='resolution'").get(task.id).n);
        db.prepare('INSERT INTO sync_reconciliation_items(task_id,item_id,digest,payload,ordinal,entity_type) VALUES(?,?,?,?,?,?)').run(task.id,key,requestHash,canonicalJSON(result),nextOrdinal,'resolution');return result;
      })();
    },
    reconcileComplete(request={}){
      return db.transaction(()=>{const task=reconcileTask(request);if(task.state==='completed')return parse(task.result);assertReconcileTarget(task);const progress=reconcileProgress(task);if(progress.state!=='ready')fail('SETUP_NOT_READY');const operations=reconcileItems(task,'operations'),resolutions=db.prepare("SELECT payload FROM sync_reconciliation_items WHERE task_id=? AND entity_type='resolution' ORDER BY ordinal").all(task.id).map(row=>parse(row.payload)),byOperation=new Map(resolutions.filter(value=>value.operationId).map(value=>[value.operationId,value]));
        for(const item of operations){const mapped=reconcileReceiptFor(task,item),explicit=byOperation.get(item.operation.operationId);if(mapped.status!=='applied'&&!explicit)fail('RECONCILIATION_REQUIRED',{operationId:item.operation.operationId,status:mapped.status});if(explicit&&!['applied','discarded'].includes(explicit.status))fail('RECONCILIATION_REQUIRED',{operationId:item.operation.operationId,status:'conflict'});}
        for(const candidate of reconcileCandidatesFor(task)){const explicit=resolutions.find(value=>value.branchId===candidate.branchId&&['retained','merged','discarded'].includes(value.status));if(!explicit)fail('RECONCILIATION_REQUIRED',{branchId:candidate.branchId,recordId:candidate.recordId});}
        const branchPrecedence={discarded:0,retained:1,merged:2};
        for(const incoming of reconcileItems(task,'branches')){
          const old=db.prepare('SELECT * FROM sync_branches WHERE branch_id=?').get(incoming.branchId);
          if(old&&old.record_id!==incoming.recordId)fail('OPERATION_REUSED',{branchId:incoming.branchId});
          const oldPayload=old?parse(old.payload):null,chosenState=oldPayload&&branchPrecedence[old.state]>branchPrecedence[incoming.state]?old.state:incoming.state;
          const payload={...incoming,state:chosenState},encoded=canonicalJSON(payload),at=now();
          if(old)db.prepare('UPDATE sync_branches SET state=?,payload=?,updated_at=? WHERE branch_id=?').run(chosenState,encoded,at,incoming.branchId);
          else db.prepare('INSERT INTO sync_branches VALUES(?,?,?,?,?,?,?,?,?,?)').run(incoming.branchId,incoming.recordId,chosenState,incoming.sourceServerId,incoming.sourceEpoch,incoming.sourceDeviceId,incoming.manifestDigest,encoded,incoming.createdAt,at);
          for(const attachment of incoming.attachments??[]){
            const staged=db.prepare('SELECT * FROM sync_reconciliation_blobs WHERE task_id=? AND attachment_id=? AND branch_id=?').get(task.id,attachment.id,incoming.branchId);
            if(!staged||staged.record_id!==incoming.recordId||staged.name!==attachment.name||staged.digest!==attachment.hash||staged.byte_length!==attachment.byteLength||hash(Buffer.from(staged.data))!==attachment.hash)fail('SETUP_NOT_READY',{attachmentId:attachment.id});
            const prior=db.prepare('SELECT * FROM sync_branch_blobs WHERE branch_id=? AND attachment_id=?').get(incoming.branchId,attachment.id);
            if(prior&&(prior.digest!==attachment.hash||prior.byte_length!==attachment.byteLength||prior.name!==attachment.name||!Buffer.from(prior.data).equals(Buffer.from(staged.data))))fail('OPERATION_REUSED',{attachmentId:attachment.id});
            if(!prior)db.prepare('INSERT INTO sync_branch_blobs VALUES(?,?,?,?,?,?)').run(incoming.branchId,attachment.id,attachment.name,attachment.hash,attachment.byteLength,staged.data);
          }
        }
        const result={taskId:task.id,state:'completed',libraryId:task.library_id,targetEpoch:task.target_epoch,sourceEpoch:task.source_epoch,operationCount:task.operation_count,resolvedOperations:progress.resolvedOperations,candidateCount:progress.candidateCount,resolvedCandidateCount:progress.resolvedCandidateCount,completedAt:now()};db.prepare("UPDATE sync_reconciliations SET state='completed',result=?,updated_at=? WHERE id=?").run(canonicalJSON(result),now(),task.id);return result;})();
    },
    reconcileAbort(request={}){return db.transaction(()=>{const task=reconcileTask(request,{allowExpired:true});if(task.state==='completed')fail('SETUP_ALREADY_COMMITTED');db.prepare("UPDATE sync_reconciliations SET state='aborted',updated_at=? WHERE id=?").run(now(),task.id);return {taskId:task.id,state:'aborted',retained:true};})();},
    identity({protocolVersion:requestedVersion,deviceId}={}){
      validateDevice(deviceId);
      if(requestedVersion!==protocolVersion)fail('PROTOCOL_UNSUPPORTED',{supported:protocolVersion});
      const currentLibraryId=libraryId(),currentEpoch=epoch();
      const activeSetup=db.prepare("SELECT id,state FROM sync_setups WHERE state IN ('receiving','ready') ORDER BY created_at LIMIT 1").get();
      return {serverId:syncMeta('sync_server_id')??currentLibraryId,libraryId:currentLibraryId,epoch:currentEpoch,revision:currentCursor(),targetGeneration:Number(syncMeta('sync_target_generation')??'0'),protocolVersion,setupState:activeSetup?.state??'ready',activeSetupId:activeSetup?.id??null,capabilities:{annotationDocuments:true,dailyJournal:true,fullLibrary:true,bootstrap:true,changes:true,push:true,receipts:true,ack:true,blobs:true,operationPayloads:true,snapshotReferences:true,setup:true,reconcile:true,maxBatchOperations:limits.maxBatchOperations,maxRequestBytes:limits.maxRequestBytes,maxInlineBytes:limits.maxInlineBytes,maxPartBytes:limits.maxPartBytes,maxCanonicalOperationBytes:limits.maxCanonicalOperationBytes,encodingVersion:'shiwen-json-v1',cursorVersion:1,snapshotTtlSeconds:Math.floor(SNAPSHOT_TTL_MS/1000)}};
    },
    bootstrapBegin({libraryId:requestedLibrary,epoch:requestedEpoch,deviceId}={}){
      const identity=assertLibrary({libraryId:requestedLibrary,epoch:requestedEpoch});validateDevice(deviceId);
      const snapshotId=randomUUID(),created=Date.now(),expires=new Date(created+SNAPSHOT_TTL_MS).toISOString();
      return db.transaction(()=>{
        db.prepare('DELETE FROM sync_snapshots WHERE expires_at<=?').run(new Date(created).toISOString());
        const highWatermark=currentCursor();
        const entities=snapshotEntities(),counts=Object.fromEntries(entityTypes.map(type=>[type,entities[type].length]));
        const entityDigests=Object.fromEntries(entityTypes.map(type=>[type,fingerprint(entities[type])]));
        const manifest={protocolVersion,libraryId:identity.libraryId,epoch:identity.epoch,snapshotId,highWatermark,counts,entityDigests,entityTypes};
        const manifestDigest=fingerprint(manifest);
        db.prepare('INSERT INTO sync_manifests VALUES(?,?,?,?)').run(manifestDigest,highWatermark,identity.epoch,new Date(created).toISOString());
        db.prepare('INSERT INTO sync_snapshots VALUES(?,?,?,?,?)').run(snapshotId,highWatermark,JSON.stringify({...manifest,manifestDigest}),new Date(created).toISOString(),expires);
        const insert=db.prepare('INSERT INTO sync_snapshot_items VALUES(?,?,?,?)');
        for(const type of entityTypes)entities[type].forEach((item,index)=>insert.run(snapshotId,type,index,canonicalJSON(item)));
        return {snapshotId,highWatermark,expiresAt:expires,manifest:{...manifest,manifestDigest}};
      })();
    },
    bootstrapPage({snapshotId,entityType,pageToken=null,limit=PAGE_SIZE}={}){
      if(!validUuid(snapshotId)||!entityTypes.includes(entityType)||!integer(limit,1,PAGE_SIZE))fail('VALIDATION_ERROR');
      const snapshot=db.prepare('SELECT * FROM sync_snapshots WHERE id=?').get(snapshotId);
      if(!snapshot||Date.parse(snapshot.expires_at)<=Date.now())fail('CURSOR_EXPIRED');
      const offset=pageToken===null?0:Number(pageToken);
      if(!integer(offset))fail('VALIDATION_ERROR',{field:'pageToken'});
      const manifest=parse(snapshot.manifest),rows=db.prepare('SELECT ordinal,payload FROM sync_snapshot_items WHERE snapshot_id=? AND entity_type=? AND ordinal>=? ORDER BY ordinal LIMIT ?').all(snapshotId,entityType,offset,limit);
      const items=[];let bytes=0;
      for(const row of rows){const size=Buffer.byteLength(row.payload)+1;if(bytes+size>limits.maxCanonicalOperationBytes){if(!items.length)fail('PAYLOAD_TOO_LARGE',{entityType,ordinal:row.ordinal,byteLength:size});break;}items.push(parse(row.payload));bytes+=size;}
      const total=manifest.counts[entityType],next=offset+items.length<total?String(offset+items.length):null;
      return {snapshotId,entityType,items,nextPageToken:next,highWatermark:snapshot.high_watermark,manifestDigest:manifest.manifestDigest};
    },
    changes({libraryId:requestedLibrary,epoch:requestedEpoch,deviceId,cursor,limit=100}={}){
      assertLibrary({libraryId:requestedLibrary,epoch:requestedEpoch});validateDevice(deviceId);
      if(!integer(cursor)||!integer(limit,1,100))fail('VALIDATION_ERROR');
      const highWatermark=currentCursor();if(cursor>highWatermark)fail('VALIDATION_ERROR',{field:'cursor'});const rows=db.prepare('SELECT * FROM sync_changes WHERE seq>? ORDER BY seq LIMIT ?').all(cursor,limit);
      const events=rows.map(row=>{
        const record=parse(row.payload),activities=db.prepare('SELECT * FROM sync_activities WHERE change_id=? ORDER BY activity_id').all(row.change_id).map(a=>({activityId:a.activity_id,recordId:a.record_id,changeId:a.change_id,originDeviceId:a.origin_device_id,occurredAt:a.occurred_at,timeZone:a.time_zone,beforeHash:a.before_hash,afterHash:a.after_hash,afterSegments:parse(a.after_segments),action:a.action,authorship:a.authorship}));
        const storedVersion=row.version_id?db.prepare('SELECT * FROM versions WHERE id=?').get(row.version_id):null;
        let version=null;
        if(storedVersion){
          const doc=parse(storedVersion.doc),markdown=markdownSource(doc),storedSources=db.prepare('SELECT markdown,sources FROM sync_version_sources WHERE version_id=?').get(storedVersion.id),
            parents=db.prepare('SELECT parents FROM sync_version_parents WHERE version_id=?').get(storedVersion.id);
          version={id:storedVersion.id,recordId:storedVersion.record,revision:storedVersion.revision,markdown,doc,...relation(storedVersion.record),...journalInput(storedVersion.id),
            sources:storedSources?.markdown===markdown?parse(storedSources.sources):markdownSegments(doc,record.origin??'unknown'),
            parentVersionIds:parents?parse(parents.parents):[],title:storedVersion.title,createdAt:storedVersion.at,reason:storedVersion.reason};
        }
        return {seq:row.seq,changeId:row.change_id,recordId:row.record_id,versionId:row.version_id,action:row.action,revision:row.revision,record,version,activities,links:parse(row.links),provenance:recordProvenance(record)};
      });
      const nextCursor=events.length?events.at(-1).seq:cursor;
      return {events,nextCursor,hasMore:nextCursor<highWatermark,highWatermark};
    },
    recordHead({libraryId:requestedLibrary,epoch:requestedEpoch,deviceId,recordId}={}){
      assertLibrary({libraryId:requestedLibrary,epoch:requestedEpoch});validateDevice(deviceId);
      if(typeof recordId!=='string'||recordId.length<1||recordId.length>100)fail('VALIDATION_ERROR');
      return db.transaction(()=>{
        const raw=db.prepare('SELECT revision,deleted FROM records WHERE id=?').get(recordId);if(!raw)fail('DEPENDENCY_MISSING',{recordId});
        const version=db.prepare('SELECT * FROM versions WHERE record=? ORDER BY revision DESC LIMIT 1').get(recordId);
        if(!version)fail('VALIDATION_ERROR',{field:'versionHistory'});
        const change=db.prepare('SELECT seq,change_id FROM sync_changes WHERE record_id=? ORDER BY seq DESC LIMIT 1').get(recordId);
        const head={recordId,revision:raw.revision,versionId:version.id,changeId:change?.change_id??null,deleted:Boolean(raw.deleted)};
        return {head,record:syncRecord(recordId),version:{id:version.id,recordId,revision:version.revision,markdown:markdownSource(parse(version.doc)),doc:parse(version.doc),...relation(recordId),...journalInput(version.id),parentVersionIds:parse(db.prepare('SELECT parents FROM sync_version_parents WHERE version_id=?').get(version.id)?.parents??'[]'),title:version.title,createdAt:version.at,reason:version.reason},seq:change?.seq??0};
      })();
    },
    push({libraryId:requestedLibrary,epoch:requestedEpoch,deviceId,operations}={}){
      assertLibrary({libraryId:requestedLibrary,epoch:requestedEpoch});validateDevice(deviceId);
      if(!Array.isArray(operations)||operations.length<1||operations.length>limits.maxBatchOperations)fail('VALIDATION_ERROR');
      const receipts=[];
      for(const item of operations){
        const op=item?.inlineBody;
        if(!op) { receipts.push({operationId:item?.operationId,status:'blocked-dependency',code:'DEPENDENCY_MISSING'});continue; }
        let parsed,requestHash;
        try{parsed=parseOperation(op);requestHash=fingerprint(parsed);}catch(error){receipts.push({operationId:op.operationId,status:'rejected',code:error.code??'VALIDATION_ERROR',details:error.details});continue;}
        const receipt=db.transaction(()=>{
          const oldReceipt=db.prepare('SELECT * FROM sync_receipts WHERE operation_id=?').get(parsed.operationId);
          if(oldReceipt){if(oldReceipt.epoch!==epoch())fail('RECONCILIATION_REQUIRED');if(oldReceipt.device_id!==deviceId||oldReceipt.fingerprint!==requestHash)fail('OPERATION_REUSED');return parse(oldReceipt.result);}
          const priorChange=db.prepare('SELECT seq,record_id,version_id,revision,payload,operation_fingerprint FROM sync_changes WHERE change_id=?').get(parsed.changeId),businessHash=businessFingerprint(parsed);
          if(priorChange){if(!priorChange.operation_fingerprint||priorChange.operation_fingerprint!==businessHash)fail('OPERATION_REUSED',{changeId:parsed.changeId});const mapped={operationId:parsed.operationId,status:'applied',recordId:priorChange.record_id,changeId:parsed.changeId,versionId:priorChange.version_id,revision:priorChange.revision,seq:priorChange.seq,duplicateChange:true,...mappedJournalProof(parsed,priorChange),...(get(priorChange.record_id)?.kind==='ai_annotation'?{currentRecord:syncRecord(priorChange.record_id)}:{})};db.prepare('INSERT INTO sync_receipts(operation_id,device_id,fingerprint,status,result,created_at,epoch) VALUES(?,?,?,?,?,?,?)').run(parsed.operationId,deviceId,requestHash,'applied',JSON.stringify(mapped),now(),epoch());return mapped;}
          const journalDay=parsed.payload.kind==='journal'?(parsed.payload.contentDay??dateKey(parsed.occurredAt,parsed.timeZone)):null;
          const dailyRow=journalDay?journalForDay(journalDay):null,daily=dailyRow?syncRecord(dailyRow.id):null;
          const senderBase=parsed.baseVersionId&&db.prepare('SELECT payload FROM sync_journal_inputs WHERE version_id=?').get(parsed.baseVersionId);
          const baseVersion=parsed.baseVersionId&&db.prepare('SELECT doc FROM versions WHERE id=? AND record=?').get(parsed.baseVersionId,parsed.recordId);
          const acceptedBase=parsed.baseVersionId&&db.prepare('SELECT payload FROM sync_changes WHERE version_id=? AND record_id=? ORDER BY seq DESC LIMIT 1').get(parsed.baseVersionId,daily?.id??parsed.recordId);
          const baseCandidates=[senderBase?parse(senderBase.payload):null,acceptedBase?parse(acceptedBase.payload):null].filter(Boolean);
          const baseSnapshot=baseCandidates.filter(value=>parsed.payload.markdown.startsWith(value.markdown+'\n\n')).sort((a,b)=>b.markdown.length-a.markdown.length)[0];
          const baseMarkdown=baseSnapshot?.markdown??(baseVersion?markdownSource(parse(baseVersion.doc)):null);
          const appendOffset=parsed.action==='create'?0:parsed.action==='update'&&baseMarkdown!==null&&parsed.payload.markdown.startsWith(baseMarkdown+'\n\n')?baseMarkdown.length+2:null;
          const unchangedMetadata=parsed.action==='create'||daily&&['title','origin','processing','url','annotation','stage','contentDay'].every(key=>parsed.payload[key]===(baseSnapshot??daily)[key]);
          if(journalDay&&appendOffset!==null&&unchangedMetadata){
            if(parsed.action==='create'&&(parsed.baseRevision!==null||parsed.baseVersionId!==null||parsed.parentVersionIds.length))fail('VALIDATION_ERROR',{field:'baseVersionId'});
            if(parsed.action==='update'&&!daily)fail('REVISION_CONFLICT',{field:'journalDay'});
            const delta=parsed.payload.markdown.slice(appendOffset);if(!delta.trim())fail('VALIDATION_ERROR',{field:'markdown'});
            let offset=0;const sources=parsed.payload.sources.flatMap(segment=>{const start=offset;offset+=segment.text.length;const text=segment.text.slice(Math.max(0,appendOffset-start));return text?[{...segment,text}]:[];});
            const targetId=daily?.id??parsed.recordId;
            if(senderBase&&db.prepare('SELECT record_id FROM sync_journal_inputs WHERE version_id=?').get(parsed.baseVersionId).record_id!==targetId)fail('VALIDATION_ERROR',{field:'baseVersionId'});
            if(!daily&&get(targetId))fail('REVISION_CONFLICT',{field:'recordId'});
            if(parsed.payload.sourceIds.length)fail('VALIDATION_ERROR',{field:'sourceIds'});
            const finalActivity=parsed.activities.at(-1);
            if(finalActivity&&(finalActivity.afterSegments.map(segment=>segment.text).join('')!==parsed.payload.markdown||finalActivity.afterHash!==contentHash(parsed.payload.markdown,finalActivity.afterSegments)))fail('VALIDATION_ERROR',{field:'activity.afterHash'});
            if(parsed.activities.some(activity=>activity.afterHash!==contentHash(activity.afterSegments.map(segment=>segment.text).join(''),activity.afterSegments)))fail('VALIDATION_ERROR',{field:'activity.afterHash'});
            const blobs=[];
            for(const descriptor of parsed.payload.attachmentDescriptors){
              const existing=db.prepare('SELECT data,record,name FROM attachments WHERE id=?').get(descriptor.id);
              if(existing){const bytes=Buffer.from(existing.data,'base64');if(existing.record!==targetId||hash(bytes)!==descriptor.hash||bytes.length!==descriptor.byteLength||existing.name!==descriptor.name)fail('VALIDATION_ERROR',{field:'attachmentDescriptors'});continue;}
              const staged=db.prepare('SELECT * FROM sync_staged_blobs WHERE owner_id=? AND device_id=? AND attachment_id=?').get(ownerId,deviceId,descriptor.id);
              if(!staged)return {operationId:parsed.operationId,status:'blocked-dependency',code:'DEPENDENCY_MISSING',missingAttachmentIds:[descriptor.id]};
              if(![parsed.recordId,targetId].includes(staged.record_id)||staged.digest!==descriptor.hash||staged.byte_length!==descriptor.byteLength||staged.name!==descriptor.name||hash(Buffer.from(staged.data))!==descriptor.hash)fail('VALIDATION_ERROR',{field:'attachmentDescriptors'});
              blobs.push(staged);
            }
            let mergedVersionId=parsed.versionId,mergeParents;
            if(daily){const previous=db.prepare('SELECT id FROM versions WHERE record=? ORDER BY revision DESC LIMIT 1').get(targetId);if(db.prepare('SELECT 1 FROM versions WHERE id=?').get(parsed.versionId))fail('OPERATION_REUSED',{versionId:parsed.versionId});for(const parent of parsed.parentVersionIds)if(!db.prepare('SELECT 1 FROM versions WHERE id=? AND record=?').get(parent,targetId))fail('DEPENDENCY_MISSING',{versionId:parent});const sourceDoc=docFromSources(parsed.payload.sources),sourceRevision=dailyRow.revision+1;db.prepare('INSERT INTO versions VALUES(?,?,?,?,?,?,?)').run(parsed.versionId,targetId,sourceRevision,JSON.stringify(sourceDoc),parsed.payload.title,parsed.occurredAt,'同步日记原始版本');db.prepare('INSERT INTO sync_version_sources VALUES(?,?,?)').run(parsed.versionId,parsed.payload.markdown,JSON.stringify(parsed.payload.sources));db.prepare('INSERT INTO sync_version_parents VALUES(?,?)').run(parsed.versionId,JSON.stringify(parsed.parentVersionIds));db.prepare('UPDATE records SET revision=? WHERE id=?').run(sourceRevision,targetId);mergedVersionId=randomUUID();mergeParents=[...new Set([previous?.id,parsed.versionId].filter(Boolean))];}
            const saved=save({...(daily?{}:{id:targetId}),kind:'journal',day:journalDay,title:parsed.payload.title,doc:docFromSources(sources),origin:parsed.payload.origin,reason:'同步日记追加'},
              {inTransaction:true,archive:true,sync:false,allowCreateWithId:!daily,versionId:mergedVersionId,parentVersionIds:mergeParents,beforeSync:()=>{for(const blob of blobs){db.prepare('INSERT INTO attachments VALUES(?,?,?,?,?)').run(blob.attachment_id,targetId,blob.name,Buffer.from(blob.data).toString('base64'),now());db.prepare('DELETE FROM sync_staged_blobs WHERE owner_id=? AND device_id=? AND attachment_id=?').run(ownerId,deviceId,blob.attachment_id);}}});
            if(!daily){db.prepare('UPDATE records SET processing=?,created=?,updated=?,created_by_device=?,url=?,annotation=?,stage=? WHERE id=?').run(parsed.payload.processing,parsed.payload.createdAt,parsed.payload.updatedAt,parsed.payload.createdByDevice,parsed.payload.url,parsed.payload.annotation,parsed.payload.stage,targetId);db.prepare('UPDATE record_dates SET basis=? WHERE record=?').run(parsed.payload.dateBasis,targetId);}
            const merged=syncRecord(targetId,{preserveSources:false});
            const activities=parsed.activities.map(activity=>({...activity,recordId:targetId}));
            const change=appendSyncChange(targetId,daily?'update':'create',{changeId:parsed.changeId,versionId:mergedVersionId,operationFingerprint:businessHash,activities,createActivity:false});
            projectActivitiesToEdits(targetId,activities,baseSnapshot?.sources??[]);
            db.prepare('INSERT INTO sync_journal_inputs VALUES(?,?,?)').run(parsed.versionId,targetId,JSON.stringify(parsed.payload));if(mergedVersionId!==parsed.versionId)db.prepare('INSERT INTO sync_journal_inputs VALUES(?,?,?)').run(mergedVersionId,targetId,JSON.stringify(parsed.payload));
            const version=db.prepare('SELECT * FROM versions WHERE id=?').get(mergedVersionId);
            const result={operationId:parsed.operationId,status:'applied',recordId:targetId,changeId:parsed.changeId,versionId:mergedVersionId,revision:saved.revision,seq:change.seq,journalMerged:true,inputVersionId:parsed.versionId,inputVersionRevision:daily?dailyRow.revision+1:saved.revision,currentRecord:merged,
              currentVersion:{id:version.id,recordId:targetId,revision:version.revision,markdown:merged.markdown,doc:parse(version.doc),...journalInput(version.id),sources:merged.sources,parentVersionIds:parse(db.prepare('SELECT parents FROM sync_version_parents WHERE version_id=?').get(version.id).parents),title:version.title,createdAt:version.at,reason:version.reason}};
            db.prepare('INSERT INTO sync_receipts(operation_id,device_id,fingerprint,status,result,created_at,epoch) VALUES(?,?,?,?,?,?,?)').run(parsed.operationId,deviceId,requestHash,'applied',JSON.stringify(result),now(),epoch());return result;
          }
          if(daily&&daily.id!==parsed.recordId)fail('REVISION_CONFLICT',{field:'journalDay',recordId:daily.id});
          const current=get(parsed.recordId),head=current&&db.prepare('SELECT id,revision FROM versions WHERE record=? ORDER BY revision DESC LIMIT 1').get(parsed.recordId);
          if(parsed.action==='create'?(!!current||parsed.baseRevision!==null||parsed.baseVersionId!==null):(!current||current.revision!==parsed.baseRevision||head?.id!==parsed.baseVersionId)){
            const currentVersion=head&&db.prepare('SELECT * FROM versions WHERE id=?').get(head.id);
            const conflict={operationId:parsed.operationId,status:'conflict',recordId:parsed.recordId,currentRevision:current?.revision??null,currentVersionId:head?.id??null,
              currentHead:current?{recordId:parsed.recordId,revision:current.revision,versionId:head?.id??null,changeId:db.prepare('SELECT change_id FROM sync_changes WHERE record_id=? ORDER BY seq DESC LIMIT 1').get(parsed.recordId)?.change_id??null,deleted:Boolean(current.deleted)}:null,
              currentRecord:current?syncRecord(parsed.recordId):null,
              currentVersion:currentVersion?{id:currentVersion.id,recordId:parsed.recordId,revision:currentVersion.revision,markdown:markdownSource(parse(currentVersion.doc)),doc:parse(currentVersion.doc),...relation(parsed.recordId),...journalInput(currentVersion.id),parentVersionIds:parse(db.prepare('SELECT parents FROM sync_version_parents WHERE version_id=?').get(currentVersion.id)?.parents??'[]'),title:currentVersion.title,createdAt:currentVersion.at,reason:currentVersion.reason}:null};
            db.prepare('INSERT INTO sync_receipts(operation_id,device_id,fingerprint,status,result,created_at,epoch) VALUES(?,?,?,?,?,?,?)').run(parsed.operationId,deviceId,requestHash,'conflict',JSON.stringify(conflict),now(),epoch());return conflict;
          }
          if(parsed.payload.kind==='ai_annotation'){const anchor=parsed.payload.annotationOf,version=db.prepare('SELECT record FROM versions WHERE id=?').get(anchor.versionId);if(version&&version.record!==anchor.recordId){const input=db.prepare('SELECT record_id,payload FROM sync_journal_inputs WHERE version_id=?').get(anchor.versionId);if(input&&input.record_id===version.record&&parse(input.payload).id===anchor.recordId)parsed.payload.annotationOf={...anchor,recordId:version.record};}}
          if(current && (current.kind==='ai_annotation'||parsed.payload.kind==='ai_annotation') && (current.kind!==parsed.payload.kind||JSON.stringify(current.annotationOf)!==JSON.stringify(parsed.payload.annotationOf)))fail('VALIDATION_ERROR',{field:'annotationOf'});
          if(parsed.payload.kind==='ai_annotation'){const anchor=parsed.payload.annotationOf,parent=get(anchor.recordId),version=db.prepare('SELECT doc,record FROM versions WHERE id=?').get(anchor.versionId);if(!parent||!version)return {operationId:parsed.operationId,status:'blocked-dependency',code:'DEPENDENCY_MISSING',missingRecordIds:parent?[]:[anchor.recordId],missingVersionIds:version?[]:[anchor.versionId]};if(parent.kind==='ai_annotation'||version.record!==parent.id||hash(markdownSource(parse(version.doc)))!==anchor.contentHash)fail('VALIDATION_ERROR',{field:'annotationOf'});}
          if(parsed.action==='create'&&parsed.payload.sourceIds.some(id=>!get(id)))return {operationId:parsed.operationId,status:'blocked-dependency',code:'DEPENDENCY_MISSING',missingRecordIds:parsed.payload.sourceIds.filter(id=>!get(id))};
          if(parsed.payload.sourceIds.some(id=>{const source=get(id);return !source||['article','ai_annotation'].includes(source.kind);}))fail('VALIDATION_ERROR',{field:'sourceIds'});
          const missingAttachments=[];
          for(const descriptor of parsed.payload.attachmentDescriptors){const existing=db.prepare('SELECT data,record,name FROM attachments WHERE id=?').get(descriptor.id);if(existing){const bytes=Buffer.from(existing.data,'base64');if(existing.record!==parsed.recordId||hash(bytes)!==descriptor.hash||bytes.length!==descriptor.byteLength||existing.name!==descriptor.name)fail('VALIDATION_ERROR',{field:'attachmentDescriptors',attachmentId:descriptor.id});continue;}
            const staged=db.prepare('SELECT record_id,name,digest,byte_length,data FROM sync_staged_blobs WHERE owner_id=? AND device_id=? AND attachment_id=?').get(ownerId,deviceId,descriptor.id);
            if(!staged){missingAttachments.push(descriptor.id);continue;}const bytes=Buffer.from(staged.data);if(staged.record_id!==parsed.recordId||staged.name!==descriptor.name||staged.digest!==descriptor.hash||staged.byte_length!==descriptor.byteLength||hash(bytes)!==descriptor.hash)fail('VALIDATION_ERROR',{field:'attachmentDescriptors',attachmentId:descriptor.id});}
          if(missingAttachments.length)return {operationId:parsed.operationId,status:'blocked-dependency',code:'DEPENDENCY_MISSING',missingAttachmentIds:missingAttachments};
          const finalActivity=parsed.activities.at(-1);
          if(parsed.action==='create'&&parsed.parentVersionIds.length||parsed.action!=='create'&&!parsed.parentVersionIds.includes(parsed.baseVersionId))fail('VALIDATION_ERROR',{field:'parentVersionIds'});
          const missingParents=[],invalidParents=[];for(const parentId of parsed.parentVersionIds){const parent=db.prepare('SELECT record FROM versions WHERE id=?').get(parentId);if(!parent)missingParents.push(parentId);else if(parent.record!==parsed.recordId)invalidParents.push(parentId);}
          if(missingParents.length)return {operationId:parsed.operationId,status:'blocked-dependency',code:'DEPENDENCY_MISSING',missingVersionIds:missingParents};
          if(invalidParents.length)fail('VALIDATION_ERROR',{field:'parentVersionIds',versionIds:invalidParents});
          if(finalActivity&&(finalActivity.afterSegments.map(segment=>segment.text).join('')!==parsed.payload.markdown||finalActivity.afterHash!==contentHash(parsed.payload.markdown,finalActivity.afterSegments)))fail('VALIDATION_ERROR',{field:'activity.afterHash'});
          if(parsed.activities.some(activity=>activity.afterHash!==contentHash(activity.afterSegments.map(segment=>segment.text).join(''),activity.afterSegments)))fail('VALIDATION_ERROR',{field:'activity.afterHash'});
          const doc=docFromSources(parsed.payload.sources), input={id:parsed.recordId,revision:current?.revision,kind:parsed.payload.kind,day:journalDay,title:parsed.payload.title,doc,url:parsed.payload.url,annotation:parsed.payload.annotation,stage:parsed.payload.stage,sourceIds:parsed.payload.kind==='article'?parsed.payload.sourceIds:undefined,origin:parsed.payload.origin,reason:`Mobile sync ${parsed.action}`};
          if(['restore','restore-and-update'].includes(parsed.action)&&current?.deleted)db.prepare('UPDATE records SET deleted=0 WHERE id=?').run(parsed.recordId);
          const saved=save(input,{archive:true,sync:false,versionId:parsed.versionId,changeId:parsed.changeId,allowCreateWithId:parsed.action==='create',allowKindChange:true,allowAnnotation:parsed.payload.kind==='ai_annotation',parentVersionIds:parsed.parentVersionIds,
            beforeSync:()=>{if(parsed.action==='create'&&parsed.payload.kind==='ai_annotation'){const a=parsed.payload.annotationOf;db.prepare('INSERT INTO annotation_relations VALUES(?,?,?,?)').run(parsed.recordId,a.recordId,a.versionId,a.contentHash);}for(const descriptor of parsed.payload.attachmentDescriptors){if(db.prepare('SELECT 1 FROM attachments WHERE id=?').get(descriptor.id))continue;const staged=db.prepare('SELECT * FROM sync_staged_blobs WHERE owner_id=? AND device_id=? AND attachment_id=?').get(ownerId,deviceId,descriptor.id);if(!staged)fail('DEPENDENCY_MISSING',{attachmentId:descriptor.id});db.prepare('INSERT INTO attachments VALUES(?,?,?,?,?)').run(descriptor.id,parsed.recordId,descriptor.name,Buffer.from(staged.data).toString('base64'),parsed.payload.createdAt);db.prepare('DELETE FROM sync_staged_blobs WHERE owner_id=? AND device_id=? AND attachment_id=?').run(ownerId,deviceId,descriptor.id);}}});
          db.prepare('UPDATE records SET origin=?,deleted=?,processing=?,created=?,updated=?,created_by_device=? WHERE id=?').run(parsed.payload.origin,parsed.action==='delete'?1:0,parsed.payload.processing,parsed.payload.createdAt,parsed.payload.updatedAt,parsed.payload.createdByDevice,parsed.recordId);
          const existingImport=db.prepare('SELECT 1 FROM imports WHERE record=?').get(parsed.recordId);
          if(existingImport)db.prepare('UPDATE imports SET day=?,date_basis=? WHERE record=?').run(parsed.payload.contentDay,parsed.payload.dateBasis,parsed.recordId);
          else db.prepare('INSERT INTO record_dates(record,day,basis) VALUES(?,?,?) ON CONFLICT(record) DO UPDATE SET day=excluded.day,basis=excluded.basis').run(parsed.recordId,parsed.payload.contentDay,parsed.payload.dateBasis);
          db.prepare('INSERT INTO sync_record_sources VALUES(?,?,?,?) ON CONFLICT(record_id) DO UPDATE SET markdown=excluded.markdown,sources=excluded.sources,updated_at=excluded.updated_at').run(parsed.recordId,parsed.payload.markdown,JSON.stringify(parsed.payload.sources),now());
          db.prepare('INSERT INTO sync_version_sources VALUES(?,?,?) ON CONFLICT(version_id) DO UPDATE SET markdown=excluded.markdown,sources=excluded.sources').run(parsed.versionId,parsed.payload.markdown,JSON.stringify(parsed.payload.sources));
          const change=appendSyncChange(parsed.recordId,parsed.action,{changeId:parsed.changeId,versionId:parsed.versionId,operationFingerprint:businessHash,activities:parsed.activities,createActivity:false,preserveSources:true});
          const persistedActivities=db.prepare('SELECT activity_id,occurred_at,after_segments,action FROM sync_activities WHERE change_id=? ORDER BY occurred_at,activity_id').all(parsed.changeId).map(row=>({activityId:row.activity_id,occurredAt:row.occurred_at,afterSegments:parse(row.after_segments),action:row.action}));
          projectActivitiesToEdits(parsed.recordId,persistedActivities,current?.sources??[]);
          const result={operationId:parsed.operationId,status:'applied',recordId:parsed.recordId,changeId:parsed.changeId,versionId:parsed.versionId,revision:saved.revision,seq:change.seq,...(parsed.payload.kind==='ai_annotation'?{currentRecord:syncRecord(parsed.recordId)}:{})};
          db.prepare('INSERT INTO sync_receipts(operation_id,device_id,fingerprint,status,result,created_at,epoch) VALUES(?,?,?,?,?,?,?)').run(parsed.operationId,deviceId,requestHash,'applied',JSON.stringify(result),now(),epoch());
          return result;
        })();
        receipts.push(receipt);
      }
      return {receipts};
    },
    receipts({libraryId:requestedLibrary,epoch:requestedEpoch,deviceId,operationIds}={}){
      assertLibrary({libraryId:requestedLibrary,epoch:requestedEpoch});validateDevice(deviceId);
      if(!Array.isArray(operationIds)||operationIds.length<1||operationIds.length>limits.maxBatchOperations||operationIds.some(x=>!validUuid(x)))fail('VALIDATION_ERROR');
      return {receipts:operationIds.map(operationId=>{const row=db.prepare('SELECT result FROM sync_receipts WHERE operation_id=? AND device_id=? AND epoch=?').get(operationId,deviceId,epoch());return row?parse(row.result):{operationId,status:'unknown'};})};
    },
    ack({libraryId:requestedLibrary,epoch:requestedEpoch,deviceId,appliedCursor,completeCursor,manifestDigest}={}){
      assertLibrary({libraryId:requestedLibrary,epoch:requestedEpoch});validateDevice(deviceId);
      if(!integer(appliedCursor)||!integer(completeCursor)||completeCursor>appliedCursor||appliedCursor>currentCursor()||typeof manifestDigest!=='string'||!/^[a-f0-9]{64}$/.test(manifestDigest))fail('VALIDATION_ERROR');
      const manifest=db.prepare('SELECT high_watermark FROM sync_manifests WHERE digest=? AND epoch=?').get(manifestDigest,epoch());
      if(!manifest||completeCursor<manifest.high_watermark)fail('MANIFEST_MISMATCH');
      const at=now();db.prepare(`INSERT INTO sync_acks VALUES(?,?,?,?,?) ON CONFLICT(device_id) DO UPDATE SET applied_cursor=excluded.applied_cursor,complete_cursor=excluded.complete_cursor,manifest_digest=excluded.manifest_digest,acknowledged_at=excluded.acknowledged_at`).run(deviceId,appliedCursor,completeCursor,manifestDigest,at);
      return {appliedCursor,completeCursor,acknowledgedAt:at};
    },
    progress(){return db.prepare('SELECT device_id AS deviceId,applied_cursor AS appliedCursor,complete_cursor AS completeCursor,manifest_digest AS manifestDigest,acknowledged_at AS acknowledgedAt FROM sync_acks ORDER BY acknowledged_at DESC').all();},
    putAttachment({libraryId:requestedLibrary,epoch:requestedEpoch,deviceId,recordId,attachmentId,name,bytes,digest,stageOnly=false}={}){
      assertLibrary({libraryId:requestedLibrary,epoch:requestedEpoch});validateDevice(deviceId);
      if(!validUuid(attachmentId)||typeof recordId!=='string'||typeof name!=='string'||name.length>500||!Buffer.isBuffer(bytes)||bytes.length>limits.maxCanonicalOperationBytes||hash(bytes)!==digest)fail('VALIDATION_ERROR');
      return db.transaction(()=>{
        const record=get(recordId);
        if(!record || stageOnly){
          if(record?.deleted)fail('DEPENDENCY_MISSING',{recordId});
          const existing=db.prepare('SELECT record,name,data FROM attachments WHERE id=?').get(attachmentId);
          if(existing){if(existing.record!==recordId||existing.name!==name||hash(Buffer.from(existing.data,'base64'))!==digest)fail('OPERATION_REUSED');return {attachmentId,recordId,digest,byteLength:bytes.length,alreadyPresent:true,staged:false};}
          db.prepare("DELETE FROM sync_staged_blobs WHERE created_at<?").run(new Date(Date.now()-7*24*60*60*1000).toISOString());
          const old=db.prepare('SELECT record_id,name,digest,byte_length,data FROM sync_staged_blobs WHERE owner_id=? AND device_id=? AND attachment_id=?').get(ownerId,deviceId,attachmentId);
          if(old){if(old.record_id!==recordId||old.name!==name||old.digest!==digest||old.byte_length!==bytes.length||!Buffer.from(old.data).equals(bytes))fail('OPERATION_REUSED');return {attachmentId,recordId,digest,byteLength:bytes.length,alreadyPresent:true,staged:true};}
          db.prepare('INSERT INTO sync_staged_blobs VALUES(?,?,?,?,?,?,?,?,?)').run(ownerId,deviceId,attachmentId,recordId,name,digest,bytes.length,bytes,now());
          return {attachmentId,recordId,digest,byteLength:bytes.length,alreadyPresent:false,staged:true};
        }
        if(record.deleted)fail('DEPENDENCY_MISSING',{recordId});
        const old=db.prepare('SELECT record,name,data FROM attachments WHERE id=?').get(attachmentId);
        if(old){if(old.record!==recordId||old.name!==name||hash(Buffer.from(old.data,'base64'))!==digest)fail('OPERATION_REUSED');return {attachmentId,recordId,digest,byteLength:bytes.length,alreadyPresent:true};}
        db.prepare('INSERT INTO attachments VALUES(?,?,?,?,?)').run(attachmentId,recordId,name,bytes.toString('base64'),now());
        bumpSyncRevision(recordId,'移动端同步附件');
        const change=appendSyncChange(recordId,'update',{createActivity:false});
        return {attachmentId,recordId,digest,byteLength:bytes.length,alreadyPresent:false,revision:get(recordId).revision,seq:change.seq};
      })();
    },
    attachmentChunk({libraryId:requestedLibrary,epoch:requestedEpoch,deviceId,attachmentId,branchId=null,offset=0,byteLength=limits.maxPartBytes}={}){
      assertLibrary({libraryId:requestedLibrary,epoch:requestedEpoch});validateDevice(deviceId);
      if(typeof attachmentId!=='string'||branchId!==null&&typeof branchId!=='string'||!integer(offset)||!integer(byteLength,1,limits.maxPartBytes))fail('VALIDATION_ERROR');
      let row,bytes,createdAt;
      if(branchId!==null){
        const branch=db.prepare('SELECT record_id,payload,created_at FROM sync_branches WHERE branch_id=?').get(branchId);
        const blob=db.prepare('SELECT attachment_id,name,digest,byte_length,data FROM sync_branch_blobs WHERE branch_id=? AND attachment_id=?').get(branchId,attachmentId);
        if(!branch||!blob)fail('DEPENDENCY_MISSING',{attachmentId,branchId});
        row={id:blob.attachment_id,record:branch.record_id,name:blob.name};bytes=Buffer.from(blob.data);createdAt=parse(branch.payload).createdAt??branch.created_at;
        if(hash(bytes)!==blob.digest||bytes.length!==blob.byte_length)fail('ATTACHMENT_INTEGRITY_ERROR',{attachmentId,branchId});
      }else{
        row=db.prepare('SELECT id,record,name,data,created FROM attachments WHERE id=?').get(attachmentId);if(!row)fail('DEPENDENCY_MISSING',{attachmentId});
        bytes=Buffer.from(row.data,'base64');createdAt=row.created;
      }
      if(offset>bytes.length)fail('VALIDATION_ERROR');const end=Math.min(bytes.length,offset+byteLength),chunk=bytes.subarray(offset,end);
      return {attachmentId:row.id,...(branchId!==null?{branchId}:{}),recordId:row.record,name:row.name,createdAt,totalBytes:bytes.length,digest:hash(bytes),offset,nextOffset:end<bytes.length?end:null,complete:end===bytes.length,dataBase64:chunk.toString('base64')};
    },
  };
}
