import {randomUUID} from 'node:crypto';
import MarkdownIt from 'markdown-it';
import {markdownSegments,markdownSource} from '../../legacy/markdown.mjs';
import {hash,fail} from '../assist/evidence.mjs';

const markdown=new MarkdownIt({html:false});
const types=new Map([['待探索','explore'],['待跟进','follow_up']]);
export function extractQuestions(body,legacy=false){
 const tokens=markdown.parse(body,{}),results=[];
 let section=null,headingLevel=0,item=null,aiLevel=0;
 for(let i=0;i<tokens.length;i++){
  const t=tokens[i];
  if(t.type==='heading_open'&&t.level===0){
   const level=Number(t.tag.slice(1)),type=types.get(tokens[i+1]?.content.trim());
   if(legacy){
    const heading=tokens[i+1]?.content.trim();
    if(level<=aiLevel)aiLevel=0;
    if(/^(?:AI|人工智能)\s*(?:批注|点评|分析)$/iu.test(heading))aiLevel=level;
    if(!aiLevel||level<=aiLevel){section=null;continue;}
   }
   if(type||level<=headingLevel){section=type;headingLevel=level;}
  }else if(section&&t.type==='list_item_open'&&t.level===1)item=[];
  else if(item&&t.type==='inline')item.push(t.content.trim());
  else if(item&&t.type==='list_item_close'&&t.level===1){
   const text=item.join('\n').trim();if(text&&text.length<=2000)results.push({text,type:section});item=null;
  }
 }
 return results;
}
export const discoveryTables=['exploration_jobs','exploration_work','exploration_job_readers','exploration_config','exploration_legacy'];
export const discoveryDDL=`
 CREATE TABLE IF NOT EXISTS exploration_jobs(id TEXT PRIMARY KEY,mode TEXT NOT NULL,library TEXT NOT NULL,actor TEXT NOT NULL,
   cut INTEGER NOT NULL,cursor INTEGER NOT NULL,scanned INTEGER NOT NULL,status TEXT NOT NULL,created INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS exploration_work(job TEXT NOT NULL,record TEXT NOT NULL,revision INTEGER NOT NULL,
   state TEXT NOT NULL,lease TEXT,expires INTEGER NOT NULL DEFAULT 0,attempts INTEGER NOT NULL DEFAULT 0,
   result TEXT,error TEXT,PRIMARY KEY(job,record,revision));
 CREATE TABLE IF NOT EXISTS exploration_job_readers(job TEXT NOT NULL,actor TEXT NOT NULL,PRIMARY KEY(job,actor));
 CREATE TABLE IF NOT EXISTS exploration_config(id INTEGER PRIMARY KEY CHECK(id=1),enabled INTEGER NOT NULL,model INTEGER NOT NULL,
   revision INTEGER NOT NULL,cursor INTEGER NOT NULL,last_run INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS exploration_legacy(card TEXT PRIMARY KEY,result TEXT NOT NULL);
 INSERT OR IGNORE INTO exploration_config SELECT 1,1,0,1,COALESCE(MAX(seq),0),0 FROM sync_changes;`;
