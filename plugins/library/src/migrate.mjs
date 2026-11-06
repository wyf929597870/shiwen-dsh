import {DatabaseSync,backup} from 'node:sqlite';
import {mkdtemp,mkdir,rm,link} from 'node:fs/promises';
import {dirname,resolve,join} from 'node:path';
import {createStore} from '../legacy/store.mjs';

export function inspectLegacy(path){
 const db=new DatabaseSync(resolve(path),{readOnly:true});
 try{
  const meta=db.prepare("SELECT value FROM meta WHERE key='schema'").get();if(!meta||!['1','2','3','4','5'].includes(meta.value))throw new Error('旧资料库版本不受支持');
  const records=db.prepare("SELECT kind, count(*) AS count FROM records WHERE deleted=0 GROUP BY kind ORDER BY kind").all().map(row=>({...row}));
  const table=name=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  const messages=table('messages')?db.prepare('SELECT count(*) AS count FROM messages').get().count:0;
  const attachments=table('attachments')?db.prepare('SELECT count(*) AS count FROM attachments').get().count:0;
  return {schema:Number(meta.value),records,messages,attachments};
 }finally{db.close();}
}

export async function migrateLegacy({source,target}){
 const from=resolve(source),to=resolve(target);if(from===to)throw new Error('迁移源与目标不能相同');
 const summary=inspectLegacy(from);await mkdir(dirname(to),{recursive:true});
 const tempDir=await mkdtemp(join(dirname(to),'.shiwen-migration-')),temporary=join(tempDir,'library.sqlite');
 try{
  const reader=new DatabaseSync(from,{readOnly:true});
  try{await backup(reader,temporary);}finally{reader.close();}
  const store=createStore(temporary,{recover:false});
  try{const after=store.snapshot();if(after.records.length!==summary.records.reduce((n,row)=>n+row.count,0))throw new Error('迁移记录数量不匹配');}
  finally{store.close();}
  // A hard link publishes the fully migrated database only if no destination exists.
  try{await link(temporary,to);}catch(error){if(error.code==='EEXIST')throw new Error('目标资料库已存在，迁移不会覆盖');throw error;}
  return {...summary,target:to};
 }finally{await rm(tempDir,{recursive:true,force:true});}
}

/** Copy a consistent legacy snapshot into an empty open library. */
export async function importLegacyToStore({source,store,scratch}){
 const from=resolve(source),summary=inspectLegacy(from);await mkdir(scratch,{recursive:true,mode:0o700});
 const tempDir=await mkdtemp(join(scratch,'.legacy-import-')),temporary=join(tempDir,'library.sqlite');
 try{
  const reader=new DatabaseSync(from,{readOnly:true});try{await backup(reader,temporary);}finally{reader.close();}
  const legacy=createStore(temporary,{recover:false});let raw;
  try{const rows=legacy.snapshot().records;if(rows.length!==summary.records.reduce((n,row)=>n+row.count,0))throw new Error('源资料库在预览后发生变化，请重试');raw=legacy.exportBackup();}
  finally{legacy.close();}
  store.restoreBackup(raw,{requireEmpty:true});return summary;
 }finally{await rm(tempDir,{recursive:true,force:true});}
}
