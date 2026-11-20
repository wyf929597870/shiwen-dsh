export const relationsDDL=`CREATE TABLE IF NOT EXISTS record_relations(
 library_id TEXT NOT NULL,left_id TEXT NOT NULL,right_id TEXT NOT NULL,created TEXT NOT NULL,blocked INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(library_id,left_id,right_id,blocked));
CREATE INDEX IF NOT EXISTS record_relations_right ON record_relations(library_id,right_id,blocked);`;
const id=value=>{if(typeof value!=='string'||!value.trim()||value.length>100)throw Error('记录编号无效');return value;};
export function validateRelationsBackup(rows){
 if(rows.length>1000000)throw Error('备份关系数量超限');const seen=new Set();
 for(const row of rows){id(row.library_id);id(row.left_id);id(row.right_id);if(row.left_id>=row.right_id||![0,1].includes(row.blocked)||typeof row.created!=='string'||!row.created.trim()||row.created.length>100)throw Error('备份记录关系无效');const key=JSON.stringify([row.library_id,row.left_id,row.right_id,row.blocked]);if(seen.has(key))throw Error('备份记录关系重复');seen.add(key);}
}
export function createRelationsStore({db,get,libraryId,recordThemes}){
 const valid=value=>{const row=get(id(value));if(!row||row.deleted||row.kind==='ai_annotation')throw Error('记录不存在或已删除');return row;};
 const summary=row=>({id:row.id,title:row.title,kind:row.kind,revision:row.revision,created:row.created,updated:row.updated});
 const order=rows=>rows.sort((a,b)=>b.updated.localeCompare(a.updated)||b.id.localeCompare(a.id));
 const neighborhood=({id:recordId}={})=>{
  const row=valid(recordId),scope=libraryId();
  const sources=row.kind==='article'?db.prepare(`SELECT r.id,r.title,r.kind,r.revision,r.created,r.updated FROM links l JOIN records r ON r.id=l.material WHERE l.article=? AND r.deleted=0 AND r.kind NOT IN ('article','ai_annotation')`).all(row.id):[];
  const articles=row.kind==='article'?[]:db.prepare(`SELECT r.id,r.title,r.kind,r.revision,r.created,r.updated FROM links l JOIN records r ON r.id=l.article WHERE l.material=? AND r.deleted=0 AND r.kind='article'`).all(row.id);
  const related=db.prepare(`SELECT r.id,r.title,r.kind,r.revision,r.created,r.updated FROM record_relations rel JOIN records r ON r.id=CASE WHEN rel.left_id=? THEN rel.right_id ELSE rel.left_id END WHERE rel.library_id=? AND rel.blocked=0 AND (rel.left_id=? OR rel.right_id=?) AND r.deleted=0 AND r.kind<>'ai_annotation'`).all(row.id,scope,row.id,row.id);
  return {sourceLibraryId:scope,record:{id:row.id,title:row.title,kind:row.kind,revision:row.revision},themes:recordThemes(row.id),sources:order(sources),articles:order(articles),related:order(related)};
 };
 const mutate=(action,args={})=>db.transaction(()=>{if(typeof args.expectedLibraryId!=='string'||!args.expectedLibraryId||args.expectedLibraryId!==libraryId())throw Error('资料库已切换，请重新打开记录');const source=valid(args.id),target=valid(args.relatedId);if(source.id===target.id)throw Error('不能关联同一条记录');const [left,right]=[source.id,target.id].sort();if(action==='add'){
   const count=db.prepare('SELECT COUNT(*) n FROM record_relations WHERE library_id=? AND blocked=0 AND (left_id=? OR right_id=?)').get(libraryId(),source.id,source.id).n;
   const otherCount=db.prepare('SELECT COUNT(*) n FROM record_relations WHERE library_id=? AND blocked=0 AND (left_id=? OR right_id=?)').get(libraryId(),target.id,target.id).n;
   const exists=db.prepare('SELECT 1 FROM record_relations WHERE library_id=? AND left_id=? AND right_id=? AND blocked=0').get(libraryId(),left,right);
   if(!exists&&(count>=10000||otherCount>=10000))throw Error('记录关系数量已达上限');db.prepare('INSERT OR IGNORE INTO record_relations VALUES(?,?,?,?,0)').run(libraryId(),left,right,new Date().toISOString());
  }else db.prepare('DELETE FROM record_relations WHERE library_id=? AND left_id=? AND right_id=? AND blocked=0').run(libraryId(),left,right);
  return neighborhood({id:source.id});})();
 return {recordNeighborhood:neighborhood,recordRelationAdd:args=>mutate('add',args),recordRelationRemove:args=>mutate('remove',args)};
}
