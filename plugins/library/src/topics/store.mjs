import {randomUUID} from 'node:crypto';
import {markdownSource} from '../../legacy/markdown.mjs';
import {decodeReadingNote} from '../../legacy/reading-note.mjs';

export const topicsDDL=`CREATE TABLE IF NOT EXISTS themes(id TEXT PRIMARY KEY,title TEXT NOT NULL,summary TEXT NOT NULL,revision INTEGER NOT NULL,created TEXT NOT NULL,updated TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS theme_members(id TEXT PRIMARY KEY,theme_id TEXT NOT NULL REFERENCES themes(id) ON DELETE CASCADE,source_record_id TEXT NOT NULL,source_library_id TEXT NOT NULL,source_title TEXT NOT NULL,source_kind TEXT NOT NULL,field TEXT NOT NULL,excerpt_index INTEGER,whole INTEGER NOT NULL,quote TEXT NOT NULL,prefix TEXT NOT NULL,suffix TEXT NOT NULL,start INTEGER NOT NULL,end INTEGER NOT NULL,source_revision INTEGER NOT NULL,created TEXT NOT NULL,source_blocked INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS theme_members_source ON theme_members(source_library_id,source_record_id);
CREATE INDEX IF NOT EXISTS theme_members_theme ON theme_members(theme_id,created,id);`;
const text=(v,max,label,nonempty=false)=>{if(typeof v!=='string'||v.length>max||(nonempty&&!v.trim()))throw Error(`${label}无效或过长`);return v;};
const ident=(v)=>text(v,100,'编号',true);
const rev=(v)=>{if(!Number.isSafeInteger(v)||v<1)throw Error('版本无效');return v;};
const now=()=>new Date().toISOString();
const fields=['body','excerpt','reflection'];
function texts(row,field){
 if(field==='excerpt')return row.kind==='reading_note'?(decodeReadingNote(row.annotation)?.excerpts??[]).map(x=>x.text):[];
 if(field==='reflection'&&row.kind!=='reading_note')return [];
 if(field==='body'&&row.kind==='reading_note')return [];
 return [markdownSource(row.doc)];
}
export function validateTopicBackup(themes,members){
 if(themes.length>10000||members.length>1000000)throw Error('备份主题数量超限');
 const ids=new Set(),membersIds=new Set(),counts=new Map();
 for(const r of themes){ident(r.id);text(r.title,200,'标题',true);text(r.summary,10000,'摘要');rev(r.revision);text(r.created,100,'日期',true);text(r.updated,100,'日期',true);if(ids.has(r.id))throw Error('备份主题重复');ids.add(r.id);}
 for(const r of members){ident(r.id);ident(r.theme_id);ident(r.source_record_id);ident(r.source_library_id);text(r.source_title,200,'来源标题');text(r.source_kind,50,'来源类型',true);text(r.quote,1000000,'片段');text(r.prefix,64,'前文');text(r.suffix,64,'后文');text(r.created,100,'日期',true);rev(r.source_revision);
  if(!ids.has(r.theme_id)||membersIds.has(r.id)||!fields.includes(r.field)||![0,1].includes(r.whole)||![0,1].includes(r.source_blocked)||!Number.isSafeInteger(r.start)||!Number.isSafeInteger(r.end)||r.start<0||r.end<r.start||r.end-r.start!==r.quote.length||((r.field==='excerpt')?(!Number.isSafeInteger(r.excerpt_index)||r.excerpt_index<0||r.excerpt_index>=30):r.excerpt_index!==null)||(!r.whole&&!r.quote.length))throw Error('备份主题成员无效');
  membersIds.add(r.id);counts.set(r.theme_id,(counts.get(r.theme_id)??0)+1);if(counts.get(r.theme_id)>10000)throw Error('备份主题成员超限');
 }
}
export function createTopicStore({db,get,libraryId}){
 const summary=row=>row?{id:row.id,title:row.title,summary:row.summary,revision:row.revision,created:row.created,updated:row.updated,memberCount:db.prepare('SELECT COUNT(*) n FROM theme_members WHERE theme_id=?').get(row.id).n}:null;
 const theme=id=>db.prepare('SELECT * FROM themes WHERE id=?').get(ident(id));
 const checked=(id,revision)=>{const row=theme(id);if(!row)throw Error('主题不存在');if(row.revision!==rev(revision))throw Error('主题已更新，请重新读取');return row;};
 const locate=(m,row)=>{
  if(m.source_blocked||m.source_library_id!==libraryId())return {status:'library_mismatch',start:null,end:null};
  if(!row||row.deleted)return {status:'deleted',start:null,end:null};
  if(row.kind!==m.source_kind)return {status:'changed',start:null,end:null};
  const all=texts(row,m.field);if(!all.length)return {status:'changed',start:null,end:null};
  if(m.whole){const matches=all.map((value,index)=>({value,index})).filter(x=>x.value===m.quote);if(matches.length!==1)return {status:matches.length?'ambiguous':'changed',start:null,end:null};return {status:matches[0].index===(m.excerpt_index??0)?'current':'moved',start:0,end:m.quote.length,excerptIndex:m.field==='excerpt'?matches[0].index:null};}
  const candidates=[];for(let index=0;index<all.length;index++){const value=all[index];let at=value.indexOf(m.quote);while(at!==-1){const end=at+m.quote.length;const context=value.slice(Math.max(0,at-m.prefix.length),at)===m.prefix&&value.slice(end,end+m.suffix.length)===m.suffix;candidates.push({index,start:at,end,context});at=value.indexOf(m.quote,at+1);}}
  let matches=candidates.filter(x=>x.context);if(!matches.length)matches=candidates;if(matches.length!==1)return {status:matches.length?'ambiguous':'changed',start:null,end:null};const x=matches[0];return {status:x.start===m.start&&x.index===(m.excerpt_index??0)?'current':'moved',start:x.start,end:x.end,excerptIndex:m.field==='excerpt'?x.index:null};
 };
 const member=m=>{const row=!m.source_blocked&&m.source_library_id===libraryId()?get(m.source_record_id):null;return {id:m.id,sourceRecordId:m.source_record_id,sourceLibraryId:m.source_library_id,sourceTitle:m.source_title,sourceKind:m.source_kind,currentTitle:row&&!row.deleted?row.title:null,currentKind:row&&!row.deleted?row.kind:null,field:m.field,excerptIndex:m.excerpt_index,whole:!!m.whole,quote:m.quote,prefix:m.prefix,suffix:m.suffix,start:m.start,end:m.end,sourceRevision:m.source_revision,created:m.created,location:locate(m,row)};};
 const read=id=>{const row=theme(id);if(!row)throw Error('主题不存在');return {...summary(row),members:db.prepare('SELECT * FROM theme_members WHERE theme_id=? ORDER BY created,id').all(id).map(member)};};
 const bump=id=>db.prepare('UPDATE themes SET revision=revision+1,updated=? WHERE id=?').run(now(),id);
 return {
  themeContext:()=>({libraryId:libraryId()}),
  themeList:()=>db.prepare('SELECT * FROM themes ORDER BY updated DESC,id DESC').all().map(summary),
  themeRead:({id}={})=>read(id),
  themeSave:(args={})=>db.transaction(()=>{const title=text(args.title,200,'标题',true).trim(),description=text(args.summary??'',10000,'摘要');if(args.id===undefined){if(db.prepare('SELECT COUNT(*) n FROM themes').get().n>=10000)throw Error('主题数量已达上限');const id=randomUUID(),at=now();db.prepare('INSERT INTO themes VALUES(?,?,?,?,?,?)').run(id,title,description,1,at,at);return summary(theme(id));}checked(args.id,args.revision);db.prepare('UPDATE themes SET title=?,summary=?,revision=revision+1,updated=? WHERE id=?').run(title,description,now(),args.id);return summary(theme(args.id));})(),
  themeDelete:({id,revision}={})=>db.transaction(()=>{checked(id,revision);db.prepare('DELETE FROM themes WHERE id=?').run(id);return {id};})(),
  themeMemberAdd:(args={})=>db.transaction(()=>{checked(args.themeId,args.revision);if(db.prepare('SELECT COUNT(*) n FROM theme_members WHERE theme_id=?').get(args.themeId).n>=10000)throw Error('主题成员数量已达上限');ident(args.sourceRecordId);const row=get(args.sourceRecordId);if(!row||row.deleted||row.kind==='ai_annotation')throw Error('来源不存在');if(row.revision!==rev(args.sourceRevision))throw Error('来源已更新，请重新读取');if(!fields.includes(args.field))throw Error('来源字段无效');const all=texts(row,args.field),index=args.field==='excerpt'?args.excerptIndex:0;if(!Number.isSafeInteger(index)||index<0||index>=all.length||(args.field!=='excerpt'&&args.excerptIndex!=null))throw Error('来源摘录无效');const value=all[index],whole=args.quote===undefined&&args.start===undefined&&args.end===undefined;let start=0,end=value.length,quote=value;if(!whole){quote=text(args.quote,1000000,'片段',true);start=args.start;end=args.end;if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<=start||end>value.length||value.slice(start,end)!==quote)throw Error('片段与当前原文不一致，请重新选择');}text(quote,1000000,'片段');const id=randomUUID();db.prepare('INSERT INTO theme_members VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,args.themeId,row.id,libraryId(),row.title,row.kind,args.field,args.field==='excerpt'?index:null,whole?1:0,quote,value.slice(Math.max(0,start-64),start),value.slice(end,end+64),start,end,row.revision,now(),0);bump(args.themeId);return read(args.themeId);})(),
  themeMemberRemove:({themeId,revision,memberId}={})=>db.transaction(()=>{checked(themeId,revision);ident(memberId);if(!db.prepare('DELETE FROM theme_members WHERE id=? AND theme_id=?').run(memberId,themeId).changes)throw Error('主题成员不存在');bump(themeId);return read(themeId);})(),
  recordThemes:({id}={})=>{ident(id);const row=get(id);if(!row||row.deleted)return [];return db.prepare('SELECT DISTINCT t.* FROM themes t JOIN theme_members m ON m.theme_id=t.id WHERE m.source_blocked=0 AND m.source_library_id=? AND m.source_record_id=? ORDER BY t.updated DESC,t.id DESC').all(libraryId(),id).map(summary);}
 };
}