const ruleVersion=1,leaseDuration=120000,pageSize=40;
export function createDiscovery({db,api,lib,putSuggestion}){
 const get=(sql,...args)=>db.prepare(sql).get(...args),all=(sql,...args)=>db.prepare(sql).all(...args);
 const run=(sql,...args)=>db.prepare(sql).run(...args);
 const tx=fn=>db.transaction(fn)();
 const config=()=>get('SELECT * FROM exploration_config WHERE id=1');
 const alive=new AbortController();
 let wake,running=false,interval;
 function schedule(){
  if(!wake&&!running&&!alive.signal.aborted)wake=setImmediate(()=>{wake=null;void pump().catch(e=>{
   if(!alive.signal.aborted)console.error('探索整理任务等待重试',e.message);
  });});
 }
 function settings(){
  const s=config();return {libraryId:lib(),enabled:!!s.enabled,model:!!s.model,revision:s.revision,lastRun:s.last_run,
   jobId:get("SELECT id FROM exploration_jobs ORDER BY created DESC,rowid DESC LIMIT 1")?.id};
 }
 function configure(a){
  const old=config();if(old.revision!==a.expectedRevision)fail('revision_conflict','整理设置已更新',old.revision);
  run('UPDATE exploration_config SET enabled=?,model=?,revision=revision+1 WHERE id=1',Number(a.enabled??!!old.enabled),Number(a.model??!!old.model));
  return settings();
 }
 function start(mode,actor){
  const job=tx(()=>{
   const existing=get("SELECT id FROM exploration_jobs WHERE mode=? AND status IN ('pending','retry') AND library=? ORDER BY created LIMIT 1",mode,lib());
   if(existing){
    run("UPDATE exploration_work SET expires=0 WHERE job=? AND state='retry'",existing.id);
    run("UPDATE exploration_jobs SET status='pending' WHERE id=?",existing.id);return existing.id;
   }
   const high=get('SELECT COALESCE(MAX(seq),0) AS n FROM sync_changes').n;
   const end=mode==='history'?get('SELECT COALESCE(MAX(rowid),0) AS n FROM records').n:high;
   const id='explore-'+randomUUID();
   run('INSERT INTO exploration_jobs VALUES(?,?,?,?,?,?,0,?,?)',id,mode,lib(),actor,end,mode==='history'?end+1:config().cursor,'pending',Date.now());
   return id;
  });
  run('INSERT OR IGNORE INTO exploration_job_readers VALUES(?,?)',job,actor);
  schedule();return {jobId:job};
 }
 function result(id,actor){
  const job=get('SELECT * FROM exploration_jobs WHERE id=? AND library=?',id,lib());
  if(!job||actor!=='desktop'&&!get('SELECT 1 FROM exploration_job_readers WHERE job=? AND actor=?',id,actor))fail('result_expired','找不到此整理任务');
  const counts=all('SELECT state,COUNT(*) n FROM exploration_work WHERE job=? GROUP BY state',id);
  const summary=Object.fromEntries(counts.map(c=>[c.state,c.n]));
  const items=all("SELECT value FROM exploration_work,json_each(exploration_work.result) WHERE job=? AND json_valid(result)",id);
  const outcomes={created:0,existing:0,needs_review:0};
  for(const item of items){const status=JSON.parse(item.value).status;if(status in outcomes)outcomes[status]++;}
  return {status:job.status==='retry'?'failed':job.status,jobId:id,progress:{scanned:job.scanned,checked:summary.done??0,
    total:counts.reduce((n,c)=>n+c.n,0),retry:summary.retry??0,...outcomes},message:job.status==='retry'?'部分材料待重试':undefined};
 }
 function scan(job){
  if(job.status!=='pending')return;
  const rows=job.mode==='history'?all('SELECT rowid AS n,id AS record,revision FROM records WHERE rowid<? AND rowid<=? ORDER BY rowid DESC LIMIT ?',job.cursor,job.cut,pageSize):
   all('SELECT seq AS n,record_id AS record,revision FROM sync_changes WHERE seq>? AND seq<=? ORDER BY seq LIMIT ?',job.cursor,job.cut,pageSize);
  for(const r of rows)run("INSERT OR IGNORE INTO exploration_work(job,record,revision,state) VALUES(?,?,?,'pending')",job.id,r.record,r.revision);
  const cursor=rows.at(-1)?.n??(job.mode==='history'?0:job.cut);
  run('UPDATE exploration_jobs SET cursor=?,scanned=scanned+? WHERE id=?',cursor,rows.length,job.id);
  if(job.mode==='incremental')run('UPDATE exploration_config SET cursor=MAX(cursor,?) WHERE id=1',cursor);
  return rows.length>0;
 }
 function input(work){
  const record=api.get(work.record);if(!record||record.deleted||record.revision!==work.revision)return null;
  const ann=record.annotationOf,parent=ann?api.get(ann.recordId):record;
  if(!parent||parent.deleted)return null;
  const version=ann?get('SELECT revision FROM versions WHERE id=? AND record=?',ann.versionId,parent.id):null;
  if(ann&&version?.revision!==parent.revision)return null;
  const personal=markdownSegments(parent.doc,parent.origin).filter(s=>s.origin==='personal').map(s=>s.text).join('\n').trim();
  if(!personal)return null;
  const body=ann?markdownSource(record.doc):personal;
  return {record,parent,ann,personal,body,signature:hash([ruleVersion,lib(),record.revision,parent.revision,body,personal])};
 }
 function permitted(actor){
  if(actor==='desktop'||actor==='scheduler')return true;
  const client=get('SELECT scopes FROM external_clients WHERE id=? AND revoked IS NULL',actor);
  const scopes=client?JSON.parse(client.scopes):[];
  return scopes.includes('read')&&scopes.includes('create');
 }
 async function process(job,work){
  const current=input(work),model=config(),results=[];
  const commit=(fn,state='done',error=null)=>tx(()=>{
   const now=Date.now(),owned=get('SELECT * FROM exploration_work WHERE job=? AND record=? AND revision=?',job.id,work.record,work.revision);
   if(alive.signal.aborted||lib()!==job.library||owned?.lease!==work.lease||owned.expires<=now)return;
   if(!permitted(job.actor)){state='retry';error='整理权限已撤销';}
   else if(!current||input(work)?.signature!==current.signature){state='stale';}
   else if(config().revision!==model.revision){state='retry';error='整理设置已变化';}
   else if(fn)fn();
   run('UPDATE exploration_work SET state=?,lease=NULL,expires=?,result=?,error=? WHERE job=? AND record=? AND revision=?',
    state,state==='retry'?now+60000:0,JSON.stringify(results),error,job.id,work.record,work.revision);
  });
  if(!current||!permitted(job.actor)){commit();return;}
  const {record,parent,ann,body,personal}=current;
  const source={recordId:parent.id,revision:parent.revision,...(ann?{annotationId:record.id,annotationRevision:record.revision,originalVersionId:ann.versionId}:{})};
  const legacy=job.mode==='history'&&!ann;
  const explicit=extractQuestions(legacy?markdownSource(record.doc):body,legacy);
  let proposed=explicit;
  try{
   if(!ann&&!explicit.length&&job.mode==='incremental'&&model.model){
    const neighbours=all(`SELECT DISTINCT q.id,q.original,q.wording,q.status FROM exploration_questions q JOIN exploration_evidence e ON e.question=q.id
      ORDER BY e.record=? DESC,q.rowid DESC LIMIT 40`,parent.id);
    const prompt='请从本人的材料找明确值得继续探索或跟进的问题。已有问题只作为比对依据，不能替作者决定合并。返回 JSON 数组，每项含 type(explore 或 follow_up)、text、quote(逐字个人原文)，可带 relatedQuestionId。没有发现返回 []。';
    const reply=await api.generateAssist(prompt,JSON.stringify({personal:personal.slice(0,16000),questions:neighbours}),alive.signal);
    if(alive.signal.aborted)return;
    proposed=JSON.parse(reply.trim().replace(/^\x60\x60\x60(?:json)?\s*|\s*\x60\x60\x60$/g,''));
    if(!Array.isArray(proposed)||proposed.some(x=>!x||!['explore','follow_up'].includes(x.type)||typeof x.text!=='string'||!x.text.trim()||x.text.length>2000||typeof x.quote!=='string'||!x.quote||!personal.includes(x.quote)))throw Error('模型返回的问题或原句无效');
   }
   commit(()=>{
    const previous=all('SELECT item,q.original,q.type FROM exploration_discoveries d JOIN exploration_questions q ON q.id=d.question WHERE d.actor=?','library:'+record.id);
    const fresh=proposed.slice(0,100);
    const itemKey=p=>hash([record.id,p.type,p.text.replace(/[\s\p{P}]/gu,'')]);
    const removed=previous.filter(old=>!fresh.some(p=>itemKey(p)===old.item));
    const added=fresh.filter(p=>!previous.some(old=>itemKey(p)===old.item));
    for(const p of fresh){
     const quote=p.quote??[...p.text.matchAll(/[“「]([^”」]+)[”」]/gu)].map(m=>m[1]).find(q=>personal.includes(q));
     const item={externalItemId:ann&&removed.length===1&&added.length===1&&added[0]===p?removed[0].item:itemKey(p),type:p.type,text:p.text,sources:[{...source,...(quote?{quote}:{})}],relatedQuestionId:p.relatedQuestionId};
     results.push(putSuggestion('library:'+record.id,item));
    }
   });
  }catch(e){if(!alive.signal.aborted)commit(null,'retry',String(e.message).slice(0,500));}
 }
 function legacyPage(){
  if(!get("SELECT 1 FROM sqlite_master WHERE name='assist_data'"))return;
  const cards=all(`SELECT id,value FROM assist_data WHERE library=? AND kind='card' AND NOT EXISTS(
   SELECT 1 FROM exploration_legacy l WHERE l.card=assist_data.id) LIMIT ?`,lib(),pageSize);
  for(const r of cards){
   const c=JSON.parse(r.value),sources=(c.quotes??[]).filter(q=>q.recordId&&q.sourceRevision).map(q=>({recordId:q.recordId,revision:q.sourceRevision,field:q.field,quote:q.text,start:q.start,end:q.end,excerptIndex:q.excerptIndex}));
   const outcome=c.question&&sources.length?putSuggestion('legacy-recommendation',{type:'explore',externalItemId:c.cardId,text:c.question,sources}):{status:'no_source'};
   run('INSERT INTO exploration_legacy VALUES(?,?)',r.id,JSON.stringify(outcome));
  }
  return cards.length;
 }
 async function pump(){
  if(running||alive.signal.aborted)return;
  running=true;let more=false;
  try{
   const job=get("SELECT * FROM exploration_jobs WHERE status='pending' AND library=? ORDER BY created LIMIT 1",lib());
   if(!job)return;
   const {work,scanned}=tx(()=>{
    const scanned=scan(job);
    const w=get(`SELECT * FROM exploration_work WHERE job=? AND (state='pending' OR (state IN ('leased','retry') AND expires<=?)) ORDER BY rowid LIMIT 1`,job.id,Date.now());
    if(w){w.lease=randomUUID();run("UPDATE exploration_work SET state='leased',lease=?,expires=?,attempts=attempts+1 WHERE job=? AND record=? AND revision=?",w.lease,Date.now()+leaseDuration,job.id,w.record,w.revision);}
    return {work:w,scanned};
   });
   if(work)await process(job,work);
   if(alive.signal.aborted)return;
   if(!scanned&&!work){
    if(get("SELECT 1 FROM exploration_work WHERE job=? AND state='leased'",job.id))return;
    const retry=get("SELECT 1 FROM exploration_work WHERE job=? AND state='retry'",job.id);
    tx(()=>{
     run('UPDATE exploration_jobs SET status=? WHERE id=?',retry?'retry':'ready',job.id);
     if(!retry&&job.mode==='incremental')run('UPDATE exploration_config SET last_run=? WHERE id=1',Date.now());
    });
   }
   more=true;
  }finally{running=false;if(more)schedule();}
 }
 function tick(){
  if(alive.signal.aborted)return;
  tx(legacyPage);
  const c=config();
  if(c.enabled&&Date.now()-c.last_run>=86400000)start('incremental','scheduler');
  schedule();
 }
 return {start,result,settings,configure,pump,startLifecycle(){tick();interval=setInterval(tick,60000);interval.unref?.();},
  close(){alive.abort();clearImmediate(wake);clearInterval(interval);}};
}
