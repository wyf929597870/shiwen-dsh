import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {definitions,catalog,parseCall,permissions} from '../../../integration/contracts.mjs';
import {markdownSource} from './markdown.mjs';
import {dateKey,readDoc} from './content.mjs';
import {validDay} from './wiki-import.mjs';
export const externalDDL=`
 CREATE TABLE IF NOT EXISTS external_clients(id TEXT PRIMARY KEY,name TEXT NOT NULL,token_hash TEXT NOT NULL UNIQUE,scopes TEXT NOT NULL,created TEXT NOT NULL,revoked TEXT,last_used TEXT);
 CREATE TABLE IF NOT EXISTS external_requests(client_id TEXT NOT NULL,request_id TEXT NOT NULL,fingerprint TEXT NOT NULL,result TEXT NOT NULL,created TEXT NOT NULL,PRIMARY KEY(client_id,request_id));
 CREATE TABLE IF NOT EXISTS external_sources(id TEXT PRIMARY KEY,record TEXT NOT NULL REFERENCES records(id),client_id TEXT NOT NULL,client_name TEXT NOT NULL,action TEXT NOT NULL,session_id TEXT NOT NULL,message_id TEXT NOT NULL,file TEXT NOT NULL,at TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS external_sources_record ON external_sources(record);`;
const hash=value=>createHash('sha256').update(value).digest('hex');
const now=()=>new Date().toISOString();
export class AccessError extends Error{constructor(message,status=403){super(message);this.status=status;}}
export const recordSummary=row=>({id:row.id,revision:row.revision,title:row.title,kind:row.kind,origin:row.origin,day:row.importInfo?row.importInfo.day:row.dateInfo?row.dateInfo.day:dateKey(row.created),url:row.url,annotation:row.annotation,stage:row.stage,sourceIds:row.sourceIds});
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
   if(!identity.scopes.includes(definition.permission))throw new AccessError('当前凭据没有 '+definition.permission+' 权限');
   const args=parseCall(name,raw);
   const read=()=>{
    if(name==='shiwen_search')return api.searchRecords({...args,limit:20});
    if(name==='shiwen_review'){const r=api.review(args);return {start:r.start,end:r.end,totals:r.totals,daily:r.daily,undated:r.undated};}
    const row=api.get(args.id);if(!row||row.deleted)throw new AccessError('记录不存在',404);
    if(args.revision!==undefined&&args.revision!==row.revision)throw new AccessError('内容已更新，请重新读取',409);
    const body=markdownSource(row.doc),offset=args.offset??0;
    return {...recordSummary(row),format:'markdown',body:body.slice(offset,offset+6000),totalLength:body.length,nextOffset:body.length>offset+6000?offset+6000:null,contentOrigins:Object.entries(readDoc(row.doc,row.origin).groups).filter(([,text])=>text.trim()).map(([origin])=>origin),externalSources:row.externalSources};
   };
   if(definition.permission==='read'){const result=read();db.prepare('UPDATE external_clients SET last_used=? WHERE id=?').run(now(),client.id);return result;}
   return db.transaction(()=>{
    const fingerprint=hash(JSON.stringify([name,args]));
    const previous=db.prepare('SELECT fingerprint,result FROM external_requests WHERE client_id=? AND request_id=?').get(client.id,args.requestId);
    if(previous){if(previous.fingerprint!==fingerprint)throw new AccessError('requestId 已用于不同请求，请使用新的 ID',409);return JSON.parse(previous.result);}
    const {requestId,source,...fields}=args;let result;
    if(definition.permission==='create'){
     const content=name==='shiwen_collect'?{...fields,kind:'web',origin:'external'}:fields;
     const day=content.day??null;if(day!==null&&validDay(day)!==day)throw Error('请输入有效内容日期');
     const row=api.save({...content,reason:'外部客户端保存'},{inTransaction:true,archive:true});
     db.prepare('INSERT INTO record_dates(record,day,basis) VALUES(?,?,?)').run(row.id,day,'外部客户端提供的内容日期');
     result={saved:true,...recordSummary(api.get(row.id))};
    }else if(name==='shiwen_update')result={updated:true,...recordSummary(api.updateRecord(fields,{addedOrigin:'ai'}))};
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
