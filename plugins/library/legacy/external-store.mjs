import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {definitions,catalog,parseCall,permissions} from '../../../integration/contracts.mjs';
import {markdownSource} from './markdown.mjs';
import {dateKey,readDoc} from './content.mjs';
import {validDay} from './wiki-import.mjs';
import {attachmentImageIds} from './image-references.mjs';
export const externalDDL=`
 CREATE TABLE IF NOT EXISTS external_clients(id TEXT PRIMARY KEY,name TEXT NOT NULL,token_hash TEXT NOT NULL UNIQUE,scopes TEXT NOT NULL,created TEXT NOT NULL,revoked TEXT,last_used TEXT);
 CREATE TABLE IF NOT EXISTS external_requests(client_id TEXT NOT NULL,request_id TEXT NOT NULL,fingerprint TEXT NOT NULL,result TEXT NOT NULL,created TEXT NOT NULL,PRIMARY KEY(client_id,request_id));
 CREATE TABLE IF NOT EXISTS external_sources(id TEXT PRIMARY KEY,record TEXT NOT NULL REFERENCES records(id),client_id TEXT NOT NULL,client_name TEXT NOT NULL,action TEXT NOT NULL,session_id TEXT NOT NULL,message_id TEXT NOT NULL,file TEXT NOT NULL,at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS external_image_uploads(id TEXT PRIMARY KEY,client_id TEXT NOT NULL,purpose TEXT NOT NULL,record_id TEXT,name TEXT NOT NULL,byte_length INTEGER NOT NULL,digest TEXT NOT NULL,created TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS external_image_parts(upload_id TEXT NOT NULL,part INTEGER NOT NULL,data BLOB NOT NULL,PRIMARY KEY(upload_id,part),FOREIGN KEY(upload_id) REFERENCES external_image_uploads(id) ON DELETE CASCADE);
 CREATE INDEX IF NOT EXISTS external_sources_record ON external_sources(record);`;
