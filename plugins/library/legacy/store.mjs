import {externalDDL,externalStore,imageType} from './external-store.mjs';
import {agentDDL,createAgentStore,memoryDefaults} from './agent-store.mjs';
import {migrateConversations,conversationStore} from './conversations.mjs';
import {validDay} from './wiki-import.mjs';
import {attachmentImageIds} from './image-references.mjs';
import {importDDL,importWiki} from './import-store.mjs';
import Database from './sqlite.mjs';
import {randomUUID,createHash} from 'node:crypto';
import {mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {kinds,origins,plainDoc,readDoc,changes,dateRange,dateKey,toMarkdown,count} from './content.mjs';
import {updateMarkdownDoc,markdownSource,markdownSegments} from './markdown.mjs';
import {createMobileSyncStore} from '../src/sync/store.mjs';
import {contentHash} from '../src/sync/canonical.mjs';
const stamp=()=>new Date().toISOString();
const parse=s=>JSON.parse(s);
const requireText=(s,max=500)=>{if(typeof s!=='string'||s.length>max)throw new Error('输入格式或长度不正确');return s;};
export function createStore(path,{recover=true}={}) {
  mkdirSync(dirname(path),{recursive:true});
  const db=new Database(path);db.pragma('journal_mode = WAL');db.pragma('foreign_keys = ON');db.pragma('busy_timeout = 5000');
  const existing=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'").get();
  if(existing){const schema=db.prepare("SELECT value FROM meta WHERE key='schema'").get();if(schema&&!['1','2','3','4','5','6','7','8'].includes(schema.value)){db.close();throw new Error('数据库版本不受当前应用支持，请使用更新版本');}}
  if(existing&&db.prepare("SELECT value FROM meta WHERE key='schema'").get()?.value!=='8'){
    // SQLite's own snapshot includes WAL; never copy a live database file alone.
    db.prepare('VACUUM INTO ?').run(path+'.before-agent-v4-'+Date.now()+'.sqlite');
  }
  db.exec(`CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS records(id TEXT PRIMARY KEY,kind TEXT NOT NULL,title TEXT NOT NULL,doc TEXT NOT NULL,body TEXT NOT NULL,origin TEXT NOT NULL,url TEXT NOT NULL DEFAULT '',annotation TEXT NOT NULL DEFAULT '',stage TEXT NOT NULL DEFAULT 'draft',revision INTEGER NOT NULL,created TEXT NOT NULL,updated TEXT NOT NULL,deleted INTEGER NOT NULL DEFAULT 0,processing TEXT NOT NULL DEFAULT 'unknown',created_by_device TEXT);
  CREATE TABLE IF NOT EXISTS annotation_relations(record_id TEXT PRIMARY KEY REFERENCES records(id), original_id TEXT NOT NULL REFERENCES records(id), version_id TEXT NOT NULL REFERENCES versions(id), content_hash TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS links(article TEXT NOT NULL REFERENCES records(id),material TEXT NOT NULL REFERENCES records(id),PRIMARY KEY(article,material));
  CREATE TABLE IF NOT EXISTS versions(id TEXT PRIMARY KEY,record TEXT NOT NULL REFERENCES records(id),revision INTEGER NOT NULL,doc TEXT NOT NULL,title TEXT NOT NULL,at TEXT NOT NULL,reason TEXT NOT NULL,UNIQUE(record,revision));
  CREATE TABLE IF NOT EXISTS edits(id TEXT PRIMARY KEY,record TEXT NOT NULL REFERENCES records(id),at TEXT NOT NULL,origin TEXT NOT NULL,added INTEGER NOT NULL,removed INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY,result TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS memories(id TEXT PRIMARY KEY,scope TEXT NOT NULL,body TEXT NOT NULL,created TEXT NOT NULL,updated TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,thread TEXT NOT NULL,role TEXT NOT NULL,body TEXT NOT NULL,status TEXT NOT NULL,created TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,thread TEXT NOT NULL,status TEXT NOT NULL,model TEXT NOT NULL,error TEXT NOT NULL DEFAULT '',created TEXT NOT NULL,updated TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS attachments(id TEXT PRIMARY KEY,record TEXT NOT NULL REFERENCES records(id),name TEXT NOT NULL,data TEXT NOT NULL,created TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS workbench_image_stages(id TEXT PRIMARY KEY,name TEXT NOT NULL,data TEXT NOT NULL,digest TEXT NOT NULL,created TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS workbench_image_receipts(id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,result TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS workbench_drafts(slot TEXT PRIMARY KEY,revision INTEGER NOT NULL,payload TEXT NOT NULL);
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
  // Sync identity is stored inside this database. Opening an existing database
  // creates one stable identity; opening a new database never inherits it.
  db.exec(`CREATE TABLE IF NOT EXISTS sync_changes(
    seq INTEGER PRIMARY KEY AUTOINCREMENT, change_id TEXT NOT NULL UNIQUE,
    record_id TEXT NOT NULL, version_id TEXT, action TEXT NOT NULL,
    revision INTEGER NOT NULL, payload TEXT NOT NULL, links TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL,operation_fingerprint TEXT
  );
  CREATE INDEX IF NOT EXISTS sync_changes_record_seq ON sync_changes(record_id,seq);
  CREATE TABLE IF NOT EXISTS sync_activities(
    activity_id TEXT PRIMARY KEY, record_id TEXT NOT NULL, change_id TEXT NOT NULL,
    origin_device_id TEXT, occurred_at TEXT NOT NULL, time_zone TEXT NOT NULL,
    before_hash TEXT NOT NULL, after_hash TEXT NOT NULL, after_segments TEXT NOT NULL,
    action TEXT NOT NULL, authorship TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sync_record_sources(
    record_id TEXT PRIMARY KEY, markdown TEXT NOT NULL, sources TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sync_version_sources(
    version_id TEXT PRIMARY KEY, markdown TEXT NOT NULL, sources TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sync_version_parents(version_id TEXT PRIMARY KEY, parents TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS sync_branches(
    branch_id TEXT PRIMARY KEY,record_id TEXT NOT NULL,state TEXT NOT NULL,source_server_id TEXT NOT NULL,
    source_epoch TEXT NOT NULL,source_device_id TEXT NOT NULL,manifest_digest TEXT NOT NULL,payload TEXT NOT NULL,
    created_at TEXT NOT NULL,updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sync_branch_blobs(
    branch_id TEXT NOT NULL,attachment_id TEXT NOT NULL,name TEXT NOT NULL,digest TEXT NOT NULL,byte_length INTEGER NOT NULL,data BLOB NOT NULL,
    PRIMARY KEY(branch_id,attachment_id),FOREIGN KEY(branch_id) REFERENCES sync_branches(branch_id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS sync_provenance(
    record_id TEXT PRIMARY KEY, payload TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sync_journal_inputs(version_id TEXT PRIMARY KEY,record_id TEXT NOT NULL,payload TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS sync_receipts(
    operation_id TEXT PRIMARY KEY, device_id TEXT NOT NULL, fingerprint TEXT NOT NULL, status TEXT NOT NULL,
    result TEXT NOT NULL, created_at TEXT NOT NULL, epoch TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sync_acks(
    device_id TEXT PRIMARY KEY, applied_cursor INTEGER NOT NULL DEFAULT 0,
    complete_cursor INTEGER NOT NULL DEFAULT 0, manifest_digest TEXT NOT NULL DEFAULT '',
    acknowledged_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sync_snapshots(
    id TEXT PRIMARY KEY, high_watermark INTEGER NOT NULL, manifest TEXT NOT NULL,
    created_at TEXT NOT NULL, expires_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sync_manifests(
    digest TEXT PRIMARY KEY, high_watermark INTEGER NOT NULL, epoch TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sync_setups(
    id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,request_fingerprint TEXT NOT NULL,mode TEXT NOT NULL,
    library_id TEXT NOT NULL,source_epoch TEXT,manifest_digest TEXT NOT NULL,manifest TEXT NOT NULL,
    expected_library_id TEXT,expected_epoch TEXT,target_generation INTEGER NOT NULL,target_cursor INTEGER NOT NULL DEFAULT 0,fencing_token INTEGER NOT NULL,
    lease_expires_at TEXT NOT NULL,state TEXT NOT NULL,result TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sync_setup_items(
    setup_id TEXT NOT NULL,entity_type TEXT NOT NULL,ordinal INTEGER NOT NULL,digest TEXT NOT NULL,payload TEXT NOT NULL,
    PRIMARY KEY(setup_id,entity_type,ordinal),FOREIGN KEY(setup_id) REFERENCES sync_setups(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS sync_setup_blobs(
    setup_id TEXT NOT NULL,attachment_id TEXT NOT NULL,record_id TEXT NOT NULL,name TEXT NOT NULL,branch_id TEXT NOT NULL DEFAULT '',
    digest TEXT NOT NULL,byte_length INTEGER NOT NULL,data BLOB NOT NULL,
    PRIMARY KEY(setup_id,attachment_id,branch_id),FOREIGN KEY(setup_id) REFERENCES sync_setups(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS sync_reconciliations(
    id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,request_fingerprint TEXT NOT NULL,mode TEXT NOT NULL,
    library_id TEXT NOT NULL,source_epoch TEXT,target_epoch TEXT NOT NULL,manifest_digest TEXT NOT NULL,
    state TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,result TEXT,
    source_device_id TEXT,operation_count INTEGER NOT NULL DEFAULT 0,target_generation INTEGER NOT NULL DEFAULT 0,
    target_cursor INTEGER NOT NULL DEFAULT 0,fencing_token INTEGER NOT NULL DEFAULT 0,lease_expires_at TEXT,metadata TEXT NOT NULL DEFAULT '{}'
  );
  CREATE TABLE IF NOT EXISTS sync_reconciliation_items(
    task_id TEXT NOT NULL,item_id TEXT NOT NULL,digest TEXT NOT NULL,payload TEXT NOT NULL,ordinal INTEGER NOT NULL DEFAULT 0,entity_type TEXT NOT NULL DEFAULT 'operations',
    PRIMARY KEY(task_id,item_id),FOREIGN KEY(task_id) REFERENCES sync_reconciliations(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS sync_reconciliation_blobs(
    task_id TEXT NOT NULL,attachment_id TEXT NOT NULL,branch_id TEXT NOT NULL DEFAULT '',record_id TEXT NOT NULL,name TEXT NOT NULL,
    digest TEXT NOT NULL,byte_length INTEGER NOT NULL,data BLOB NOT NULL,PRIMARY KEY(task_id,attachment_id,branch_id),
    FOREIGN KEY(task_id) REFERENCES sync_reconciliations(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS sync_staged_blobs(
    owner_id TEXT NOT NULL,device_id TEXT NOT NULL,attachment_id TEXT NOT NULL,record_id TEXT NOT NULL,name TEXT NOT NULL,
    digest TEXT NOT NULL,byte_length INTEGER NOT NULL,data BLOB NOT NULL,created_at TEXT NOT NULL,
    PRIMARY KEY(owner_id,device_id,attachment_id)
  );
  CREATE TABLE IF NOT EXISTS sync_snapshot_items(
    snapshot_id TEXT NOT NULL, entity_type TEXT NOT NULL, ordinal INTEGER NOT NULL,
    payload TEXT NOT NULL, PRIMARY KEY(snapshot_id,entity_type,ordinal),
    FOREIGN KEY(snapshot_id) REFERENCES sync_snapshots(id) ON DELETE CASCADE
  );`);
  const recordColumns=db.prepare('PRAGMA table_info(records)').all().map(x=>x.name);
  if(!recordColumns.includes('processing'))db.exec("ALTER TABLE records ADD COLUMN processing TEXT NOT NULL DEFAULT 'unknown'");
  if(!recordColumns.includes('created_by_device'))db.exec('ALTER TABLE records ADD COLUMN created_by_device TEXT');
  const changeColumns=db.prepare('PRAGMA table_info(sync_changes)').all().map(x=>x.name);
  if(!changeColumns.includes('links'))db.exec("ALTER TABLE sync_changes ADD COLUMN links TEXT NOT NULL DEFAULT '[]'");
  if(!changeColumns.includes('operation_fingerprint'))db.exec('ALTER TABLE sync_changes ADD COLUMN operation_fingerprint TEXT');
  db.prepare("INSERT OR IGNORE INTO meta(key,value) VALUES('sync_library_id',?)").run(randomUUID());
  db.prepare("INSERT OR IGNORE INTO meta(key,value) VALUES('sync_epoch',?)").run(randomUUID());
  db.prepare("INSERT OR IGNORE INTO meta(key,value) VALUES('sync_server_id',?)").run(randomUUID());
  const receiptColumns=db.prepare('PRAGMA table_info(sync_receipts)').all().map(x=>x.name);
  if(!receiptColumns.includes('epoch'))db.exec("ALTER TABLE sync_receipts ADD COLUMN epoch TEXT NOT NULL DEFAULT ''");
  const setupColumns=db.prepare('PRAGMA table_info(sync_setups)').all().map(x=>x.name);
  if(setupColumns.length&&!setupColumns.includes('target_cursor'))db.exec('ALTER TABLE sync_setups ADD COLUMN target_cursor INTEGER NOT NULL DEFAULT 0');
  const reconcileColumns=db.prepare('PRAGMA table_info(sync_reconciliations)').all().map(x=>x.name);
  const setupBlobColumns=db.prepare('PRAGMA table_info(sync_setup_blobs)').all().map(x=>x.name);if(setupBlobColumns.length&&!setupBlobColumns.includes('branch_id'))db.exec("ALTER TABLE sync_setup_blobs ADD COLUMN branch_id TEXT NOT NULL DEFAULT ''");
  const migrateBlobIdentity=(table,parentColumn,parentTable)=>{
    const columns=db.prepare(`PRAGMA table_info(${table})`).all(),primary=columns.filter(x=>x.pk>0).sort((a,b)=>a.pk-b.pk).map(x=>x.name).join(',');
    if(primary===`${parentColumn},attachment_id,branch_id`&&columns.find(x=>x.name==='branch_id')?.notnull)return;
    const temp=`${table}_v2`;
    db.exec(`CREATE TABLE ${temp}(${parentColumn} TEXT NOT NULL,attachment_id TEXT NOT NULL,branch_id TEXT NOT NULL DEFAULT '',record_id TEXT NOT NULL,name TEXT NOT NULL,digest TEXT NOT NULL,byte_length INTEGER NOT NULL,data BLOB NOT NULL,PRIMARY KEY(${parentColumn},attachment_id,branch_id),FOREIGN KEY(${parentColumn}) REFERENCES ${parentTable}(id) ON DELETE CASCADE)`);
    db.exec(`INSERT OR IGNORE INTO ${temp} SELECT ${parentColumn},attachment_id,COALESCE(branch_id,''),record_id,name,digest,byte_length,data FROM ${table}`);
    db.exec(`DROP TABLE ${table}; ALTER TABLE ${temp} RENAME TO ${table}`);
  };
  migrateBlobIdentity('sync_setup_blobs','setup_id','sync_setups');
  const reconcileBlobColumns=db.prepare('PRAGMA table_info(sync_reconciliation_blobs)').all().map(x=>x.name);if(reconcileBlobColumns.length&&!reconcileBlobColumns.includes('branch_id'))db.exec("ALTER TABLE sync_reconciliation_blobs ADD COLUMN branch_id TEXT NOT NULL DEFAULT ''");
  migrateBlobIdentity('sync_reconciliation_blobs','task_id','sync_reconciliations');
  for(const [name,definition] of Object.entries({source_device_id:'TEXT',operation_count:'INTEGER NOT NULL DEFAULT 0',target_generation:'INTEGER NOT NULL DEFAULT 0',target_cursor:'INTEGER NOT NULL DEFAULT 0',fencing_token:'INTEGER NOT NULL DEFAULT 0',lease_expires_at:'TEXT',metadata:"TEXT NOT NULL DEFAULT '{}'"}))if(reconcileColumns.length&&!reconcileColumns.includes(name))db.exec(`ALTER TABLE sync_reconciliations ADD COLUMN ${name} ${definition}`);
  const reconcileItemColumns=db.prepare('PRAGMA table_info(sync_reconciliation_items)').all().map(x=>x.name);if(reconcileItemColumns.length&&!reconcileItemColumns.includes('ordinal'))db.exec('ALTER TABLE sync_reconciliation_items ADD COLUMN ordinal INTEGER NOT NULL DEFAULT 0');if(reconcileItemColumns.length&&!reconcileItemColumns.includes('entity_type'))db.exec("ALTER TABLE sync_reconciliation_items ADD COLUMN entity_type TEXT NOT NULL DEFAULT 'operations'");
  for(const version of db.prepare('SELECT id,record FROM versions ORDER BY record,revision,id').all())if(!db.prepare('SELECT 1 FROM sync_version_parents WHERE version_id=?').get(version.id)){const previous=db.prepare('SELECT id FROM versions WHERE record=? AND revision<(SELECT revision FROM versions WHERE id=?) ORDER BY revision DESC LIMIT 1').get(version.record,version.id);db.prepare('INSERT INTO sync_version_parents VALUES(?,?)').run(version.id,JSON.stringify(previous?[previous.id]:[]));}
  db.prepare("UPDATE sync_receipts SET epoch=? WHERE epoch='' ").run(db.prepare("SELECT value FROM meta WHERE key='sync_epoch'").get().value);
  const memoryColumns=db.prepare('PRAGMA table_info(memories)').all().map(c=>c.name);
  for(const [name,value] of Object.entries(memoryDefaults))if(!memoryColumns.includes(name))db.exec(`ALTER TABLE memories ADD COLUMN ${name} ${typeof value==='number'?'INTEGER':'TEXT'} NOT NULL DEFAULT ${typeof value==='number'?value:JSON.stringify(value).replaceAll('\"',"'")}`);
  db.prepare("UPDATE memories SET category='project' WHERE scope!='global' AND category='memory'").run();
  db.transaction(()=>{migrateConversations(db);db.prepare("INSERT INTO meta VALUES ('schema','8') ON CONFLICT(key) DO UPDATE SET value='8'").run();})();
  // Never open a partially restored annotation graph as if it were complete.
  try{const children=db.prepare("SELECT id,origin FROM records WHERE kind='ai_annotation'").all(),relations=db.prepare('SELECT * FROM annotation_relations').all(),ids=new Set();for(const rel of relations){const child=db.prepare('SELECT kind,origin FROM records WHERE id=?').get(rel.record_id),parent=db.prepare('SELECT kind FROM records WHERE id=?').get(rel.original_id),version=db.prepare('SELECT record,doc FROM versions WHERE id=?').get(rel.version_id);if(ids.has(rel.record_id)||!child||child.kind!=='ai_annotation'||child.origin!=='ai'||!parent||parent.kind==='ai_annotation'||!version||version.record!==rel.original_id||createHash('sha256').update(markdownSource(parse(version.doc))).digest('hex')!==rel.content_hash)throw Error('资料库批注关联不完整或损坏');ids.add(rel.record_id);}if(children.some(row=>!ids.has(row.id)))throw Error('资料库批注关联不完整或损坏');}catch(error){db.close();throw error;}
  if(recover)db.prepare("UPDATE runs SET status='interrupted',updated=? WHERE status='running'").run(stamp());
  if(recover)db.prepare("UPDATE messages SET status='interrupted' WHERE status='streaming'").run();
  const importInfo=id=>{const row=db.prepare('SELECT * FROM imports WHERE record=?').get(id);return row?{...row,metadata:parse(row.metadata),links:parse(row.links)}:null;};
  const annotationOf=id=>{const r=db.prepare('SELECT original_id,version_id,content_hash FROM annotation_relations WHERE record_id=?').get(id);return r?{recordId:r.original_id,versionId:r.version_id,contentHash:r.content_hash}:null;};
  const decode=r=>r?{...r,...(r.kind==='ai_annotation'?{annotationOf:annotationOf(r.id)}:{}),externalSources:db.prepare('SELECT * FROM external_sources WHERE record=? ORDER BY at DESC,rowid DESC').all(r.id),dateInfo:db.prepare('SELECT * FROM record_dates WHERE record=?').get(r.id)??null,importInfo:importInfo(r.id),doc:parse(r.doc),sourceIds:db.prepare('SELECT material FROM links WHERE article=?').all(r.id).map(x=>x.material)}:null;
  // Use content dates for both the desktop list and Agent search. An explicit
  // unknown date stays unknown; editing/import timestamps must not promote it.
  const effectiveDay=r=>r.imported?r.import_day:r.dated?r.content_day:dateKey(r.created);
  const descending=(a,b)=>a===b?0:a>b?-1:1;
  const orderedRecords=()=>db.prepare(`SELECT r.*,i.day AS import_day,i.record AS imported,d.day AS content_day,d.record AS dated FROM records r LEFT JOIN imports i ON i.record=r.id LEFT JOIN record_dates d ON d.record=r.id WHERE r.deleted=0 AND r.kind<>'ai_annotation'`).all()
    .map(r=>({...r,contentDay:effectiveDay(r)}))
    .sort((a,b)=>descending(a.contentDay??'',b.contentDay??'')||descending(a.created,b.created)||descending(a.id,b.id));
  const journalForDay=day=>orderedRecords().find(row=>row.kind==='journal'&&row.contentDay===day);
  const assertJournalDay=(id,day)=>{
    const row=get(id);if(row?.kind!=='journal')return;
    if(!day||validDay(day)!==day)throw new Error('日记必须有有效的内容日期');
    const other=journalForDay(day);if(other&&other.id!==id)throw new Error('这一天已有日记，请打开当天日记继续编辑');
  };
  const get=id=>{const row=decode(db.prepare('SELECT * FROM records WHERE id=?').get(id));return row?{...row,contentDay:row.importInfo?row.importInfo.day:row.dateInfo?row.dateInfo.day:dateKey(row.created)}:null;};
  const hash=value=>createHash('sha256').update(value).digest('hex');
  const syncMeta=key=>db.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value;
  const syncSegments=row=>markdownSegments(row.doc,row.origin);
  const syncRecord=(id,{preserveSources=true}={})=>{
    const row=get(id);if(!row)return null;
    const day=row.contentDay;
    const dateBasis=row.importInfo?.date_basis??row.dateInfo?.basis??'created';
    const sourceIds=row.sourceIds??[],markdown=markdownSource(row.doc),generatedSources=syncSegments(row);
    const storedSources=preserveSources?db.prepare('SELECT markdown,sources FROM sync_record_sources WHERE record_id=?').get(id):null;
    const sources=storedSources?.markdown===markdown?parse(storedSources.sources):generatedSources;
    const attachmentDescriptors=db.prepare('SELECT id,name,data FROM attachments WHERE record=? ORDER BY id').all(id).map(a=>{
      const bytes=Buffer.from(a.data,'base64');return {id:a.id,hash:hash(bytes),byteLength:bytes.length,name:a.name};
    });
    return {id:row.id,kind:row.kind,title:row.title,markdown,origin:row.origin,...(row.kind==='ai_annotation'?{annotationOf:row.annotationOf}:{}),
      processing:row.processing??'unknown',contentDay:day,dateBasis,
      url:row.url,annotation:row.annotation,stage:row.stage,sourceIds,sources,
      attachmentDescriptors,createdAt:row.created,updatedAt:row.updated,deleted:Boolean(row.deleted),createdByDevice:row.created_by_device??null};
  };
  const bumpSyncRevision=(id,reason)=>{
    const previous=db.prepare('SELECT id FROM versions WHERE record=? ORDER BY revision DESC LIMIT 1').get(id);
    db.prepare('UPDATE records SET revision=revision+1,updated=? WHERE id=?').run(stamp(),id);
    const row=get(id),versionId=randomUUID();db.prepare('INSERT INTO versions VALUES(?,?,?,?,?,?,?)').run(versionId,id,row.revision,JSON.stringify(row.doc),row.title,row.updated,reason);db.prepare('INSERT INTO sync_version_parents VALUES(?,?)').run(versionId,JSON.stringify(previous?[previous.id]:[]));
    return row;
  };
  const addCurrentVersion=(id,reason)=>{const previous=db.prepare('SELECT id FROM versions WHERE record=? ORDER BY revision DESC LIMIT 1').get(id),row=get(id),versionId=randomUUID();db.prepare('INSERT INTO versions VALUES(?,?,?,?,?,?,?)').run(versionId,id,row.revision,JSON.stringify(row.doc),row.title,row.updated,reason);db.prepare('INSERT INTO sync_version_parents VALUES(?,?)').run(versionId,JSON.stringify(previous?[previous.id]:[]));return row;};
  const appendSyncChange=(id,action,{activityOrigin=null,createActivity=true,changeId:fixedChangeId,versionId:fixedVersionId,operationFingerprint=null,activities=[],preserveSources=false}={})=>{
    const legacy=get(id),row=syncRecord(id,{preserveSources});if(!row||!legacy)return null;
    const revision=legacy.revision,version=db.prepare('SELECT id FROM versions WHERE record=? AND revision=?').get(id,revision);
    const changeId=fixedChangeId??randomUUID(),at=stamp(),payload=JSON.stringify(row);
    const links=db.prepare('SELECT article,material FROM links WHERE article=? ORDER BY material').all(id).map(link=>({articleId:link.article,materialId:link.material}));
    const info=db.prepare('INSERT INTO sync_changes(change_id,record_id,version_id,action,revision,payload,links,created_at,operation_fingerprint) VALUES(?,?,?,?,?,?,?,?,?)').run(changeId,id,fixedVersionId??version?.id??null,action,revision,payload,JSON.stringify(links),at,operationFingerprint);
    db.prepare('INSERT INTO sync_record_sources VALUES(?,?,?,?) ON CONFLICT(record_id) DO UPDATE SET markdown=excluded.markdown,sources=excluded.sources,updated_at=excluded.updated_at').run(id,row.markdown,JSON.stringify(row.sources),at);
    if(version)db.prepare('INSERT INTO sync_version_sources VALUES(?,?,?) ON CONFLICT(version_id) DO UPDATE SET markdown=excluded.markdown,sources=excluded.sources').run(version.id,row.markdown,JSON.stringify(row.sources));
    for(const activity of activities)db.prepare('INSERT INTO sync_activities VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(activity.activityId,id,changeId,activity.originDeviceId,activity.occurredAt,activity.timeZone,activity.beforeHash,activity.afterHash,JSON.stringify(activity.afterSegments),activity.action,activity.authorship);
    if(!activities.length&&createActivity&&['create','update','restore'].includes(action)){
      const old=db.prepare('SELECT payload FROM sync_changes WHERE record_id=? AND seq<? ORDER BY seq DESC LIMIT 1').get(id,Number(info.lastInsertRowid));
      const before=old?parse(old.payload):null;
      if(!before||before.markdown!==row.markdown){
        const beforeText=before?.markdown??'',segments=row.sources;
        db.prepare('INSERT INTO sync_activities VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(randomUUID(),id,changeId,null,at,Intl.DateTimeFormat().resolvedOptions().timeZone,contentHash(beforeText,before?.sources??[]),contentHash(row.markdown,segments),JSON.stringify(segments),action==='restore'?'restore':'write',activityOrigin??row.origin);
      }
    }
    return {seq:Number(info.lastInsertRowid),changeId,versionId:version?.id??null,record:row};
  };
  const getSetting=(key,fallback=null)=>{const r=db.prepare('SELECT value FROM settings WHERE key=?').get(key);return r?parse(r.value):fallback;};
  const setSetting=(key,value)=>db.prepare('INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,JSON.stringify(value));
  function consolidateJournals(){
    return db.transaction(()=>{
      const days=new Set();let merged=0;
      for(const summary of orderedRecords().filter(row=>row.kind==='journal'&&row.contentDay)){
        if(!days.has(summary.contentDay)){days.add(summary.contentDay);continue;}
        const duplicate=get(summary.id),target=journalForDay(summary.contentDay);
        const images=new Map(db.prepare('SELECT * FROM attachments WHERE record=?').all(duplicate.id).map(image=>[image.id,image]));
        for(const link of duplicate.importInfo?.links??[])if(link.attachment&&!images.has(link.attachment)){
          const image=db.prepare('SELECT * FROM attachments WHERE id=?').get(link.attachment);if(image)images.set(image.id,image);
        }
        const replacements=new Map(),copies=[...images.values()].map(image=>{const id=randomUUID();replacements.set(image.id,id);return {...image,id};});
        const doc=structuredClone(duplicate.doc);
        const rewrite=node=>{
          if(typeof node.text==='string'){
            for(const [old,id] of replacements)node.text=node.text.replaceAll(`attachment:${old}`,`attachment:${id}`);
            for(const link of duplicate.importInfo?.links??[]){const id=replacements.get(link.attachment);if(!id)continue;
              node.text=node.text.replaceAll(`](${link.target})`,`](attachment:${id})`).replaceAll(`](${link.target} `,`](attachment:${id} `)
                .replaceAll(`![[${link.target}]]`,`![${link.target}](attachment:${id})`);
              const prefix=`![[${link.target}|`;let start=node.text.indexOf(prefix);
              while(start>=0){const end=node.text.indexOf(']]',start+prefix.length);if(end<0)break;const label=node.text.slice(start+prefix.length,end);node.text=node.text.slice(0,start)+`![${label}](attachment:${id})`+node.text.slice(end+2);start=node.text.indexOf(prefix,start+1);}
            }
          }
          for(const child of node.content??[])rewrite(child);
        };rewrite(doc);
        // Preserve the old record, versions and original attachments in the recycle
        // bin. The active diary receives copies, including each span's authorship.
        api.remove({id:duplicate.id,revision:duplicate.revision});
        save({kind:'journal',day:summary.contentDay,doc,origin:duplicate.origin,reason:'合并同日日记'},
          {inTransaction:true,archive:true,beforeSync:row=>{
            for(const image of copies)db.prepare('INSERT INTO attachments VALUES(?,?,?,?,?)').run(image.id,row.id,image.name,image.data,image.created);
            for(const table of ['external_sources','record_sources'])for(const source of db.prepare(`SELECT * FROM ${table} WHERE record=?`).all(duplicate.id)){
              source.id=randomUUID();source.record=row.id;const columns=Object.keys(source);db.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(()=>'?').join(',')})`).run(...columns.map(key=>source[key]));
            }
            for(const source of db.prepare('SELECT * FROM dsh_record_sources WHERE record=?').all(duplicate.id))db.prepare('INSERT OR IGNORE INTO dsh_record_sources VALUES(?,?,?,?,?)').run(row.id,source.session_id,source.message_id,source.role,source.excerpt);
            for(const link of db.prepare('SELECT article FROM links WHERE material=?').all(duplicate.id))db.prepare('INSERT OR IGNORE INTO links VALUES(?,?)').run(link.article,target.id);
            db.prepare('DELETE FROM links WHERE material=?').run(duplicate.id);
          }});
        merged++;
      }
      return merged;
    })();
  }
  function save(input,{inTransaction=false,archive=false,beforeDoc,sync=true,versionId,changeId,activities=[],createdByDevice=null,allowCreateWithId=false,allowKindChange=false,syncAction,parentVersionIds,beforeSync,allowAnnotation=false}={}) {
    const operation=()=>{
      const op=input.opId;
      if(op){requireText(op,100);const prior=db.prepare('SELECT result FROM operations WHERE id=?').get(op);if(prior)return parse(prior.result);}
      let old=input.id?get(requireText(input.id,100)):null;
      if(input.id&&(!old||old.deleted)&&!(allowCreateWithId&&!old))throw new Error('记录不存在或已删除');
      if(old&&input.revision!==old.revision)throw new Error('内容已被更新，请重新打开后再保存。你的草稿仍保留在编辑区。');
      const kind=input.kind??old?.kind??'freewrite';if((kind==='ai_annotation'||old?.kind==='ai_annotation')&&!allowAnnotation)throw new Error('批注只能通过专用接口修改');if(!kinds.includes(kind)&&!(allowAnnotation&&kind==='ai_annotation'))throw new Error('无效的内容类型');
      const journalDay=kind==='journal'?(input.day??old?.contentDay??dateKey(stamp())):null;
      if(journalDay!==null&&validDay(journalDay)!==journalDay)throw new Error('请输入有效日记日期');
      const daily=kind==='journal'?journalForDay(journalDay):null;
      const appendDaily=!input.id&&daily;
      if(appendDaily)old=get(daily.id);
      else if(daily&&daily.id!==old?.id&&daily.id!==input.id)throw new Error('这一天已有日记，请打开当天日记继续编辑');
      if(old&&old.kind!==kind&&!allowKindChange)throw new Error('已保存内容的类型不能在编辑时改变');
      const origin=old?.origin??(kind==='ai_annotation'?'ai':archive?input.origin:(kind==='web'?'external':kind==='ai'?'ai':'personal'));if(!origins.includes(origin))throw new Error('无效来源');
      const incoming=structuredClone(input.doc??plainDoc(input.body??'',archive?input.origin:origin));
      if(appendDaily&&!readDoc(incoming,archive?input.origin:origin).text.trim())throw new Error('先写下一些内容再保存');
      if(appendDaily){const incomingOrigin=archive?input.origin:'personal';const attribute=node=>{if(node.type==='text'&&!node.marks?.some(mark=>mark.type==='provenance'))node.marks=[...(node.marks??[]),{type:'provenance',attrs:{origin:incomingOrigin}}];for(const child of node.content??[])attribute(child);};attribute(incoming);}
      const doc=appendDaily?{type:'doc',content:[...old.doc.content,{type:'paragraph',content:[]},...incoming.content]}:input.doc??old?.doc??incoming;const {text,groups}=readDoc(doc,origin);
      if(markdownSource(doc).length>1000000)throw new Error('单篇内容超过大小限制，请缩短内容后重试');
      if(!text.trim()&&kind!=='article')throw new Error('先写下一些内容再保存');
      const title=requireText((appendDaily?old.title:input.title)??old?.title??'',200).trim()||text.split('\n')[0].slice(0,32)||'未命名文章';
      const url=requireText(input.url??old?.url??'',2048);if(url&&!/^https?:\/\//.test(url))throw new Error('来源地址必须是 HTTP 或 HTTPS 链接');
      const annotation=requireText(input.annotation??old?.annotation??'',10000);
      const stage=input.stage??old?.stage??'draft';if(!['idea','draft','revision','final'].includes(stage))throw new Error('无效的文章阶段');
      const id=old?.id??input.id??randomUUID(),at=stamp(),revision=(old?.revision??0)+1,previousVersion=old?db.prepare('SELECT id FROM versions WHERE record=? ORDER BY revision DESC LIMIT 1').get(old.id):null;
      db.prepare(`INSERT INTO records(id,kind,title,doc,body,origin,url,annotation,stage,revision,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,title=excluded.title,doc=excluded.doc,body=excluded.body,url=excluded.url,annotation=excluded.annotation,stage=excluded.stage,revision=excluded.revision,updated=excluded.updated`).run(id,kind,title,JSON.stringify(doc),text,origin,url,annotation,stage,revision,old?.created??at,at);
      if(kind==='journal')db.prepare('INSERT INTO record_dates(record,day,basis) VALUES(?,?,?) ON CONFLICT(record) DO UPDATE SET day=excluded.day,basis=excluded.basis').run(id,journalDay,'日记内容日期');
      const before=old?readDoc(beforeDoc??old.doc,old.origin).groups:Object.fromEntries(origins.map(x=>[x,'']));
      for(const source of origins){const delta=archive?{added:0,removed:0}:changes(before[source],groups[source]);if(delta.added||delta.removed)db.prepare('INSERT INTO edits VALUES(?,?,?,?,?,?)').run(randomUUID(),id,at,source,delta.added,delta.removed);}
      const savedVersionId=versionId??randomUUID(),parents=parentVersionIds??(previousVersion?[previousVersion.id]:[]);
      if(!Array.isArray(parents)||parents.some(parent=>typeof parent!=='string'||parent===savedVersionId))throw new Error('版本父链无效');
      db.prepare('INSERT INTO versions VALUES(?,?,?,?,?,?,?)').run(savedVersionId,id,revision,JSON.stringify(doc),title,at,requireText(input.reason??'保存',100));
      db.prepare('INSERT INTO sync_version_parents(version_id,parents) VALUES(?,?)').run(savedVersionId,JSON.stringify([...new Set(parents)]));
      if(input.sourceIds!==undefined){if(kind!=='article'||!Array.isArray(input.sourceIds))throw new Error('素材关联格式不正确');db.prepare('DELETE FROM links WHERE article=?').run(id);for(const sourceId of new Set(input.sourceIds)){const source=get(sourceId);if(!source||['article','ai_annotation'].includes(source.kind)||source.deleted&&!old?.sourceIds.includes(sourceId))throw new Error('关联素材不存在');db.prepare('INSERT INTO links VALUES(?,?)').run(id,sourceId);}}else if(old?.kind==='article'&&kind!=='article')db.prepare('DELETE FROM links WHERE article=?').run(id);
      if(getSetting('editingDraft')?.id===id)db.prepare("DELETE FROM settings WHERE key='editingDraft'").run();
      const result=get(id);beforeSync?.(result);if(sync)appendSyncChange(id,syncAction??(old?'update':'create'),{activityOrigin:archive?null:undefined,createActivity:!archive,changeId,versionId,activities});if(op)db.prepare('INSERT INTO operations VALUES(?,?)').run(op,JSON.stringify(result));return result;
    };return inTransaction?operation():db.transaction(operation)();
  }
  // Shared mutation boundary. The trusted caller fixes the origin of newly added text.
  function updateRecord(input,{addedOrigin='personal',operationId,beforeSync,allowOriginCorrection=false}={}) {
    const fields=['kind','title','body','day','url','annotation','stage','sourceIds',...(allowOriginCorrection?['origin']:[])];
    if(!input||Object.keys(input).some(key=>!['id','revision',...fields].includes(key)))throw new Error('无效的修改字段');
    requireText(input.id,100);if(!Number.isInteger(input.revision)||input.revision<1)throw new Error('版本无效');
    if(!fields.some(key=>input[key]!==undefined))throw new Error('请提供要修改的字段');
    if(!['personal','ai'].includes(addedOrigin))throw new Error('无效的编辑来源');
    const fingerprint=createHash('sha256').update(JSON.stringify([addedOrigin,...['id','revision',...fields].map(key=>[key,input[key]])])).digest('hex');
    return db.transaction(()=>{
      if(operationId){requireText(operationId,100);const prior=db.prepare('SELECT result FROM operations WHERE id=?').get(operationId);if(prior){const result=parse(prior.result);if(result.fingerprint!==fingerprint)throw new Error('重复操作的参数不一致');return result.record;}}
      const old=get(input.id);if(!old||old.deleted)throw new Error('记录不存在或已删除');if(old.kind==='ai_annotation')throw new Error('批注只能通过专用接口修改');
      if(input.revision!==old.revision)throw new Error('内容已被更新，请重新读取后再修改');
      const kind=input.kind??old.kind;
      if(!kinds.includes(kind))throw new Error('无效的内容类型');
      if(kind!==old.kind&&(kind==='article'||old.kind==='article'))throw new Error('素材与文章不能直接互改类型，请新建文章并关联素材');
      for(const key of ['kind','title','body','url','annotation','stage'])if(input[key]!==undefined)requireText(input[key],key==='body'?1000000:key==='annotation'?10000:key==='url'?2048:key==='title'?200:30);
      if(input.stage!==undefined&&old.kind!=='article')throw new Error('只有文章可以设置状态');
      let day=input.day===''?null:input.day;
      if(kind==='journal'){
        const targetDay=day??old.contentDay??dateKey(stamp()),other=journalForDay(targetDay);
        if(other&&other.id!==old.id)throw new Error('这一天已有日记，请打开当天日记继续编辑');
        if(day===null)throw new Error('日记必须有内容日期');
        day=targetDay;
      }
      if(day!==undefined&&day!==null&&validDay(day)!==day)throw new Error('请输入有效日期');
      if(day!==undefined&&old.importInfo?.path===':assets')throw new Error('附件归档不能设置内容日期');
      if(input.origin!==undefined&&!origins.includes(input.origin))throw new Error('无效来源');
      const baseline=structuredClone(old.doc);
      // An explicit attribution correction changes existing spans, not writing activity.
      if(input.origin!==undefined){
        const attribute=node=>{if(node.type==='text')node.marks=[...(node.marks??[]).filter(mark=>mark.type!=='provenance'),{type:'provenance',attrs:{origin:input.origin}}];for(const child of node.content??[])attribute(child);};attribute(baseline);
      }
      const doc=input.body===undefined?baseline:updateMarkdownDoc(baseline,input.body,addedOrigin,input.origin??old.origin);
      save({id:old.id,revision:old.revision,kind:old.kind,doc,title:input.title,url:input.url,annotation:input.annotation,stage:input.stage,sourceIds:input.sourceIds,reason:(addedOrigin==='ai'?'Agent 修改':'编辑资料')+(input.origin!==undefined?`; 来源 ${old.origin} → ${input.origin}`:'')},{inTransaction:true,beforeDoc:baseline,sync:false});
      if(input.origin!==undefined)db.prepare('UPDATE records SET origin=? WHERE id=?').run(input.origin,old.id);
      if(kind!==old.kind)db.prepare('UPDATE records SET kind=? WHERE id=?').run(kind,old.id);
      if(day!==undefined){
        if(old.importInfo)db.prepare('UPDATE imports SET day=?,date_basis=? WHERE record=?').run(day,'人工修正',old.id);
        else db.prepare('INSERT INTO record_dates(record,day,basis) VALUES(?,?,?) ON CONFLICT(record) DO UPDATE SET day=excluded.day,basis=excluded.basis').run(old.id,day,'人工确认');
      }
      const record=get(old.id);
      beforeSync?.(record);
      appendSyncChange(old.id,'update',{activityOrigin:addedOrigin});
      if(operationId)db.prepare('INSERT INTO operations VALUES(?,?)').run(operationId,JSON.stringify({fingerprint,record}));
      return record;
    })();
  }
  function review(args={}) {
    const range=dateRange(args.period??'7',args.month,args.now?new Date(args.now):new Date(),args.timeZone);
    const within=at=>{const key=dateKey(at,range.timeZone);return key>=range.start&&key<=range.end;};
    const rows=db.prepare(`SELECT e.*,r.title,r.kind,r.deleted FROM edits e JOIN records r ON r.id=e.record WHERE r.kind<>'ai_annotation' ORDER BY e.at DESC`).all().filter(x=>within(x.at));
    const records=db.prepare("SELECT * FROM records WHERE kind!='ai_annotation'").all();
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
  function exportBackup(){const payload={schema:15,created:stamp(),drafts:{capture:getSetting('captureDraft',''),origin:getSetting('captureDraftOrigin','personal'),editing:getSetting('editingDraft')},tables:{}};for(const table of ['records','links','versions','edits','memories','messages','runs','attachments','imports','agent_documents','agent_sessions','memory_events','conversations','conversation_sources','conversation_drafts','record_sources','record_dates','agent_actions','dsh_record_sources','external_sources','sync_changes','sync_activities','sync_receipts','sync_journal_inputs','sync_record_sources','sync_version_sources','sync_version_parents','sync_branches','sync_branch_blobs','workbench_image_stages','workbench_image_receipts','workbench_drafts','annotation_relations'])payload.tables[table]=db.prepare(`SELECT * FROM ${table}`).all();return JSON.stringify({format:'shiwen-backup',payload,sha256:createHash('sha256').update(JSON.stringify(payload)).digest('hex')});}
  function restoreBackup(raw,{requireEmpty=false}={}){
    if(typeof raw!=='string'||raw.length>1000000000)throw new Error('备份文件过大或无效');
    const b=parse(raw);if(b.format!=='shiwen-backup'||![1,2,3,4,5,6,7,8,9,10,11,12,13,14,15].includes(b.payload?.schema)||b.sha256!==createHash('sha256').update(JSON.stringify(b.payload)).digest('hex'))throw new Error('备份格式或校验不通过');
    if(b.payload.schema===1)for(const row of b.payload.tables.messages??[])row.context='{}';
    if(b.payload.schema<3)b.payload.tables.imports=[];
    if(b.payload.schema<4){for(const table of ['agent_documents','agent_sessions','memory_events','conversations','conversation_sources','conversation_drafts','record_sources','record_dates','agent_actions'])b.payload.tables[table]=[];for(const row of b.payload.tables.memories??[])Object.assign(row,{...memoryDefaults,...row,category:row.scope==='global'?(row.category??'memory'):'project'});}
    if(b.payload.schema<5)for(const table of ['conversations','conversation_sources','conversation_drafts','record_sources','record_dates','agent_actions'])b.payload.tables[table]=[];
    if(b.payload.schema<6)b.payload.tables.dsh_record_sources=[];
    if(b.payload.schema<7)b.payload.tables.external_sources=[];
    if(b.payload.schema<8){for(const row of b.payload.tables.records??[])Object.assign(row,{processing:'unknown',created_by_device:null});for(const table of ['sync_changes','sync_activities','sync_receipts'])b.payload.tables[table]=[];}
    if(b.payload.schema<9)for(const table of ['sync_record_sources','sync_version_sources'])b.payload.tables[table]=[];
    if(b.payload.schema<10)b.payload.tables.sync_version_parents=[];
    if(b.payload.schema<11)for(const row of b.payload.tables.sync_changes??[])Object.assign(row,{operation_fingerprint:null});
    if(b.payload.schema<12)for(const table of ['sync_branches','sync_branch_blobs'])b.payload.tables[table]=[];
    if(b.payload.schema<13)for(const table of ['workbench_image_stages','workbench_image_receipts','workbench_drafts','annotation_relations'])b.payload.tables[table]=[];
    if(b.payload.schema<14)b.payload.tables.sync_journal_inputs=[];
    if(b.payload.schema<15)b.payload.tables.annotation_relations=[];
    const tables=['records','links','versions','edits','memories','messages','runs','attachments','imports','agent_documents','agent_sessions','memory_events','conversations','conversation_sources','conversation_drafts','record_sources','record_dates','agent_actions','dsh_record_sources','external_sources','sync_changes','sync_activities','sync_receipts','sync_journal_inputs','sync_record_sources','sync_version_sources','sync_version_parents','sync_branches','sync_branch_blobs','workbench_image_stages','workbench_image_receipts','workbench_drafts','annotation_relations'];
    for(const table of tables){if(!Array.isArray(b.payload.tables[table]))throw new Error('备份缺少数据表');const columns=db.prepare(`PRAGMA table_info(${table})`).all().map(x=>x.name);for(const row of b.payload.tables[table]){if(Object.keys(row).length!==columns.length||!columns.every(k=>Object.hasOwn(row,k)))throw new Error('备份字段不匹配');if(table==='records'){if(![...kinds,'ai_annotation'].includes(row.kind)||!origins.includes(row.origin))throw new Error('备份内容类型错误');readDoc(parse(row.doc),row.origin);}}}
    const backupRecords=new Map(b.payload.tables.records.map(r=>[r.id,r])),backupVersions=new Map(b.payload.tables.versions.map(v=>[v.id,v])),relationIds=new Set();
    for(const rel of b.payload.tables.annotation_relations){const child=backupRecords.get(rel.record_id),parent=backupRecords.get(rel.original_id),version=backupVersions.get(rel.version_id);if(relationIds.has(rel.record_id)||!child||child.kind!=='ai_annotation'||child.origin!=='ai'||!parent||parent.kind==='ai_annotation'||!version||version.record!==parent.id||hash(markdownSource(parse(version.doc)))!==rel.content_hash)throw Error('备份批注关联无效');relationIds.add(rel.record_id);}
    for(const row of backupRecords.values())if(row.kind==='ai_annotation'&&!relationIds.has(row.id))throw Error('备份缺少批注关联');
    for(const image of b.payload.tables.workbench_image_stages){const bytes=Buffer.from(image.data,'base64');if(!bytes.length||bytes.length>8*1024*1024||bytes.toString('base64')!==image.data||hash(bytes)!==image.digest)throw Error('备份暂存图片校验失败');imageType(bytes);}
    const imageIds=new Set(b.payload.tables.workbench_image_stages.map(image=>image.id)),receiptIds=new Set(b.payload.tables.workbench_image_receipts.map(receipt=>receipt.id));
    for(const row of b.payload.tables.workbench_drafts){const draft=parse(row.payload);if(!draft)continue;const committed=draft.pendingImageSave?.requestId&&receiptIds.has(draft.pendingImageSave.requestId);if(!Array.isArray(draft.stagedImages??[])||(!committed&&(draft.stagedImages??[]).some(id=>!imageIds.has(id))))throw Error('备份草稿图片缺失');}
    db.transaction(()=>{if(requireEmpty&&['records','memories','messages','runs','settings'].some(table=>db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get()))throw new Error('目标资料库已有内容，导入不会覆盖');for(const table of [...tables].reverse())db.prepare(`DELETE FROM ${table}`).run();db.prepare('DELETE FROM operations').run();db.prepare('DELETE FROM external_requests').run();db.prepare("DELETE FROM settings WHERE key IN ('captureDraft','captureDraftOrigin','editingDraft')").run();if(b.payload.drafts){setSetting('captureDraft',requireText(b.payload.drafts.capture,1000000));if(!origins.includes(b.payload.drafts.origin))throw new Error('草稿来源错误');setSetting('captureDraftOrigin',b.payload.drafts.origin);if(b.payload.drafts.editing){readDoc(b.payload.drafts.editing.doc);setSetting('editingDraft',b.payload.drafts.editing);}}for(const table of tables){const columns=db.prepare(`PRAGMA table_info(${table})`).all().map(x=>x.name);const insert=db.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(()=>'?').join(',')})`);for(const row of b.payload.tables[table])insert.run(...columns.map(k=>row[k]));}if(b.payload.schema<5)migrateConversations(db);db.prepare("UPDATE runs SET status='interrupted' WHERE status='running'").run();db.prepare("UPDATE messages SET status='interrupted' WHERE status='streaming'").run();
      db.prepare("UPDATE meta SET value=? WHERE key='sync_epoch'").run(randomUUID());
      for(const table of ['sync_acks','sync_snapshots','sync_manifests'])db.prepare(`DELETE FROM ${table}`).run();
      for(const row of db.prepare('SELECT id FROM records ORDER BY id').all())appendSyncChange(row.id,'restore',{createActivity:false,preserveSources:true});
    })();db.transaction(()=>{for(const version of db.prepare('SELECT id,record FROM versions ORDER BY record,revision,id').all())if(!db.prepare('SELECT 1 FROM sync_version_parents WHERE version_id=?').get(version.id)){const previous=db.prepare('SELECT id FROM versions WHERE record=? AND revision<(SELECT revision FROM versions WHERE id=?) ORDER BY revision DESC LIMIT 1').get(version.record,version.id);db.prepare('INSERT INTO sync_version_parents VALUES(?,?)').run(version.id,JSON.stringify(previous?[previous.id]:[]));}})();consolidateJournals();return true;
  }
  function originalVersionInfo({id}){const row=get(id);if(!row||row.deleted||row.kind==='ai_annotation')throw Error('原文不存在');const version=db.prepare('SELECT id,doc FROM versions WHERE record=? AND revision=?').get(id,row.revision);if(!version)throw Error('原文版本不存在');return {recordId:id,versionId:version.id,contentHash:hash(markdownSource(parse(version.doc))),revision:row.revision};}
  function annotationMutation(action,args,fn){const {requestId}=args;requireText(requestId,100);if(!requestId)throw Error('请求标识不能为空');const fingerprint=hash(JSON.stringify([action,args]));return db.transaction(()=>{const prior=db.prepare('SELECT result FROM operations WHERE id=?').get(requestId);if(prior){const saved=parse(prior.result);if(saved.annotationFingerprint!==fingerprint)throw Error('重复操作的参数不一致');return saved.result;}const result=fn();db.prepare('INSERT INTO operations VALUES(?,?)').run(requestId,JSON.stringify({annotationFingerprint:fingerprint,result}));return result;})();}
  function attachAnnotationImages(args,id){if(args.imageIds===undefined)return;const ids=args.imageIds;for(const imageId of ids){const image=db.prepare('SELECT * FROM workbench_image_stages WHERE id=?').get(imageId);if(!image)throw Error('图片暂存已丢失');const bytes=Buffer.from(image.data,'base64');if(hash(bytes)!==image.digest)throw Error('图片完整性校验失败');imageType(bytes);db.prepare('INSERT INTO attachments VALUES(?,?,?,?,?)').run(image.id,id,image.name,image.data,stamp());db.prepare('DELETE FROM workbench_image_stages WHERE id=?').run(image.id);}}
  function correctRecordOrigin({id,revision,origin,requestId},{beforeSync}={}){if(!requestId)throw Error('请求标识不能为空');return updateRecord({id,revision,origin},{allowOriginCorrection:true,operationId:requestId,beforeSync});}
  function annotationCreate(args,{beforeSync}={}){return annotationMutation('create',args,()=>{const {originalId,originalVersionId,originalContentHash,title='',body}=args;if(args.imageIds!==undefined)api.validateWorkbenchImages({body,imageIds:args.imageIds});const original=get(originalId);if(!original||original.deleted||original.kind==='ai_annotation')throw Error('原文不存在');const version=db.prepare('SELECT doc FROM versions WHERE id=? AND record=?').get(originalVersionId,originalId);if(!version)throw Error('原文版本不存在');const digest=hash(markdownSource(parse(version.doc)));if(originalContentHash!==undefined&&originalContentHash!==digest)throw Error('原文内容校验失败');let result=save({kind:'ai_annotation',title,body},{inTransaction:true,sync:false,allowAnnotation:true});db.prepare('INSERT INTO annotation_relations VALUES(?,?,?,?)').run(result.id,originalId,originalVersionId,digest);result=get(result.id);attachAnnotationImages(args,result.id);beforeSync?.(result);appendSyncChange(result.id,'create');return result;});}
  function annotationRead({id}){const row=get(id);if(!row||row.kind!=='ai_annotation'||row.deleted||!row.annotationOf||!get(row.annotationOf.recordId)||get(row.annotationOf.recordId).deleted)throw Error('批注不存在');return row;}
  function annotationList({originalId,deleted=false}){if(typeof deleted!=='boolean')throw Error('删除状态无效');const parent=get(originalId);if(!parent||parent.deleted||parent.kind==='ai_annotation')return [];return db.prepare('SELECT record_id FROM annotation_relations WHERE original_id=? ORDER BY rowid DESC').all(originalId).map(x=>get(x.record_id)).filter(x=>x&&Boolean(x.deleted)===deleted);}
  function annotationUpdate(args,{beforeSync}={}){return annotationMutation('update',args,()=>{const old=annotationRead(args);if(args.imageIds!==undefined)api.validateWorkbenchImages({id:old.id,body:args.body??markdownSource(old.doc),imageIds:args.imageIds});if(args.revision!==old.revision)throw Error('内容已被更新');if(args.title===undefined&&args.body===undefined)throw Error('请提供要修改的字段');return save({id:old.id,revision:args.revision,title:args.title,doc:args.body===undefined?old.doc:updateMarkdownDoc(old.doc,args.body,'ai','ai')},{inTransaction:true,allowAnnotation:true,beforeSync:record=>{attachAnnotationImages(args,record.id);beforeSync?.(record);}});});}
  function annotationState(action,args){return annotationMutation(action,args,()=>{const old=get(args.id);if(!old||old.kind!=='ai_annotation'||old.revision!==args.revision||Boolean(old.deleted)!==(action==='restore'))throw Error('批注状态已变更');if(!get(old.annotationOf.recordId)||get(old.annotationOf.recordId).deleted)throw Error('原文不存在');db.prepare('UPDATE records SET deleted=?,revision=revision+1 WHERE id=?').run(action==='delete'?1:0,args.id);addCurrentVersion(args.id,action==='delete'?'删除批注':'恢复批注');appendSyncChange(args.id,action,{createActivity:false,preserveSources:true});return get(args.id);});}
  function reviewPreview(args={}){
    const range=dateRange(args.period??'7',args.month,args.now?new Date(args.now):new Date(),args.timeZone),within=day=>day&&day>=range.start&&day<=range.end;
    const records=orderedRecords().map(r=>({...r,contentDay:r.imported?r.import_day:r.dated?r.content_day:dateKey(r.created,range.timeZone)})).filter(r=>r.origin==='personal'&&within(r.contentDay));
    const originals=records.map(r=>({id:r.id,title:r.title,kind:r.kind,contentDay:r.contentDay,characters:count(markdownSource(parse(r.doc)))}));
    const daily=range.days.map(day=>({day,personalOriginalCharacters:originals.filter(r=>r.contentDay===day).reduce((n,r)=>n+r.characters,0),personalOriginalRecords:originals.filter(r=>r.contentDay===day).length}));
    const observedEdits={added:0,removed:0,net:0},textByHash=new Map(),byRecord=new Map(db.prepare('SELECT id,kind,origin FROM records').all().map(r=>[r.id,r]));
    const personal=segments=>segments.filter(x=>x.origin==='personal').map(x=>x.text).join('');
    const remember=(markdown,segments)=>{if(segments.map(x=>x.text).join('')===markdown)textByHash.set(contentHash(markdown,segments),personal(segments));};
    remember('',[]);
    const versions=db.prepare('SELECT * FROM versions ORDER BY record,revision,id').all();
    for(const version of versions){const doc=parse(version.doc),markdown=markdownSource(doc),stored=db.prepare('SELECT markdown,sources FROM sync_version_sources WHERE version_id=?').get(version.id),sources=stored?.markdown===markdown?parse(stored.sources):markdownSegments(doc,byRecord.get(version.record)?.origin??'unknown');remember(markdown,sources);}
    for(const row of byRecord.values()){const record=syncRecord(row.id);remember(record.markdown,record.sources);}
    const activities=db.prepare('SELECT * FROM sync_activities').all().map(row=>({recordId:row.record_id,action:row.action,authorship:row.authorship,occurredAt:row.occurred_at,beforeHash:row.before_hash,afterHash:row.after_hash,afterSegments:parse(row.after_segments)}));
    for(const activity of activities){const markdown=activity.afterSegments.map(x=>x.text).join('');if(contentHash(markdown,activity.afterSegments)===activity.afterHash)remember(markdown,activity.afterSegments);}
    // Match bootstrap's derived legacy activities without reclassifying historical records.
    for(const version of versions){if(db.prepare('SELECT 1 FROM sync_changes WHERE version_id=?').get(version.id))continue;const edit=db.prepare("SELECT 1 FROM edits WHERE record=? AND at=? AND origin='personal'").get(version.record,version.at);if(!edit)continue;const origin=byRecord.get(version.record)?.origin??'unknown',doc=parse(version.doc),markdown=markdownSource(doc),segments=markdownSegments(doc,origin),previous=db.prepare('SELECT doc FROM versions WHERE record=? AND revision<? ORDER BY revision DESC LIMIT 1').get(version.record,version.revision),beforeDoc=previous?parse(previous.doc):{type:'doc',content:[]},beforeMarkdown=previous?markdownSource(beforeDoc):'',beforeSegments=previous?markdownSegments(beforeDoc,origin):[];remember(markdown,segments);const beforeHash=contentHash(beforeMarkdown,beforeSegments),afterHash=contentHash(markdown,segments);if(!activities.some(a=>a.recordId===version.record&&a.occurredAt===version.at&&a.action==='write'&&a.authorship==='personal'&&a.beforeHash===beforeHash&&a.afterHash===afterHash))activities.push({recordId:version.record,action:'write',authorship:'personal',occurredAt:version.at,beforeHash,afterHash});}
    for(const activity of activities){if(byRecord.get(activity.recordId)?.kind==='ai_annotation'||activity.action!=='write'||activity.authorship!=='personal'||!within(dateKey(activity.occurredAt,range.timeZone)))continue;const before=textByHash.get(activity.beforeHash),after=textByHash.get(activity.afterHash);if(before===undefined||after===undefined)continue;const delta=changes(before,after);observedEdits.added+=delta.added;observedEdits.removed+=delta.removed;}
    observedEdits.net=observedEdits.added-observedEdits.removed;
    return {personalOriginalCharacters:originals.reduce((n,r)=>n+r.characters,0),observedEdits,start:range.start,end:range.end,records:originals,daily};
  }

  const api={
    originalVersionInfo,correctRecordOrigin,annotationCreate,annotationList,annotationRead,annotationUpdate,annotationDelete:args=>annotationState('delete',args),annotationRestore:args=>annotationState('restore',args),reviewPreview,
    snapshot:()=>({records:orderedRecords().map(({import_day,imported,content_day,dated,...row})=>decode(row)),memories:db.prepare("SELECT * FROM memories WHERE status='active' ORDER BY updated DESC").all(),today:review({period:'1'}),draft:getSetting('captureDraft',''),draftOrigin:getSetting('captureDraftOrigin','personal'),editingDraft:getSetting('editingDraft')}),
    searchRecords:({query='',kind='',start='',end='',offset=0,limit=20}={})=>{requireText(query,100);requireText(kind,30);if(kind&&!kinds.includes(kind))throw new Error('无效类型');if(start&&validDay(start)!==start||end&&validDay(end)!==end||start&&end&&start>end)throw new Error('无效日期范围');if(!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>30)throw new Error('无效分页');const term=query.trim().toLowerCase();const rows=orderedRecords().filter(r=>{const day=r.contentDay;return (!kind||r.kind===kind)&&(!term||(r.title+' '+r.body+' '+r.annotation).toLowerCase().includes(term))&&(!start||day&&day>=start)&&(!end||day&&day<=end);});return {total:rows.length,items:rows.slice(offset,offset+limit).map(r=>({id:r.id,title:r.title,kind:r.kind,origin:r.origin,url:r.url,day:r.contentDay,excerpt:r.body.slice(Math.max(0,r.body.toLowerCase().indexOf(term)-100),Math.max(0,r.body.toLowerCase().indexOf(term)-100)+450)})),nextOffset:offset+limit<rows.length?offset+limit:null};},
    save, get, review, updateRecord, consolidateJournals, journalForDay:day=>{const row=journalForDay(day);return row?get(row.id):null;},
    importWiki:scan=>db.transaction(()=>{const before=new Map(db.prepare('SELECT id FROM records').all().map(r=>[r.id,JSON.stringify(syncRecord(r.id))]));const result=importWiki(db,scan);for(const row of db.prepare('SELECT id FROM records').all()){const after=JSON.stringify(syncRecord(row.id));if(before.get(row.id)!==after){if(before.has(row.id))bumpSyncRevision(row.id,'Wiki 导入附件或来源更新');appendSyncChange(row.id,before.has(row.id)?'update':'create',{createActivity:false});}}consolidateJournals();return result;})(),
    dshSources:({id})=>db.prepare('SELECT session_id,message_id,role,excerpt FROM dsh_record_sources WHERE record=? ORDER BY rowid').all(requireText(id,100)),
    saveDsh:({kind,title='',body,origin='ai',url='',annotation='',day=null,sessionId,messageId,role,operationId,sourceExcerpt=body})=>{
      requireText(sessionId,100);requireText(messageId,100);requireText(operationId,100);requireText(body,1000000);
      if(!['journal','freewrite','idea','web','ai','article','reference'].includes(kind))throw new Error('无效的内容类型');
      if(!['personal','ai','external','unknown'].includes(origin)||!['user','assistant'].includes(role))throw new Error('无效来源');
      if(day!==null&&validDay(day)!==day)throw new Error('请输入有效日期');
      return db.transaction(()=>{
        const prior=db.prepare('SELECT result FROM operations WHERE id=?').get(operationId);
        if(prior)return parse(prior.result);
        const result=save({kind,title,body,origin,url,annotation,day,opId:operationId},{inTransaction:true,archive:true,sync:false});
        db.prepare('INSERT OR IGNORE INTO dsh_record_sources VALUES(?,?,?,?,?)').run(result.id,sessionId,messageId,role,requireText(sourceExcerpt,1000000).slice(0,500));
        if(kind!=='journal')db.prepare('INSERT INTO record_dates VALUES(?,?,?)').run(result.id,day,day?'对话归档指定':'对话归档，内容日期待确认');
        const saved=get(result.id);
        appendSyncChange(result.id,'create',{createActivity:false});
        db.prepare('UPDATE operations SET result=? WHERE id=?').run(JSON.stringify(saved),operationId);
        return saved;
      })();
    },
    importDate:({id,day})=>{assertJournalDay(id,day);const row=importInfo(id);if(!row||row.path===':assets')throw new Error('记录不是导入文档');if(day!==null&&validDay(day)!==day)throw new Error('请输入有效日期');db.transaction(()=>{db.prepare("UPDATE imports SET day=?,date_basis='人工修正' WHERE record=?").run(day,id);if(day)db.prepare('UPDATE records SET created=?,updated=CASE WHEN revision=1 THEN ? ELSE updated END WHERE id=?').run(day+'T12:00:00+08:00',day+'T12:00:00+08:00',id);bumpSyncRevision(id,'导入日期修正');appendSyncChange(id,'update',{createActivity:false,preserveSources:true});})();return get(id);},
    remove:({id,revision})=>db.transaction(()=>{
      requireText(id,100);if(!Number.isInteger(revision)||revision<1)throw new Error('版本无效');
      if(get(id)?.kind==='ai_annotation')throw new Error('批注只能通过专用接口修改');
      const result=db.prepare('UPDATE records SET deleted=1,revision=revision+1 WHERE id=? AND revision=? AND deleted=0').run(id,revision);
      if(!result.changes)throw new Error('内容已变更或已删除，请刷新');
      if(getSetting('editingDraft')?.id===id)db.prepare("DELETE FROM settings WHERE key='editingDraft'").run();
      addCurrentVersion(id,'删除记录');
      appendSyncChange(id,'delete',{createActivity:false,preserveSources:true});return {id,revision:revision+1};
    })(),
    restoreRemoved:({id,revision})=>{
      requireText(id,100);if(!Number.isInteger(revision)||revision<1)throw new Error('版本无效');
      const original=get(id);if(original?.kind==='ai_annotation')throw new Error('批注只能通过专用接口修改');if(original?.kind==='journal')assertJournalDay(id,original.contentDay);
      const result=db.prepare('UPDATE records SET deleted=0,revision=revision+1 WHERE id=? AND revision=? AND deleted=1').run(id,revision);
      if(!result.changes)throw new Error('记录状态已变更，请刷新');
      addCurrentVersion(id,'恢复已删除记录');
      appendSyncChange(id,'restore',{createActivity:false,preserveSources:true});
      return {id,revision:revision+1};
    },
    versions:({id})=>db.prepare('SELECT * FROM versions WHERE record=? ORDER BY revision DESC').all(id).map(r=>({...r,doc:parse(r.doc),...(annotationOf(r.record)?{annotationOf:annotationOf(r.record)}:{})})),
    restoreVersion:({id,versionId,revision})=>{const v=db.prepare('SELECT * FROM versions WHERE id=? AND record=?').get(versionId,id);if(!v)throw new Error('版本不存在');const current=db.prepare('SELECT id FROM versions WHERE record=? ORDER BY revision DESC LIMIT 1').get(id);return save({id,revision,doc:parse(v.doc),title:v.title,reason:`恢复版本 ${v.revision}`},{syncAction:'restore',parentVersionIds:[...new Set([current?.id,versionId].filter(Boolean))]});},
    draft:({value,origin='personal'})=>{requireText(value,1000000);if(!origins.includes(origin))throw new Error('无效来源');db.transaction(()=>{setSetting('captureDraft',value);setSetting('captureDraftOrigin',origin);})();return true;},
    editingDraft:({value})=>{if(value){const r=get(value.id);if(!r||r.deleted)throw new Error('草稿所属记录不存在');readDoc(value.doc,r.origin);requireText(value.title,200);requireText(value.annotation,10000);if(!Number.isInteger(value.revision))throw new Error('草稿版本无效');}setSetting('editingDraft',value);return true;},
    messages:({thread})=>db.prepare('SELECT * FROM messages WHERE thread=? ORDER BY created,rowid').all(thread).map(r=>({...r,context:parse(r.context)})),
    addMessage:(r)=>{const id=r.id??randomUUID();db.prepare('INSERT INTO messages(id,thread,role,body,status,created,context) VALUES(?,?,?,?,?,?,?)').run(id,r.thread,r.role,r.body,r.status??'done',stamp(),JSON.stringify(r.context??{}));return id;},
    updateMessage:({id,body,status})=>{db.prepare('UPDATE messages SET body=?,status=? WHERE id=?').run(body,status,id);return true;},
    addRun:({id,thread,model})=>{const at=stamp();db.prepare("INSERT INTO runs VALUES(?,?,'running',?,'',?,?)").run(id,thread,model,at,at);return true;},
    finishRun:({id,status,error=''})=>{db.prepare('UPDATE runs SET status=?,error=?,updated=? WHERE id=?').run(status,error,stamp(),id);return true;},
    getSetting:({key,fallback})=>getSetting(key,fallback),setSetting:({key,value})=>{setSetting(key,value);return true;},
    stageWorkbenchImage:({name,data})=>{
      requireText(name,200);requireText(data,12*1024*1024);const bytes=Buffer.from(data,'base64');
      if(!bytes.length||bytes.length>8*1024*1024||bytes.toString('base64')!==data)throw Error('图片大小或编码无效');imageType(bytes);
      const quota=db.prepare('SELECT COUNT(*) AS n,COALESCE(SUM(LENGTH(data)),0) AS bytes FROM workbench_image_stages').get();
      if(quota.n>=100||quota.bytes+data.length>128*1024*1024)throw Error('图片暂存空间已满');
      const id=randomUUID(),digest=hash(bytes);db.prepare('INSERT INTO workbench_image_stages VALUES(?,?,?,?,?)').run(id,name,data,digest,stamp());
      return {id,name,digest,byteLength:bytes.length};
    },
    discardWorkbenchImages:({ids})=>{if(!Array.isArray(ids)||ids.length>100||ids.some(id=>typeof id!=='string'||id.length>100))throw Error('图片清单无效');return db.transaction(()=>{for(const id of ids)db.prepare('DELETE FROM workbench_image_stages WHERE id=?').run(id);return {discarded:ids.length};})();},
    workbenchDraft:({slot,value,revision})=>{
      if(typeof slot!=='string'||(!['library','articles'].includes(slot)&&!((slot.startsWith('annotation:')&&slot.length>11&&slot.length<=111)||(slot.startsWith('origin:')&&slot.length>7&&slot.length<=107))))throw Error('草稿类型无效');
      if(value===undefined){const row=db.prepare('SELECT payload,revision FROM workbench_drafts WHERE slot=?').get(slot);return row?{revision:row.revision,value:parse(row.payload)}:null;}
      if(!Number.isSafeInteger(revision)||revision<0)throw Error('草稿版本无效');
      const payload=JSON.stringify(value);if(typeof payload!=='string'||payload.length>2200000)throw Error('草稿内容无效');
      const old=db.prepare('SELECT revision,payload FROM workbench_drafts WHERE slot=?').get(slot);
      if(old&&old.revision>revision)throw Error('草稿版本已更新');
      if(old&&old.revision===revision&&old.payload!==payload)throw Error('草稿版本已用于不同内容');
      db.prepare('INSERT INTO workbench_drafts VALUES(?,?,?) ON CONFLICT(slot) DO UPDATE SET revision=excluded.revision,payload=excluded.payload').run(slot,revision,payload);return {revision};
    },
    validateWorkbenchImages:({id,body,imageIds=[]})=>{
      if(!Array.isArray(imageIds)||imageIds.length>20||new Set(imageIds).size!==imageIds.length)throw Error('图片清单无效');
      const refs=attachmentImageIds(body),current=id?get(id):null,old=current?attachmentImageIds(markdownSource(current.doc)):new Set();
      const owned=new Set(id?db.prepare('SELECT id FROM attachments WHERE record=?').all(id).map(item=>item.id):[]);
      if(imageIds.some(image=>!refs.has(image)))throw Error('正文缺少图片引用');
      if([...refs].some(image=>!owned.has(image)&&!imageIds.includes(image)&&!old.has(image)))throw Error('正文引用的图片不存在');
    },
    workbenchImageReceipt:({requestId,requestPayload})=>{
      requireText(requestId,100);const receipt=db.prepare('SELECT * FROM workbench_image_receipts WHERE id=?').get(requestId);
      if(!receipt||!receipt.fingerprint.startsWith('request:'))return null;
      if(receipt.fingerprint!==`request:${hash(JSON.stringify(requestPayload))}`)throw Error('请求编号已用于不同内容');
      return parse(receipt.result);
    },
    saveWorkbenchMarkdown:(input,imageIds=[],requestId,requestPayload)=>{
      if(!Array.isArray(imageIds)||imageIds.length>20||new Set(imageIds).size!==imageIds.length)throw Error('图片清单无效');
      requireText(requestId,100);if(!requestId)throw Error('缺少请求编号');
      return db.transaction(()=>{
        const receipt=db.prepare('SELECT * FROM workbench_image_receipts WHERE id=?').get(requestId);
        const fingerprint=receipt&&!receipt.fingerprint.startsWith('request:')?hash(JSON.stringify([input,imageIds])):requestPayload===undefined?hash(JSON.stringify([input,imageIds])):`request:${hash(JSON.stringify(requestPayload))}`;
        if(receipt){if(receipt.fingerprint!==fingerprint)throw Error('请求编号已用于不同内容');return parse(receipt.result);}
        const body=markdownSource(input.doc);if(imageIds.some(id=>!body.includes(`attachment:${id}`)))throw Error('正文缺少图片引用');
        const images=imageIds.map(id=>{const image=db.prepare('SELECT * FROM workbench_image_stages WHERE id=?').get(id);if(!image)throw Error('图片暂存已丢失');const bytes=Buffer.from(image.data,'base64');if(hash(bytes)!==image.digest)throw Error('图片完整性校验失败');imageType(bytes);return image;});
        const result=save(input,{inTransaction:true,beforeSync:record=>{for(const image of images){db.prepare('INSERT INTO attachments VALUES(?,?,?,?,?)').run(image.id,record.id,image.name,image.data,stamp());db.prepare('DELETE FROM workbench_image_stages WHERE id=?').run(image.id);}}});
        db.prepare('INSERT INTO workbench_image_receipts VALUES(?,?,?)').run(requestId,fingerprint,JSON.stringify(result));return result;
      })();
    },
    attachmentAdd:({record,name,data})=>{if(!get(record))throw new Error('先保存记录再添加附件');requireText(name,200);requireText(data,15000000);const id=randomUUID();db.transaction(()=>{db.prepare('INSERT INTO attachments VALUES(?,?,?,?,?)').run(id,record,name,data,stamp());bumpSyncRevision(record,'附件添加');appendSyncChange(record,'update',{createActivity:false,preserveSources:true});})();return id;},
    attachments:({record})=>db.prepare('SELECT id,name,created FROM attachments WHERE record=?').all(record),
    attachment:({id})=>db.prepare('SELECT * FROM attachments WHERE id=?').get(id),
    ...createAgentStore(db,get),
    ...conversationStore(db,get,save),
    recordDate:args=>db.transaction(()=>{if(args?.day!==undefined)assertJournalDay(args.id,args.day);const result=conversationStore(db,get,save).recordDate(args);if(args?.day!==undefined){bumpSyncRevision(args.id,'归档日期修正');appendSyncChange(args.id,'update',{createActivity:false,preserveSources:true});}return result;})(),
    updateMessageContext:({id,context})=>{db.prepare('UPDATE messages SET context=? WHERE id=?').run(JSON.stringify(context),id);return true;},
    exportBackup,restoreBackup,
    close:()=>db.close(),
    mobileSync:options=>createMobileSyncStore({db,get,save,syncMeta,syncRecord,hash,appendSyncChange,bumpSyncRevision,consolidateJournals,journalForDay:api.journalForDay,ownerId:options?.ownerId??'owner'})
  };Object.assign(api,externalStore(db,api));consolidateJournals();return api;
}
