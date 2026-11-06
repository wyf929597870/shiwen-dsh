import {externalDDL,externalStore} from './external-store.mjs';
import {agentDDL,createAgentStore,memoryDefaults} from './agent-store.mjs';
import {migrateConversations,conversationStore} from './conversations.mjs';
import {validDay} from './wiki-import.mjs';
import {importDDL,importWiki} from './import-store.mjs';
import Database from './sqlite.mjs';
import {randomUUID,createHash} from 'node:crypto';
import {mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {kinds,origins,plainDoc,readDoc,changes,dateRange,dateKey} from './content.mjs';
import {updateMarkdownDoc} from './markdown.mjs';
const stamp=()=>new Date().toISOString();
const parse=s=>JSON.parse(s);
const requireText=(s,max=500)=>{if(typeof s!=='string'||s.length>max)throw new Error('输入格式或长度不正确');return s;};
export function createStore(path,{recover=true}={}) {
  mkdirSync(dirname(path),{recursive:true});
  const db=new Database(path);db.pragma('journal_mode = WAL');db.pragma('foreign_keys = ON');db.pragma('busy_timeout = 5000');
  const existing=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'").get();
  if(existing){const schema=db.prepare("SELECT value FROM meta WHERE key='schema'").get();if(schema&&!['1','2','3','4','5'].includes(schema.value)){db.close();throw new Error('数据库版本不受当前应用支持，请使用更新版本');}}
  if(existing&&db.prepare("SELECT value FROM meta WHERE key='schema'").get()?.value!=='4'&&db.prepare("SELECT value FROM meta WHERE key='schema'").get()?.value!=='5'){
    // SQLite's own snapshot includes WAL; never copy a live database file alone.
    db.prepare('VACUUM INTO ?').run(path+'.before-agent-v4-'+Date.now()+'.sqlite');
  }
  db.exec(`CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS records(id TEXT PRIMARY KEY,kind TEXT NOT NULL,title TEXT NOT NULL,doc TEXT NOT NULL,body TEXT NOT NULL,origin TEXT NOT NULL,url TEXT NOT NULL DEFAULT '',annotation TEXT NOT NULL DEFAULT '',stage TEXT NOT NULL DEFAULT 'draft',revision INTEGER NOT NULL,created TEXT NOT NULL,updated TEXT NOT NULL,deleted INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS links(article TEXT NOT NULL REFERENCES records(id),material TEXT NOT NULL REFERENCES records(id),PRIMARY KEY(article,material));
  CREATE TABLE IF NOT EXISTS versions(id TEXT PRIMARY KEY,record TEXT NOT NULL REFERENCES records(id),revision INTEGER NOT NULL,doc TEXT NOT NULL,title TEXT NOT NULL,at TEXT NOT NULL,reason TEXT NOT NULL,UNIQUE(record,revision));
  CREATE TABLE IF NOT EXISTS edits(id TEXT PRIMARY KEY,record TEXT NOT NULL REFERENCES records(id),at TEXT NOT NULL,origin TEXT NOT NULL,added INTEGER NOT NULL,removed INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY,result TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS memories(id TEXT PRIMARY KEY,scope TEXT NOT NULL,body TEXT NOT NULL,created TEXT NOT NULL,updated TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,thread TEXT NOT NULL,role TEXT NOT NULL,body TEXT NOT NULL,status TEXT NOT NULL,created TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,thread TEXT NOT NULL,status TEXT NOT NULL,model TEXT NOT NULL,error TEXT NOT NULL DEFAULT '',created TEXT NOT NULL,updated TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS attachments(id TEXT PRIMARY KEY,record TEXT NOT NULL REFERENCES records(id),name TEXT NOT NULL,data TEXT NOT NULL,created TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS edits_at ON edits(at); CREATE INDEX IF NOT EXISTS messages_thread ON messages(thread,created);`);
  if(!db.prepare('PRAGMA table_info(messages)').all().some(c=>c.name==='context'))db.exec("ALTER TABLE messages ADD COLUMN context TEXT NOT NULL DEFAULT '{}'");
  db.exec(importDDL);
  db.exec(agentDDL);
  db.exec(externalDDL);
  db.exec(`CREATE TABLE IF NOT EXISTS dsh_record_sources (
    record TEXT NOT NULL REFERENCES records(id), session_id TEXT NOT NULL,
    message_id TEXT NOT NULL, role TEXT NOT NULL, excerpt TEXT NOT NULL,
    PRIMARY KEY(record,session_id,message_id)
  )`);
  const memoryColumns=db.prepare('PRAGMA table_info(memories)').all().map(c=>c.name);
  for(const [name,value] of Object.entries(memoryDefaults))if(!memoryColumns.includes(name))db.exec(`ALTER TABLE memories ADD COLUMN ${name} ${typeof value==='number'?'INTEGER':'TEXT'} NOT NULL DEFAULT ${typeof value==='number'?value:JSON.stringify(value).replaceAll('\"',"'")}`);
  db.prepare("UPDATE memories SET category='project' WHERE scope!='global' AND category='memory'").run();
  db.transaction(()=>{migrateConversations(db);db.prepare("INSERT INTO meta VALUES ('schema','5') ON CONFLICT(key) DO UPDATE SET value='5'").run();})();
  if(recover)db.prepare("UPDATE runs SET status='interrupted',updated=? WHERE status='running'").run(stamp());
  if(recover)db.prepare("UPDATE messages SET status='interrupted' WHERE status='streaming'").run();
  const importInfo=id=>{const row=db.prepare('SELECT * FROM imports WHERE record=?').get(id);return row?{...row,metadata:parse(row.metadata),links:parse(row.links)}:null;};
  const decode=r=>r?{...r,externalSources:db.prepare('SELECT * FROM external_sources WHERE record=? ORDER BY at DESC,rowid DESC').all(r.id),dateInfo:db.prepare('SELECT * FROM record_dates WHERE record=?').get(r.id)??null,importInfo:importInfo(r.id),doc:parse(r.doc),sourceIds:db.prepare('SELECT material FROM links WHERE article=?').all(r.id).map(x=>x.material)}:null;
  // Use content dates for both the desktop list and Agent search. An explicit
  // unknown date stays unknown; editing/import timestamps must not promote it.
  const effectiveDay=r=>r.imported?r.import_day:r.dated?r.content_day:dateKey(r.created);
  const descending=(a,b)=>a===b?0:a>b?-1:1;
  const orderedRecords=()=>db.prepare('SELECT r.*,i.day AS import_day,i.record AS imported,d.day AS content_day,d.record AS dated FROM records r LEFT JOIN imports i ON i.record=r.id LEFT JOIN record_dates d ON d.record=r.id WHERE r.deleted=0').all()
    .map(r=>({...r,contentDay:effectiveDay(r)}))
    .sort((a,b)=>descending(a.contentDay??'',b.contentDay??'')||descending(a.created,b.created)||descending(a.id,b.id));
  const get=id=>{const row=decode(db.prepare('SELECT * FROM records WHERE id=?').get(id));return row?{...row,contentDay:row.importInfo?row.importInfo.day:row.dateInfo?row.dateInfo.day:dateKey(row.created)}:null;};
  const getSetting=(key,fallback=null)=>{const r=db.prepare('SELECT value FROM settings WHERE key=?').get(key);return r?parse(r.value):fallback;};
  const setSetting=(key,value)=>db.prepare('INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,JSON.stringify(value));
  function save(input,{inTransaction=false,archive=false,beforeDoc}={}) {
    const operation=()=>{
      const op=input.opId;
      if(op){requireText(op,100);const prior=db.prepare('SELECT result FROM operations WHERE id=?').get(op);if(prior)return parse(prior.result);}
      const old=input.id?get(requireText(input.id,100)):null;
      if(input.id&&(!old||old.deleted))throw new Error('记录不存在或已删除');
      if(old&&input.revision!==old.revision)throw new Error('内容已被更新，请重新打开后再保存。你的草稿仍保留在编辑区。');
      const kind=input.kind??old?.kind??'freewrite';if(!kinds.includes(kind))throw new Error('无效的内容类型');
      if(old&&old.kind!==kind)throw new Error('已保存内容的类型不能在编辑时改变');
      const origin=old?.origin??(archive?input.origin:(kind==='web'?'external':kind==='ai'?'ai':'personal'));if(!origins.includes(origin))throw new Error('无效来源');
      const doc=input.doc??old?.doc??plainDoc(input.body??'',origin);const {text,groups}=readDoc(doc,origin);
      if(!text.trim()&&kind!=='article')throw new Error('先写下一些内容再保存');
      const title=requireText(input.title??old?.title??'',200).trim()||text.split('\n')[0].slice(0,32)||'未命名文章';
      const url=requireText(input.url??old?.url??'',2048);if(url&&!/^https?:\/\//.test(url))throw new Error('来源地址必须是 HTTP 或 HTTPS 链接');
      const annotation=requireText(input.annotation??old?.annotation??'',10000);
      const stage=input.stage??old?.stage??'draft';if(!['idea','draft','revision','final'].includes(stage))throw new Error('无效的文章阶段');
      const id=old?.id??randomUUID(),at=stamp(),revision=(old?.revision??0)+1;
      db.prepare(`INSERT INTO records(id,kind,title,doc,body,origin,url,annotation,stage,revision,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,doc=excluded.doc,body=excluded.body,url=excluded.url,annotation=excluded.annotation,stage=excluded.stage,revision=excluded.revision,updated=excluded.updated`).run(id,kind,title,JSON.stringify(doc),text,origin,url,annotation,stage,revision,old?.created??at,at);
      const before=old?readDoc(beforeDoc??old.doc,old.origin).groups:Object.fromEntries(origins.map(x=>[x,'']));
      for(const source of origins){const delta=archive?{added:0,removed:0}:changes(before[source],groups[source]);if(delta.added||delta.removed)db.prepare('INSERT INTO edits VALUES(?,?,?,?,?,?)').run(randomUUID(),id,at,source,delta.added,delta.removed);}
      db.prepare('INSERT INTO versions VALUES(?,?,?,?,?,?,?)').run(randomUUID(),id,revision,JSON.stringify(doc),title,at,requireText(input.reason??'保存',100));
      if(input.sourceIds!==undefined){if(kind!=='article'||!Array.isArray(input.sourceIds))throw new Error('素材关联格式不正确');db.prepare('DELETE FROM links WHERE article=?').run(id);for(const sourceId of new Set(input.sourceIds)){const source=get(sourceId);if(!source||source.kind==='article'||source.deleted&&!old?.sourceIds.includes(sourceId))throw new Error('关联素材不存在');db.prepare('INSERT INTO links VALUES(?,?)').run(id,sourceId);}}
      if(getSetting('editingDraft')?.id===id)db.prepare("DELETE FROM settings WHERE key='editingDraft'").run();
      const result=get(id);if(op)db.prepare('INSERT INTO operations VALUES(?,?)').run(op,JSON.stringify(result));return result;
    };return inTransaction?operation():db.transaction(operation)();
  }
  // Shared mutation boundary. The trusted caller fixes the origin of newly added text.
  function updateRecord(input,{addedOrigin='personal',operationId}={}) {
    const fields=['kind','title','body','day','url','annotation','stage','sourceIds','origin'];
    if(!input||Object.keys(input).some(key=>!['id','revision',...fields].includes(key)))throw new Error('无效的修改字段');
    requireText(input.id,100);if(!Number.isInteger(input.revision)||input.revision<1)throw new Error('版本无效');
    if(!fields.some(key=>input[key]!==undefined))throw new Error('请提供要修改的字段');
    if(!['personal','ai'].includes(addedOrigin))throw new Error('无效的编辑来源');
    const fingerprint=createHash('sha256').update(JSON.stringify([addedOrigin,...['id','revision',...fields].map(key=>[key,input[key]])])).digest('hex');
    return db.transaction(()=>{
      if(operationId){requireText(operationId,100);const prior=db.prepare('SELECT result FROM operations WHERE id=?').get(operationId);if(prior){const result=parse(prior.result);if(result.fingerprint!==fingerprint)throw new Error('重复操作的参数不一致');return result.record;}}
      const old=get(input.id);if(!old||old.deleted)throw new Error('记录不存在或已删除');
      if(input.revision!==old.revision)throw new Error('内容已被更新，请重新读取后再修改');
      const kind=input.kind??old.kind;
      if(!kinds.includes(kind))throw new Error('无效的内容类型');
      if(kind!==old.kind&&(kind==='article'||old.kind==='article'))throw new Error('素材与文章不能直接互改类型，请新建文章并关联素材');
      for(const key of ['kind','title','body','url','annotation','stage'])if(input[key]!==undefined)requireText(input[key],key==='body'?1000000:key==='annotation'?10000:key==='url'?2048:key==='title'?200:30);
      if(input.stage!==undefined&&old.kind!=='article')throw new Error('只有文章可以设置状态');
      const day=input.day===''?null:input.day;
      if(day!==undefined&&day!==null&&validDay(day)!==day)throw new Error('请输入有效日期');
      if(day!==undefined&&old.importInfo?.path===':assets')throw new Error('附件归档不能设置内容日期');
      if(input.origin!==undefined&&!origins.includes(input.origin))throw new Error('无效来源');
      const baseline=structuredClone(old.doc);
      // An explicit attribution correction changes existing spans, not writing activity.
      if(input.origin!==undefined){
        const attribute=node=>{if(node.type==='text')node.marks=[...(node.marks??[]).filter(mark=>mark.type!=='provenance'),{type:'provenance',attrs:{origin:input.origin}}];for(const child of node.content??[])attribute(child);};attribute(baseline);
      }
      const doc=input.body===undefined?baseline:updateMarkdownDoc(baseline,input.body,addedOrigin,input.origin??old.origin);
      save({id:old.id,revision:old.revision,kind:old.kind,doc,title:input.title,url:input.url,annotation:input.annotation,stage:input.stage,sourceIds:input.sourceIds,reason:(addedOrigin==='ai'?'Agent 修改':'编辑资料')+(input.origin!==undefined?`; 来源 ${old.origin} → ${input.origin}`:'')},{inTransaction:true,beforeDoc:baseline});
      if(input.origin!==undefined)db.prepare('UPDATE records SET origin=? WHERE id=?').run(input.origin,old.id);
      if(kind!==old.kind)db.prepare('UPDATE records SET kind=? WHERE id=?').run(kind,old.id);
      if(day!==undefined){
        if(old.importInfo)db.prepare('UPDATE imports SET day=?,date_basis=? WHERE record=?').run(day,'人工修正',old.id);
        else db.prepare('INSERT INTO record_dates(record,day,basis) VALUES(?,?,?) ON CONFLICT(record) DO UPDATE SET day=excluded.day,basis=excluded.basis').run(old.id,day,'人工确认');
      }
      const record=get(old.id);
      if(operationId)db.prepare('INSERT INTO operations VALUES(?,?)').run(operationId,JSON.stringify({fingerprint,record}));
      return record;
    })();
  }
  function review(args={}) {
    const range=dateRange(args.period??'7',args.month,args.now?new Date(args.now):new Date(),args.timeZone);
    const within=at=>{const key=dateKey(at,range.timeZone);return key>=range.start&&key<=range.end;};
    const rows=db.prepare('SELECT e.*,r.title,r.kind,r.deleted FROM edits e JOIN records r ON r.id=e.record ORDER BY e.at DESC').all().filter(x=>within(x.at));
    const records=db.prepare('SELECT * FROM records').all();
    const imported=new Map(db.prepare('SELECT * FROM imports').all().map(r=>[r.record,r]));
    const recordDates=new Map(db.prepare('SELECT * FROM record_dates').all().map(r=>[r.record,r]));
    const inDay=day=>!!day&&day>=range.start&&day<=range.end;
    const effectiveDay=r=>imported.has(r.id)?imported.get(r.id).day:recordDates.has(r.id)?recordDates.get(r.id).day:dateKey(r.created,range.timeZone);
    const newRecords=records.filter(x=>!x.deleted&&inDay(effectiveDay(x))&&!imported.get(x.id)?.duplicate_of);
    const collectedRecords=records.filter(x=>!x.deleted&&['web','ai','reference'].includes(x.kind)&&inDay(effectiveDay(x))&&!imported.get(x.id)?.duplicate_of);
    const historical=newRecords.filter(r=>imported.has(r.id)&&['journal','freewrite','idea','article'].includes(r.kind));
    const collectedKinds=['web','ai','reference'];
    const active=new Set(rows.filter(x=>x.kind==='article'&&!x.deleted).map(x=>x.record));
    for(const r of records)if(r.kind==='article'&&(imported.has(r.id)?inDay(imported.get(r.id).day)||r.revision>1&&within(r.updated):within(r.updated))&&!r.deleted)active.add(r.id);
    const totals={added:0,removed:0,net:0,personalRecords:newRecords.filter(x=>['journal','freewrite','idea'].includes(x.kind)&&x.origin==='personal').length,collected:collectedRecords.length,web:collectedRecords.filter(x=>x.kind==='web').length,ai:collectedRecords.filter(x=>x.kind==='ai').length,articles:active.size,finalized:records.filter(x=>active.has(x.id)&&x.stage==='final'&&!x.deleted).length};
    totals.reference=collectedRecords.filter(x=>x.kind==='reference').length;
    totals.historicalChars=historical.reduce((sum,r)=>sum+imported.get(r.id).chars,0);
    totals.historicalRecords=historical.length;
    const daily=range.days.map(day=>({day,added:0,removed:0,net:0,historical:historical.filter(r=>effectiveDay(r)===day).reduce((sum,r)=>sum+imported.get(r.id).chars,0),collected:collectedRecords.filter(x=>effectiveDay(x)===day).length}));
    for(const e of rows.filter(x=>x.origin==='personal')){totals.added+=e.added;totals.removed+=e.removed;const day=daily.find(x=>x.day===dateKey(e.at,range.timeZone));if(day){day.added+=e.added;day.removed+=e.removed;day.net+=e.added-e.removed;}}
    totals.net=totals.added-totals.removed;
    return {...range,totals,daily,historical:historical.map(decode),undated:records.filter(r=>!r.deleted&&(imported.has(r.id)?!imported.get(r.id).day&&imported.get(r.id).path!==':assets':recordDates.has(r.id)&&!recordDates.get(r.id).day)).length,edits:rows,articles:records.filter(x=>active.has(x.id)&&!x.deleted).map(decode),collected:collectedRecords.map(decode)};
  }
  function exportBackup(){const payload={schema:7,created:stamp(),drafts:{capture:getSetting('captureDraft',''),origin:getSetting('captureDraftOrigin','personal'),editing:getSetting('editingDraft')},tables:{}};for(const table of ['records','links','versions','edits','memories','messages','runs','attachments','imports','agent_documents','agent_sessions','memory_events','conversations','conversation_sources','conversation_drafts','record_sources','record_dates','agent_actions','dsh_record_sources','external_sources'])payload.tables[table]=db.prepare(`SELECT * FROM ${table}`).all();return JSON.stringify({format:'shiwen-backup',payload,sha256:createHash('sha256').update(JSON.stringify(payload)).digest('hex')});}
  function restoreBackup(raw,{requireEmpty=false}={}){
    if(typeof raw!=='string'||raw.length>1000000000)throw new Error('备份文件过大或无效');
    const b=parse(raw);if(b.format!=='shiwen-backup'||![1,2,3,4,5,6,7].includes(b.payload?.schema)||b.sha256!==createHash('sha256').update(JSON.stringify(b.payload)).digest('hex'))throw new Error('备份格式或校验不通过');
    if(b.payload.schema===1)for(const row of b.payload.tables.messages??[])row.context='{}';
    if(b.payload.schema<3)b.payload.tables.imports=[];
    if(b.payload.schema<4){for(const table of ['agent_documents','agent_sessions','memory_events','conversations','conversation_sources','conversation_drafts','record_sources','record_dates','agent_actions'])b.payload.tables[table]=[];for(const row of b.payload.tables.memories??[])Object.assign(row,{...memoryDefaults,...row,category:row.scope==='global'?(row.category??'memory'):'project'});}
    if(b.payload.schema<5)for(const table of ['conversations','conversation_sources','conversation_drafts','record_sources','record_dates','agent_actions'])b.payload.tables[table]=[];
    if(b.payload.schema<6)b.payload.tables.dsh_record_sources=[];
    if(b.payload.schema<7)b.payload.tables.external_sources=[];
    const tables=['records','links','versions','edits','memories','messages','runs','attachments','imports','agent_documents','agent_sessions','memory_events','conversations','conversation_sources','conversation_drafts','record_sources','record_dates','agent_actions','dsh_record_sources','external_sources'];
    for(const table of tables){if(!Array.isArray(b.payload.tables[table]))throw new Error('备份缺少数据表');const columns=db.prepare(`PRAGMA table_info(${table})`).all().map(x=>x.name);for(const row of b.payload.tables[table]){if(Object.keys(row).length!==columns.length||!columns.every(k=>Object.hasOwn(row,k)))throw new Error('备份字段不匹配');if(table==='records'){if(!kinds.includes(row.kind)||!origins.includes(row.origin))throw new Error('备份内容类型错误');readDoc(parse(row.doc),row.origin);}}}
    db.transaction(()=>{if(requireEmpty&&['records','memories','messages','runs','settings'].some(table=>db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get()))throw new Error('目标资料库已有内容，导入不会覆盖');for(const table of [...tables].reverse())db.prepare(`DELETE FROM ${table}`).run();db.prepare('DELETE FROM operations').run();db.prepare('DELETE FROM external_requests').run();db.prepare("DELETE FROM settings WHERE key IN ('captureDraft','captureDraftOrigin','editingDraft')").run();if(b.payload.drafts){setSetting('captureDraft',requireText(b.payload.drafts.capture,1000000));if(!origins.includes(b.payload.drafts.origin))throw new Error('草稿来源错误');setSetting('captureDraftOrigin',b.payload.drafts.origin);if(b.payload.drafts.editing){readDoc(b.payload.drafts.editing.doc);setSetting('editingDraft',b.payload.drafts.editing);}}for(const table of tables){const columns=db.prepare(`PRAGMA table_info(${table})`).all().map(x=>x.name);const insert=db.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(()=>'?').join(',')})`);for(const row of b.payload.tables[table])insert.run(...columns.map(k=>row[k]));}if(b.payload.schema<5)migrateConversations(db);db.prepare("UPDATE runs SET status='interrupted' WHERE status='running'").run();db.prepare("UPDATE messages SET status='interrupted' WHERE status='streaming'").run();})();return true;
  }
  const api={
    snapshot:()=>({records:orderedRecords().map(({import_day,imported,content_day,dated,...row})=>decode(row)),memories:db.prepare("SELECT * FROM memories WHERE status='active' ORDER BY updated DESC").all(),today:review({period:'1'}),draft:getSetting('captureDraft',''),draftOrigin:getSetting('captureDraftOrigin','personal'),editingDraft:getSetting('editingDraft')}),
    searchRecords:({query='',kind='',start='',end='',offset=0,limit=20}={})=>{requireText(query,100);requireText(kind,30);if(kind&&!kinds.includes(kind))throw new Error('无效类型');if(start&&validDay(start)!==start||end&&validDay(end)!==end||start&&end&&start>end)throw new Error('无效日期范围');if(!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>30)throw new Error('无效分页');const term=query.trim().toLowerCase();const rows=orderedRecords().filter(r=>{const day=r.contentDay;return (!kind||r.kind===kind)&&(!term||(r.title+' '+r.body+' '+r.annotation).toLowerCase().includes(term))&&(!start||day&&day>=start)&&(!end||day&&day<=end);});return {total:rows.length,items:rows.slice(offset,offset+limit).map(r=>({id:r.id,title:r.title,kind:r.kind,origin:r.origin,url:r.url,day:r.contentDay,excerpt:r.body.slice(Math.max(0,r.body.toLowerCase().indexOf(term)-100),Math.max(0,r.body.toLowerCase().indexOf(term)-100)+450)})),nextOffset:offset+limit<rows.length?offset+limit:null};},
    save, get, review, updateRecord, importWiki:scan=>importWiki(db,scan),
    dshSources:({id})=>db.prepare('SELECT session_id,message_id,role,excerpt FROM dsh_record_sources WHERE record=? ORDER BY rowid').all(requireText(id,100)),
    saveDsh:({kind,title='',body,origin='ai',url='',annotation='',day=null,sessionId,messageId,role,operationId,sourceExcerpt=body})=>{
      requireText(sessionId,100);requireText(messageId,100);requireText(operationId,100);requireText(body,1000000);
      if(!['journal','freewrite','idea','web','ai','article','reference'].includes(kind))throw new Error('无效的内容类型');
      if(!['personal','ai','external','unknown'].includes(origin)||!['user','assistant'].includes(role))throw new Error('无效来源');
      if(day!==null&&validDay(day)!==day)throw new Error('请输入有效日期');
      return db.transaction(()=>{
        const prior=db.prepare('SELECT result FROM operations WHERE id=?').get(operationId);
        if(prior)return parse(prior.result);
        const result=save({kind,title,body,origin,url,annotation,opId:operationId},{inTransaction:true,archive:true});
        db.prepare('INSERT INTO dsh_record_sources VALUES(?,?,?,?,?)').run(result.id,sessionId,messageId,role,requireText(sourceExcerpt,1000000).slice(0,500));
        db.prepare('INSERT INTO record_dates VALUES(?,?,?)').run(result.id,day,day?'对话归档指定':'对话归档，内容日期待确认');
        const saved=get(result.id);
        db.prepare('UPDATE operations SET result=? WHERE id=?').run(JSON.stringify(saved),operationId);
        return saved;
      })();
    },
    importDate:({id,day})=>{const row=importInfo(id);if(!row||row.path===':assets')throw new Error('记录不是导入文档');if(day!==null&&validDay(day)!==day)throw new Error('请输入有效日期');db.transaction(()=>{db.prepare("UPDATE imports SET day=?,date_basis='人工修正' WHERE record=?").run(day,id);if(day)db.prepare('UPDATE records SET created=?,updated=CASE WHEN revision=1 THEN ? ELSE updated END WHERE id=?').run(day+'T12:00:00+08:00',day+'T12:00:00+08:00',id);})();return get(id);},
    remove:({id,revision})=>db.transaction(()=>{
      requireText(id,100);if(!Number.isInteger(revision)||revision<1)throw new Error('版本无效');
      const result=db.prepare('UPDATE records SET deleted=1,revision=revision+1 WHERE id=? AND revision=? AND deleted=0').run(id,revision);
      if(!result.changes)throw new Error('内容已变更或已删除，请刷新');
      if(getSetting('editingDraft')?.id===id)db.prepare("DELETE FROM settings WHERE key='editingDraft'").run();
      return {id,revision:revision+1};
    })(),
    restoreRemoved:({id,revision})=>{
      requireText(id,100);if(!Number.isInteger(revision)||revision<1)throw new Error('版本无效');
      const result=db.prepare('UPDATE records SET deleted=0,revision=revision+1 WHERE id=? AND revision=? AND deleted=1').run(id,revision);
      if(!result.changes)throw new Error('记录状态已变更，请刷新');
      return {id,revision:revision+1};
    },
    versions:({id})=>db.prepare('SELECT * FROM versions WHERE record=? ORDER BY revision DESC').all(id).map(r=>({...r,doc:parse(r.doc)})),
    restoreVersion:({id,versionId,revision})=>{const v=db.prepare('SELECT * FROM versions WHERE id=? AND record=?').get(versionId,id);if(!v)throw new Error('版本不存在');return save({id,revision,doc:parse(v.doc),title:v.title,reason:`恢复版本 ${v.revision}`});},
    draft:({value,origin='personal'})=>{requireText(value,1000000);if(!origins.includes(origin))throw new Error('无效来源');db.transaction(()=>{setSetting('captureDraft',value);setSetting('captureDraftOrigin',origin);})();return true;},
    editingDraft:({value})=>{if(value){const r=get(value.id);if(!r||r.deleted)throw new Error('草稿所属记录不存在');readDoc(value.doc,r.origin);requireText(value.title,200);requireText(value.annotation,10000);if(!Number.isInteger(value.revision))throw new Error('草稿版本无效');}setSetting('editingDraft',value);return true;},
    messages:({thread})=>db.prepare('SELECT * FROM messages WHERE thread=? ORDER BY created,rowid').all(thread).map(r=>({...r,context:parse(r.context)})),
    addMessage:(r)=>{const id=r.id??randomUUID();db.prepare('INSERT INTO messages(id,thread,role,body,status,created,context) VALUES(?,?,?,?,?,?,?)').run(id,r.thread,r.role,r.body,r.status??'done',stamp(),JSON.stringify(r.context??{}));return id;},
    updateMessage:({id,body,status})=>{db.prepare('UPDATE messages SET body=?,status=? WHERE id=?').run(body,status,id);return true;},
    addRun:({id,thread,model})=>{const at=stamp();db.prepare("INSERT INTO runs VALUES(?,?,'running',?,'',?,?)").run(id,thread,model,at,at);return true;},
    finishRun:({id,status,error=''})=>{db.prepare('UPDATE runs SET status=?,error=?,updated=? WHERE id=?').run(status,error,stamp(),id);return true;},
    getSetting:({key,fallback})=>getSetting(key,fallback),setSetting:({key,value})=>{setSetting(key,value);return true;},
    attachmentAdd:({record,name,data})=>{if(!get(record))throw new Error('先保存记录再添加附件');requireText(name,200);requireText(data,15000000);const id=randomUUID();db.prepare('INSERT INTO attachments VALUES(?,?,?,?,?)').run(id,record,name,data,stamp());return id;},
    attachments:({record})=>db.prepare('SELECT id,name,created FROM attachments WHERE record=?').all(record),
    attachment:({id})=>db.prepare('SELECT * FROM attachments WHERE id=?').get(id),
    ...createAgentStore(db,get),
    ...conversationStore(db,get,save),
    updateMessageContext:({id,context})=>{db.prepare('UPDATE messages SET context=? WHERE id=?').run(JSON.stringify(context),id);return true;},
    exportBackup,restoreBackup,
    close:()=>db.close()
  };Object.assign(api,externalStore(db,api));return api;
}
