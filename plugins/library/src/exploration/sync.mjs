import {randomUUID} from 'node:crypto';
import {hash} from '../assist/evidence.mjs';
import {fingerprint} from '../sync/canonical.mjs';

const keys={
 exploration_questions:['id'],exploration_evidence:['question','anchor'],exploration_discoveries:['id'],
 exploration_reviews:['id'],exploration_responses:['question','record'],exploration_periods:['period','period_key'],
 exploration_aliases:['child'],exploration_pairs:['left_id','right_id','basis'],exploration_decisions:['id']
};
const identityKey=r=>JSON.stringify([r.libraryId,r.serverId,r.epoch,r.deviceId]);
const requireId=id=>{if(typeof id!=='string'||!id.length||id.length>180)throw Error('INVALID_EXPLORATION_ID');return id;};
export function createExplorationSync(db,api,call,canonical){
 const get=(sql,...a)=>db.prepare(sql).get(...a),all=(sql,...a)=>db.prepare(sql).all(...a),run=(sql,...a)=>db.prepare(sql).run(...a);
 const tx=fn=>db.transaction(fn)();
 const highest=()=>get('SELECT COALESCE(MAX(seq),0) n FROM exploration_stream').n;
 tx(()=>{
  db.exec(`CREATE TABLE IF NOT EXISTS exploration_stream(seq INTEGER PRIMARY KEY AUTOINCREMENT,entity TEXT NOT NULL,k TEXT NOT NULL,value TEXT);
   CREATE TABLE IF NOT EXISTS exploration_devices(binding TEXT PRIMARY KEY,coverage TEXT NOT NULL,ack INTEGER NOT NULL DEFAULT 0);
   CREATE TABLE IF NOT EXISTS exploration_operations(binding TEXT NOT NULL,channel TEXT NOT NULL,op TEXT NOT NULL,fingerprint TEXT NOT NULL,result TEXT,
    PRIMARY KEY(binding,channel,op));
   CREATE TABLE IF NOT EXISTS exploration_snapshots(id TEXT PRIMARY KEY,binding TEXT NOT NULL,high INTEGER NOT NULL,count INTEGER NOT NULL,digest TEXT NOT NULL,expires INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS exploration_pages(snapshot TEXT NOT NULL,offset INTEGER NOT NULL,items TEXT NOT NULL,PRIMARY KEY(snapshot,offset));`);
  for(const [entity,pk] of Object.entries(keys)){
   const columns=all('PRAGMA table_info('+entity+')').map(r=>r.name);
   for(const action of ['INSERT','UPDATE','DELETE']){
    const ref=action==='DELETE'?'OLD':'NEW',key='json_array('+pk.map(k=>ref+'.'+k).join(',')+')';
    const value=action==='DELETE'?'NULL':'json_object('+columns.map(k=>"'"+k+"',NEW."+k).join(',')+')';
    db.exec(`CREATE TRIGGER IF NOT EXISTS stream_${entity}_${action} AFTER ${action} ON ${entity} BEGIN
      INSERT INTO exploration_stream(entity,k,value) VALUES('${entity}',${key},${value}); END;`);
   }
  }
  // The assist store is installed after exploration in createStore. Settings changes
  // publish the projection explicitly from its write transaction.
  db.exec(`CREATE TRIGGER IF NOT EXISTS exploration_stream_source AFTER UPDATE OF deleted,revision ON records
   WHEN (NEW.revision<>OLD.revision OR NEW.deleted<>OLD.deleted) AND EXISTS(SELECT 1 FROM exploration_evidence WHERE record=NEW.id OR json_extract(source,'$.annotationId')=NEW.id)
   BEGIN INSERT INTO exploration_stream(entity,k,value) VALUES('source_state',json_array(NEW.id),json_object('id',NEW.id,'revision',NEW.revision,'deleted',NEW.deleted)); END;`);
 });
 function session(r,negotiate=false){
  const id=api.themeContext().libraryId;
  const meta=key=>get('SELECT value FROM meta WHERE key=?',key)?.value;
  if(r.libraryId!==id||r.epoch!==meta('sync_epoch')||r.serverId!==(meta('sync_server_id')??id))throw Error('EXPLORATION_BINDING_CHANGED');
  requireId(r.deviceId);const binding=identityKey(r);
  if(negotiate)run('INSERT OR IGNORE INTO exploration_devices(binding,coverage) VALUES(?,?)',binding,randomUUID());
  const d=get('SELECT * FROM exploration_devices WHERE binding=?',binding);
  if(!d||!negotiate&&r.coverage!==d.coverage)throw Error('EXPLORATION_COVERAGE_REQUIRED');
  return d;
 }
 function snapshot(d){
  const settings=api.assist.call('shiwen_recommendation_settings',{});
  const today=api.assist.call('shiwen_recommendation_list',{view:'today'});
  const items=[{entity:'settings',key:['settings'],value:settings},{entity:'legacy_updates',key:['today'],value:{day:today.day,count:today.todayCount}}];
  for(const [entity,pk] of Object.entries(keys)){
   for(const row of all('SELECT * FROM '+entity+' ORDER BY '+pk.join(',')))items.push({entity,key:pk.map(k=>row[k]),value:{...row}});
  }
  for(const s of all(`SELECT id,revision,deleted FROM records WHERE id IN (SELECT record FROM exploration_evidence UNION SELECT json_extract(source,'$.annotationId') FROM exploration_evidence)`))items.push({entity:'source_state',key:[s.id],value:{...s}});
  for(const op of all("SELECT channel,op,fingerprint,result FROM exploration_operations WHERE binding=? AND result IS NOT NULL",d.binding))items.push({entity:'operation',key:[op.channel,op.op],value:{fingerprint:op.fingerprint,result:JSON.parse(op.result)}});
  const snapshotId=randomUUID(),highWatermark=highest(),digest=fingerprint(items);
  run('DELETE FROM exploration_pages WHERE snapshot IN (SELECT id FROM exploration_snapshots WHERE expires<?)',Date.now());
  run('DELETE FROM exploration_snapshots WHERE expires<?',Date.now());
  run('INSERT INTO exploration_snapshots VALUES(?,?,?,?,?,?)',snapshotId,d.binding,highWatermark,items.length,digest,Date.now()+900000);
  let start=0,page=[],size=0;
  function flush(){if(page.length)run('INSERT INTO exploration_pages VALUES(?,?,?)',snapshotId,start,JSON.stringify(page));start+=page.length;page=[];size=0;}
  for(const item of items){const n=Buffer.byteLength(JSON.stringify(item));if(page.length&&(size+n>128000||page.length>=80))flush();page.push(item);size+=n;}flush();
  const groups=Object.fromEntries(['settings','legacy_updates',...Object.keys(keys),'source_state','operation'].map(entity=>[entity,[]]));
  for(const item of items)groups[item.entity].push(item);
  const entities=Object.fromEntries(Object.entries(groups).map(([entity,rows])=>[entity,{count:rows.length,digest:fingerprint(rows)}]));
  return {snapshotId,highWatermark,count:items.length,digest,entities};
 }
 function proof(d,r,reserve){
  const op=requireId(r.operationId),fp=requireId(r.fingerprint);
  if(!['record','exploration'].includes(r.channel))throw Error('INVALID_CHANNEL');
  let p=get('SELECT * FROM exploration_operations WHERE binding=? AND channel=? AND op=?',d.binding,r.channel,op);
  if(p&&p.fingerprint!==fp)throw Error('OPERATION_REUSED');
  if(!p?.result&&r.channel==='record'){
   const prior=get('SELECT device_id,epoch,fingerprint,result FROM sync_receipts WHERE operation_id=?',op);
   if(prior){
    if(prior.device_id!==r.deviceId||prior.epoch!==r.epoch)return {status:'unknown'};
    if(prior.fingerprint!==fp)throw Error('OPERATION_REUSED');
    run('INSERT INTO exploration_operations VALUES(?,?,?,?,?) ON CONFLICT(binding,channel,op) DO UPDATE SET result=excluded.result',d.binding,r.channel,op,fp,prior.result);
    p=prior;
   }
  }
  if(!p&&reserve){
   run('INSERT INTO exploration_operations VALUES(?,?,?,?,NULL)',d.binding,r.channel,op,fp);
   p={fingerprint:fp};
  }
  if(!p)return {status:'unknown'};
  const common={operationId:op,fingerprint:fp,coverage:d.coverage,channel:r.channel};
  if(p.result)return {...common,status:'committed',receipt:JSON.parse(p.result)};
  return {...common,status:'not_committed',cut:r.channel==='record'?get('SELECT COALESCE(MAX(seq),0) n FROM sync_changes').n:highest()};
 }
 function intentFingerprint(op){
  const {requestId,questionId,expectedRevision,expectedPlacementRevision,...meaning}=op.args;
  return fingerprint({method:op.method,args:meaning});
 }
 function submit(d,r){
  if(r.channel!=='exploration'||fingerprint(r.operation)!==r.fingerprint)throw Error('FINGERPRINT_MISMATCH');
  const p=proof(d,r,false);if(p.status==='committed')return p.receipt;if(p.status!=='not_committed')throw Error('UNKNOWN_OPERATION');
  const {method,args}=r.operation;
  if(!['shiwen_exploration_review','shiwen_exploration_respond','shiwen_exploration_place','shiwen_exploration_suggest'].includes(method)||args.requestId!==r.operationId||args.expectedLibraryId!==r.libraryId||args.body!==undefined)throw Error('INVALID_OPERATION');
  const actor='bound:'+d.binding;
  let receipt;
  let target=args.questionId?canonical(args.questionId):null;
  if(target && !get('SELECT 1 FROM exploration_questions WHERE id=?',target)){
   // An equivalent question may have been accepted on the desktop while the phone was offline.
   const discovery=all('SELECT item,question FROM exploration_discoveries WHERE actor=?',actor)
    .find(row=>hash(['phone-question',actor,row.item])===args.questionId);
   if(discovery)target=canonical(discovery.question);
  }
  if(method==='shiwen_exploration_respond'&&!api.get(args.responseRecordId))return {status:'blocked-dependency'};
  try{
   let input=args;
   if(method==='shiwen_exploration_respond'){
    const head=call('shiwen_exploration_read',{expectedLibraryId:r.libraryId,questionId:target},actor);
    input={...args,questionId:target,expectedRevision:head.revision};
   }else if(target&&target!==args.questionId)throw Object.assign(Error('原问题已合并'),{code:'target_changed'});
   let result;
   if(method==='shiwen_exploration_review'&&target===args.questionId){
    const head=call('shiwen_exploration_read',{expectedLibraryId:r.libraryId,questionId:target},actor);
    const status={accept:'accepted',skip:'skipped',observe:'observing',answered:'answered',continue:'accepted',rewrite:'accepted'}[args.action];
    if(head.revision!==args.expectedRevision&&status===head.status&&(!args.text||head.text===args.text))result=head;
   }
   result??=call(method,input,actor);
   receipt={status:result.status==='full'?'conflict':'applied',result,seq:highest(),operationId:r.operationId};
   if(method==='shiwen_exploration_suggest'){
    // Use the original discovery target. A later human merge still requires its own conflict decision.
    receipt.questionMappings=result.items.flatMap(item=>{
     if(!item.questionId)return [];
     const provisional=hash(['phone-question',actor,item.externalItemId]);
     const discovery=get('SELECT question FROM exploration_discoveries WHERE actor=? AND item=?',actor,item.externalItemId);
     return discovery && discovery.question!==provisional?[{provisional,question:discovery.question}]:[];
    });
   }
   if(method==='shiwen_exploration_respond')Object.assign(receipt,{originalTarget:args.questionId,target});
   if(result.status==='full')Object.assign(receipt,{code:'placement_full',conflictId:randomUUID(),target});
  }catch(e){
   if(!['target_changed','revision_conflict','question_missing','source_changed'].includes(e.code))throw e;
   receipt={status:'conflict',code:e.code,operationId:r.operationId,conflictId:randomUUID(),target,seq:highest()};
  }
  if(receipt.status==='conflict')receipt.intentFingerprint=intentFingerprint(r.operation);
  if(receipt.status==='conflict'&&target){
   try{const q=call('shiwen_exploration_read',{expectedLibraryId:r.libraryId,questionId:target},actor);
    receipt.targetText=q.text;receipt.targetRevision=q.revision;
   }catch(e){if(e.code!=='question_missing')throw e;}
  }
  run('UPDATE exploration_operations SET result=? WHERE binding=? AND channel=? AND op=?',JSON.stringify(receipt),d.binding,r.channel,r.operationId);
  return receipt;
 }
 function execute(action,r){
  return tx(()=>{
   const d=session(r,action==='explorationCapabilities');
   switch(action){
    case 'explorationCapabilities':return {capability:'explorationSync.v1',coverage:d.coverage};
    case 'explorationBegin':return snapshot(d);
    case 'explorationPage':{
     const s=get('SELECT * FROM exploration_snapshots WHERE binding=? AND id=? AND expires>?',d.binding,r.snapshotId,Date.now());
     if(!s)throw Error('SNAPSHOT_EXPIRED');
     const offset=r.offset??0,chunk=get('SELECT items FROM exploration_pages WHERE snapshot=? AND offset=?',s.id,offset);
     if(!chunk&&offset!==s.count)throw Error('INVALID_OFFSET');
     const items=JSON.parse(chunk?.items??'[]');return {snapshotId:s.id,highWatermark:s.high,items,next:offset+items.length<s.count?offset+items.length:null};
    }
    case 'explorationChanges':{
     if(!Number.isSafeInteger(r.cursor)||r.cursor<0||r.cursor>highest())throw Error('CURSOR_EXPIRED');
     const rows=all('SELECT * FROM exploration_stream WHERE seq>? ORDER BY seq LIMIT 80',r.cursor);
     const events=rows.map(row=>({seq:row.seq,entity:row.entity,key:JSON.parse(row.k),value:JSON.parse(row.value)}));
     return {events,nextCursor:rows.at(-1)?.seq??r.cursor,highWatermark:highest()};
    }
    case 'explorationReserve':return proof(d,r,true);
    case 'explorationProof':return proof(d,r,false);
    case 'explorationSubmit':return submit(d,r);
    case 'explorationResolve':{
     const old=proof(d,{...r,channel:'exploration'},false);
     if(old.status!=='committed'||old.receipt.conflictId!==r.conflictId)throw Error('INVALID_CONFLICT');
     if(old.receipt.resolution)return old.receipt;
     if(r.choice!=='abandon'&&r.choice!=='replace')throw Error('INVALID_RESOLUTION');
     if(r.choice==='replace'){
      const replacement=r.replacement;
      if(!replacement||replacement.operationId===r.operationId||!replacement.operation?.args?.questionId)throw Error('INVALID_RESOLUTION');
      if(intentFingerprint(replacement.operation)!==old.receipt.intentFingerprint)throw Error('INVALID_RESOLUTION');
      if(old.receipt.target&&replacement.operation.args.questionId!==old.receipt.target&&old.receipt.code!=='question_missing')throw Error('INVALID_RESOLUTION');
      const sub={...r,...replacement,channel:'exploration'};proof(d,sub,true);
      const result=submit(d,sub);if(result.status!=='applied')throw Error('RESOLUTION_STALE');
     }
     const receipt={...old.receipt,resolution:r.choice,...(r.replacement?{replacementId:r.replacement.operationId}:{}),status:'resolved'};
     run('UPDATE exploration_operations SET result=? WHERE binding=? AND channel=? AND op=?',JSON.stringify(receipt),d.binding,'exploration',r.operationId);
     return receipt;
    }
    case 'explorationAck':if(!Number.isSafeInteger(r.cursor)||r.cursor<0||r.cursor>highest())throw Error('INVALID_CURSOR');
     run('UPDATE exploration_devices SET ack=MAX(ack,?) WHERE binding=?',r.cursor,d.binding);return {cursor:r.cursor};
    default:throw Error('UNKNOWN_EXPLORATION_ACTION');
   }
  });
 }
 function recordPush(deviceId,epoch,operations,fn){
  return tx(()=>{
   const sessionRow=get("SELECT binding FROM exploration_devices WHERE json_extract(binding,'$[2]')=? AND json_extract(binding,'$[3]')=?",epoch,deviceId);
   if(!sessionRow)return fn();
   const proofs=new Map();
   for(const item of operations){
    const body=item.inlineBody;if(!body?.operationId)continue;
    const p=get("SELECT fingerprint FROM exploration_operations WHERE binding=? AND channel='record' AND op=?",sessionRow.binding,body.operationId);
    if(p){if(p.fingerprint!==fingerprint(body))throw Error('OPERATION_REUSED');proofs.set(body.operationId,p);}
   }
   const result=fn();
   for(const r of result.receipts)if(proofs.has(r.operationId)&&r.status!=='blocked-dependency')
    run("UPDATE exploration_operations SET result=? WHERE binding=? AND channel='record' AND op=? AND result IS NULL",JSON.stringify(r),sessionRow.binding,r.operationId);
   return result;
  });
 }
 function settingsChanged(value){run("INSERT INTO exploration_stream(entity,k,value) VALUES('settings',?,?)",JSON.stringify(['settings']),JSON.stringify(value));}
 return {execute,recordPush,settingsChanged};
}