const hash=value=>createHash('sha256').update(value).digest('hex');
const now=()=>new Date().toISOString();
const PART_BYTES=512*1024;
export function imageType(bytes){
 if(bytes.length>=8&&bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')))return 'png';
 if(bytes.length>=3&&bytes[0]===0xff&&bytes[1]===0xd8&&bytes[2]===0xff)return 'jpeg';
 if(bytes.length>=6&&['GIF87a','GIF89a'].includes(bytes.subarray(0,6).toString('ascii')))return 'gif';
 if(bytes.length>=12&&bytes.subarray(0,4).toString('ascii')==='RIFF'&&bytes.subarray(8,12).toString('ascii')==='WEBP')return 'webp';
 throw Error('不支持的图片格式');
}
export class AccessError extends Error{constructor(message,status=403){super(message);this.status=status;}}
export const recordSummary=row=>({id:row.id,revision:row.revision,title:row.title,kind:row.kind,origin:row.origin,day:row.importInfo?row.importInfo.day:row.dateInfo?row.dateInfo.day:dateKey(row.created),url:row.url,annotation:row.annotation,stage:row.stage,sourceIds:row.sourceIds});
const recordSummaryWithAnchor=row=>({...recordSummary(row),...(row.annotationOf?{annotationOf:row.annotationOf}:{})});
export function externalStore(db,api){
 const active=id=>{const row=db.prepare('SELECT * FROM external_clients WHERE id=? AND revoked IS NULL').get(id);if(!row)throw new AccessError('凭据无效或已撤销',401);return {...row,scopes:JSON.parse(row.scopes)};};
 return {
  externalClients:()=>db.prepare('SELECT id,name,scopes,created,revoked,last_used FROM external_clients ORDER BY created DESC').all().map(row=>({...row,scopes:JSON.parse(row.scopes)})),
  externalClientCreate:({name,scopes})=>{
   if(typeof name!=='string'||!name.trim()||name.length>80||!Array.isArray(scopes)||!scopes.length||scopes.some(s=>!permissions.includes(s)))throw Error('请输入客户端名称并选择有效权限');
   const id=randomUUID(),token='sw_'+randomBytes(32).toString('base64url'),created=now(),allowed=[...new Set(scopes)];
   db.prepare('INSERT INTO external_clients(id,name,token_hash,scopes,created) VALUES(?,?,?,?,?)').run(id,name.trim(),hash(token),JSON.stringify(allowed),created);
   return {id,name:name.trim(),scopes:allowed,created,token};
  },
  externalClientRevoke:({id})=>{if(typeof id!=='string')throw Error('无效客户端');if(!db.prepare('UPDATE external_clients SET revoked=? WHERE id=? AND revoked IS NULL').run(now(),id).changes)throw Error('客户端不存在或已撤销');return {revoked:true};},
  externalAuthenticate:token=>{
   if(typeof token!=='string'||token.length>200)throw new AccessError('需要有效凭据',401);
   const row=db.prepare('SELECT id FROM external_clients WHERE token_hash=? AND revoked IS NULL').get(hash(token));if(!row)throw new AccessError('凭据无效或已撤销',401);
   return {id:row.id};
  },
  externalCatalog:client=>catalog(active(client.id).scopes),
  externalCall:(client,name,raw)=>{
   const identity=active(client.id),definition=definitions[name];
   if(!definition)throw Error('未知工具');
   if(definition.permission!=='upload'&&!identity.scopes.includes(definition.permission))throw new AccessError('当前凭据没有 '+definition.permission+' 权限');
   const args=parseCall(name,raw);
   if(definition.permission==='upload')return db.transaction(()=>{
    if(name==='shiwen_image_begin'){
     if(!identity.scopes.includes(args.purpose))throw new AccessError('当前凭据没有 '+args.purpose+' 权限');
     if((args.purpose==='update')!==Boolean(args.recordId))throw Error('图片上传用途与记录不匹配');
     if(args.recordId){const row=api.get(args.recordId);if(!row||row.deleted)throw new AccessError('记录不存在',404);}
     const expired=db.prepare('SELECT id FROM external_image_uploads WHERE created<?').all(new Date(Date.now()-7*24*60*60*1000).toISOString());
     for(const item of expired){db.prepare('DELETE FROM external_image_parts WHERE upload_id=?').run(item.id);db.prepare('DELETE FROM external_image_uploads WHERE id=?').run(item.id);}
     const prior=db.prepare('SELECT * FROM external_image_uploads WHERE id=?').get(args.uploadId);
     if(prior){if(prior.client_id!==client.id||prior.purpose!==args.purpose||prior.record_id!==(args.recordId??null)||prior.name!==args.name||prior.byte_length!==args.byteLength||prior.digest!==args.digest)throw new AccessError('上传编号已用于其他内容',409);}
     else {const quota=db.prepare('SELECT COUNT(*) AS count,COALESCE(SUM(byte_length),0) AS bytes FROM external_image_uploads WHERE client_id=?').get(client.id);if(quota.count>=20||quota.bytes+args.byteLength>100*1024*1024)throw Error('图片暂存空间已满');db.prepare('INSERT INTO external_image_uploads VALUES(?,?,?,?,?,?,?,?)').run(args.uploadId,client.id,args.purpose,args.recordId??null,args.name,args.byteLength,args.digest,now());}
    }
    const upload=db.prepare('SELECT * FROM external_image_uploads WHERE id=? AND client_id=?').get(args.uploadId,client.id);
    if(!upload||!identity.scopes.includes(upload.purpose))throw new AccessError('上传不存在或权限不足',403);
    const count=Math.ceil(upload.byte_length/PART_BYTES);
    if(name==='shiwen_image_part'){
     if(args.part>=count)throw Error('图片分块序号无效');
     const bytes=Buffer.from(args.dataBase64,'base64');
     if(bytes.toString('base64')!==args.dataBase64||bytes.length!==Math.min(PART_BYTES,upload.byte_length-args.part*PART_BYTES))throw Error('图片分块无效');
     const old=db.prepare('SELECT data FROM external_image_parts WHERE upload_id=? AND part=?').get(upload.id,args.part);
     if(old&&!Buffer.from(old.data).equals(bytes))throw new AccessError('分块内容不一致',409);
     if(!old)db.prepare('INSERT INTO external_image_parts VALUES(?,?,?)').run(upload.id,args.part,bytes);
    }
    const parts=db.prepare('SELECT part,data FROM external_image_parts WHERE upload_id=? ORDER BY part').all(upload.id);
    const present=new Set(parts.map(x=>x.part)),missing=Array.from({length:count},(_,i)=>i).filter(i=>!present.has(i));
    let ready=false;if(!missing.length){const bytes=Buffer.concat(parts.map(x=>Buffer.from(x.data)));if(bytes.length!==upload.byte_length||hash(bytes)!==upload.digest)throw Error('图片完整性校验失败');imageType(bytes);ready=true;}
    return {uploadId:upload.id,attachmentId:upload.id,partBytes:PART_BYTES,missingParts:missing,ready};
   })();
   const read=()=>{
    if(name==='shiwen_search')return api.searchRecords({...args,limit:20});
    if(name==='shiwen_original_version')return api.originalVersionInfo(args);
    if(name==='shiwen_annotation_list')return api.annotationList(args).map(recordSummaryWithAnchor);
    if(name==='shiwen_review'){const r=api.review(args);return {start:r.start,end:r.end,totals:r.totals,daily:r.daily,undated:r.undated};}
    const row=api.get(args.id);if(!row||row.deleted)throw new AccessError('记录不存在',404);
    if(name==='shiwen_annotation_read'&&row.kind!=='ai_annotation')throw new AccessError('批注不存在',404);
    if(name==='shiwen_read'&&row.kind==='ai_annotation')throw new AccessError('请使用批注读取工具',400);
    if(name==='shiwen_image_read'){
     const attachment=api.attachment({id:args.attachmentId});if(!attachment||attachment.record!==row.id)throw new AccessError('附件不存在',404);
     const bytes=Buffer.from(attachment.data,'base64');imageType(bytes);const offset=args.offset??0;if(offset>bytes.length)throw Error('读取偏移无效');
     const end=Math.min(offset+PART_BYTES,bytes.length);return {id:attachment.id,name:attachment.name,digest:hash(bytes),byteLength:bytes.length,offset,nextOffset:end<bytes.length?end:null,dataBase64:bytes.subarray(offset,end).toString('base64')};
    }
    if(args.revision!==undefined&&args.revision!==row.revision)throw new AccessError('内容已更新，请重新读取',409);
    const body=markdownSource(row.doc),offset=args.offset??0;
    return {...recordSummaryWithAnchor(row),format:'markdown',body:body.slice(offset,offset+6000),totalLength:body.length,nextOffset:body.length>offset+6000?offset+6000:null,attachments:api.attachments({record:row.id}),contentOrigins:Object.entries(readDoc(row.doc,row.origin).groups).filter(([,text])=>text.trim()).map(([origin])=>origin),externalSources:row.externalSources};
   };
   if(definition.permission==='read'){const result=read();db.prepare('UPDATE external_clients SET last_used=? WHERE id=?').run(now(),client.id);return result;}
   return db.transaction(()=>{
    const fingerprint=hash(JSON.stringify([name,args]));
    const previous=db.prepare('SELECT fingerprint,result FROM external_requests WHERE client_id=? AND request_id=?').get(client.id,args.requestId);
    if(previous){if(previous.fingerprint!==fingerprint)throw new AccessError('requestId 已用于不同请求，请使用新的 ID',409);return JSON.parse(previous.result);}
    const {requestId,source,imageIds:uploads=[],...fields}=args;const operationId=hash(JSON.stringify([client.id,requestId]));let result;
    if(['shiwen_update','shiwen_delete','shiwen_restore','shiwen_correct_origin'].includes(name)){const row=api.get(fields.id);if(row?.kind==='ai_annotation')throw new AccessError('请使用批注操作',400);}
    if(new Set(uploads).size!==uploads.length)throw Error('图片引用重复');
    if(typeof fields.body==='string'&&['create','update'].includes(definition.permission)){
     const references=attachmentImageIds(fields.body),current=definition.permission==='update'?api.get(fields.id):null;
     const previousReferences=current?attachmentImageIds(markdownSource(current.doc)):new Set();
     const existing=new Set(current?api.attachments({record:current.id}).map(item=>item.id):[]);
     if(uploads.some(id=>!references.has(id)))throw Error('正文缺少图片引用');
     if([...references].some(id=>!existing.has(id)&&!uploads.includes(id)&&!previousReferences.has(id)))throw Error('正文引用的图片不存在');
    }
    const staged=uploads.map(id=>{
     const item=db.prepare('SELECT * FROM external_image_uploads WHERE id=? AND client_id=?').get(id,client.id);
     if(!item||item.purpose!==definition.permission||(item.purpose==='update'&&item.record_id!==fields.id))throw new AccessError('图片上传不存在或不属于当前操作',403);
     if(typeof fields.body!=='string'||!fields.body.includes(`attachment:${id}`))throw Error('正文缺少图片引用');
     const parts=db.prepare('SELECT part,data FROM external_image_parts WHERE upload_id=? ORDER BY part').all(id),count=Math.ceil(item.byte_length/PART_BYTES);
     if(parts.length!==count||parts.some((x,i)=>x.part!==i))throw Error('图片尚未上传完成');
     const bytes=Buffer.concat(parts.map(x=>Buffer.from(x.data)));if(bytes.length!==item.byte_length||hash(bytes)!==item.digest)throw Error('图片完整性校验失败');imageType(bytes);
     return {item,bytes};
    });
    const attach=record=>{for(const {item,bytes} of staged){db.prepare('INSERT INTO attachments VALUES(?,?,?,?,?)').run(item.id,record.id,item.name,bytes.toString('base64'),now());db.prepare('DELETE FROM external_image_parts WHERE upload_id=?').run(item.id);db.prepare('DELETE FROM external_image_uploads WHERE id=?').run(item.id);}};
    if(name==='shiwen_annotation_create'){const row=api.annotationCreate({...fields,requestId:operationId},{beforeSync:attach});result={saved:true,...recordSummaryWithAnchor(row)};
    }else if(name==='shiwen_annotation_update'){const row=api.annotationUpdate({...fields,requestId:operationId},{beforeSync:attach});result={updated:true,...recordSummaryWithAnchor(row)};
    }else if(name==='shiwen_annotation_delete'){const row=api.annotationDelete({...fields,requestId:operationId});result={deleted:true,...recordSummaryWithAnchor(row)};
    }else if(name==='shiwen_annotation_restore'){const row=api.annotationRestore({...fields,requestId:operationId});result={restored:true,...recordSummaryWithAnchor(row)};
    }else if(name==='shiwen_correct_origin'){const row=api.correctRecordOrigin({...fields,requestId:operationId});result={updated:true,...recordSummary(row)};
    }else if(definition.permission==='create'){
     const content=name==='shiwen_collect'?{...fields,kind:'web',origin:'external'}:fields;
     const day=content.day??null;if(day!==null&&validDay(day)!==day)throw Error('请输入有效内容日期');
     const row=api.save({...content,reason:'外部客户端保存'},{inTransaction:true,archive:true,beforeSync:record=>{attach(record);if(content.kind!=='journal')db.prepare('INSERT INTO record_dates(record,day,basis) VALUES(?,?,?)').run(record.id,day,'外部客户端提供的内容日期');}});
     result={saved:true,...recordSummary(api.get(row.id))};
    }else if(name==='shiwen_update')result={updated:true,...recordSummary(api.updateRecord(fields,{beforeSync:attach}))};
    else if(name==='shiwen_delete')result={deleted:true,...api.remove(fields)};
    else result={restored:true,...api.restoreRemoved(fields)};
    db.prepare('INSERT INTO external_sources VALUES(?,?,?,?,?,?,?,?,?)').run(randomUUID(),result.id,client.id,identity.name,name,source?.sessionId??'',source?.messageId??'',source?.file??'',now());
    const response={...result,client:{id:client.id,name:identity.name},requestId};
    db.prepare('INSERT INTO external_requests VALUES(?,?,?,?,?)').run(client.id,requestId,fingerprint,JSON.stringify(response),now());
    db.prepare('UPDATE external_clients SET last_used=? WHERE id=?').run(now(),client.id);
    return response;
   })();
  }
 };
}
