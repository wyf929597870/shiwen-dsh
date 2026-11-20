import {mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import Database from '../../legacy/sqlite.mjs';
import {markdownSource} from '../../legacy/markdown.mjs';
import {decodeReadingNote} from '../../legacy/reading-note.mjs';
import {sectionKinds} from '../../legacy/record-sections.mjs';
import {recordChunks} from './chunk.mjs';

// BGE cosine similarity cutoff for unsolicited canvas suggestions.
const canvasMinSimilarity=0.55;
const chunkVersion='chunks-v1';
const digest=row=>createHash('sha256').update(JSON.stringify([row.id,row.revision,row.kind,row.title,row.doc,row.annotation,row.origin,row.url,row.stage,row.contentDay])).digest('hex');
const allowed=row=>row&&!row.deleted&&row.kind!=='ai_annotation';
const metadata=row=>row.kind==='reading_note'?decodeReadingNote(row.annotation):null;
const matches=(row,scope,f)=>{
  if(!allowed(row))return false;
  if(scope==='records'&&!sectionKinds.library.includes(row.kind)||scope==='collections'&&!sectionKinds.collections.includes(row.kind))return false;
  if(scope==='articles'&&row.kind!=='article'||scope==='reading'&&row.kind!=='reading_note'||['materials','writingSources'].includes(scope)&&row.kind==='article')return false;
  if(f.kind&&row.kind!==f.kind||f.stage&&row.stage!==f.stage)return false;
  if(f.start&&(!row.contentDay||row.contentDay<f.start)||f.end&&(!row.contentDay||row.contentDay>f.end))return false;
  const m=metadata(row);
  if(f.book&&(row.kind!=='reading_note'||row.title!==f.book)||f.chapter&&m?.chapter!==f.chapter||f.noteType&&m?.noteType!==f.noteType)return false;
  if(scope==='writingSources'&&f.sourceScope==='linked'&&!(f.selectedIds??[]).includes(row.id))return false;
  return true;
};
const dot=(a,b)=>{let sum=0;for(let i=0;i<a.length;i++)sum+=a[i]*b[i];return sum;};
function contextRange(text,start,end){
  let left=Math.max(0,start-100),right=Math.min(text.length,end+100);
  if(left>0&&/[\uDC00-\uDFFF]/u.test(text[left]))left--;
  if(right<text.length&&/[\uDC00-\uDFFF]/u.test(text[right]))right++;
  return {start:left,end:right,text:text.slice(left,right)};
}
const cards=(row,chunk,scope)=>{
  if(row.kind!=='reading_note'||!['reading','writingSources','global'].includes(scope))return [null];
  const excerpts=metadata(row)?.excerpts??[];
  if(chunk.field==='excerpt')return [`${row.id}:${chunk.excerptIndex}`];
  return excerpts.length?excerpts.map((_,i)=>`${row.id}:${i}`):[`${row.id}:thought`];
};
function item(row,chunk,cardId){
  const m=metadata(row), n=cardId&&cardId.endsWith(':thought')?null:cardId?Number(cardId.slice(cardId.lastIndexOf(':')+1)):chunk.excerptIndex;
  return {recordId:row.id,revision:row.revision,kind:row.kind,title:row.title,contentDay:row.contentDay??null,origin:row.origin,url:row.url??'',cardId,
    book:m?row.title:null,chapter:m?.chapter??null,page:(n!==null&&n!==undefined?m?.excerpts[n]?.page:null)||m?.page||null,noteType:m?.noteType??null,
    match:{field:chunk.field,text:chunk.text,anchor:{start:chunk.start,end:chunk.end,excerptIndex:chunk.excerptIndex??null}}};
}

// Exact search must remain available even when the disposable index cannot
// be opened (for example, because its directory is damaged or read-only).
export function searchExact({library,rows},request){
  const {query='',scope='materials',filters={},offset=0,limit=20}=request,term=query.trim().toLocaleLowerCase();
  if(!term)return {items:[],total:0,nextOffset:null};
  const found=[],seen=new Set();
  for(const row of rows??(library.searchSnapshot?library.searchSnapshot():library.snapshot().records)){
    if(!matches(row,scope,filters))continue;
    const m=metadata(row), fields=[['title',row.title??'',null],[row.kind==='reading_note'?'reflection':'body',markdownSource(row.doc),null],...(['global','reading'].includes(scope)&&m?[['chapter',m.chapter??'',null]]:[]),...(m?.excerpts??[]).map((x,i)=>['excerpt',x.text,i])];
    for(const [field,text,excerptIndex] of fields){const start=text.toLocaleLowerCase().indexOf(term);if(start<0)continue;const chunk={field,...contextRange(text,start,start+term.length),excerptIndex};for(const cardId of cards(row,chunk,scope)){const key=cardId??row.id;if(!seen.has(key)){seen.add(key);found.push(item(row,chunk,cardId));}}}
  }
  return {items:found.slice(offset,offset+limit),total:found.length,nextOffset:offset+limit<found.length?offset+limit:null};
}

// The derived database is disposable. Snapshot comparison on every search is
// deliberate: import, sync, and agent writes bypass the workbench RPC layer.
export function createSearchIndex({library,directory,embed,countTokens,modelVersion='bge-small-zh-v1.5'}) {
  if(!library||!directory||typeof embed!=='function'||typeof countTokens!=='function')throw new Error('Invalid search index dependencies');
  mkdirSync(directory,{recursive:true});
  const db=new Database(join(directory,'search.sqlite'));
  try{
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS records(id TEXT PRIMARY KEY,hash TEXT NOT NULL); CREATE TABLE IF NOT EXISTS chunks(record_id TEXT NOT NULL, data TEXT NOT NULL, vector TEXT NOT NULL); CREATE INDEX IF NOT EXISTS chunks_record ON chunks(record_id)');
  const version=`${modelVersion}:${chunkVersion}`;
  const prior=db.prepare("SELECT value FROM meta WHERE key='version'").get()?.value;
  if(prior!==version)db.transaction(()=>{db.exec('DELETE FROM chunks; DELETE FROM records');db.prepare("INSERT OR REPLACE INTO meta VALUES('version',?)").run(version);})();
  let closed=false, started=false, running=false, closePromise=null,closeResolve=null,closeReject=null, error=null, completed=0, total=0, initial=prior===version&&db.prepare("SELECT value FROM meta WHERE key='complete'").get()?.value===version, generation=0;
  if(prior!==version)db.prepare("DELETE FROM meta WHERE key='complete'").run();
  const pending=new Map(), vectorCache=new Map(), indexAbort=new AbortController();let vectorCacheBytes=0;
  const removeCached=id=>{const entry=vectorCache.get(id);if(entry){vectorCacheBytes-=entry.bytes;vectorCache.delete(id);}};
  const list=()=>(library.searchSnapshot?library.searchSnapshot():library.snapshot().records).filter(allowed);
  function reconcile(){
    if(closed)return [];
    const rows=list(), present=new Set(rows.map(x=>x.id));
    const indexed=new Map(db.prepare('SELECT id,hash FROM records').all().map(row=>[row.id,row.hash]));
    for(const id of indexed.keys())if(!present.has(id)){db.transaction(()=>{db.prepare('DELETE FROM chunks WHERE record_id=?').run(id);db.prepare('DELETE FROM records WHERE id=?').run(id);})();pending.delete(id);removeCached(id);}
    for(const row of rows){const h=digest(row);if(indexed.get(row.id)!==h)pending.set(row.id,h);else pending.delete(row.id);}
    total=rows.length;completed=rows.length-pending.size;
    if(started&&pending.size&&!running&&!error)void drain();
    return rows;
  }
  async function drain(){
    if(running||closed)return;running=true;
    try{
      while(pending.size&&!closed){
        const [id,hash]=pending.entries().next().value, row=library.get(id), runGeneration=generation;
        if(!allowed(row)||digest(row)!==hash){pending.delete(id);reconcile();continue;}
        const chunks=await recordChunks(row,text=>countTokens(text,{signal:indexAbort.signal})), vectors=[];
        for(let i=0;i<chunks.length;i+=16){const batch=await embed(chunks.slice(i,i+16).map(c=>c.input),{priority:'index',signal:indexAbort.signal});if(!Array.isArray(batch)||batch.length!==Math.min(16,chunks.length-i))throw new Error('Invalid embedding batch');vectors.push(...batch);}
        if(closed)break;
        const latest=library.get(id);
        if(generation!==runGeneration||!allowed(latest)||digest(latest)!==hash){pending.delete(id);reconcile();continue;}
        db.transaction(()=>{db.prepare('DELETE FROM chunks WHERE record_id=?').run(id);const insert=db.prepare('INSERT INTO chunks VALUES(?,?,?)');for(let i=0;i<chunks.length;i++)insert.run(id,JSON.stringify(chunks[i]),JSON.stringify(Array.from(vectors[i])));db.prepare('INSERT OR REPLACE INTO records VALUES(?,?)').run(id,hash);})();removeCached(id);
        if(pending.get(id)===hash)pending.delete(id);completed++;
        await new Promise(resolve=>setImmediate(resolve));
      }
      if(!closed&&!pending.size){initial=true;db.prepare("INSERT OR REPLACE INTO meta VALUES('complete',?)").run(version);}
    }catch(e){error=e;}finally{running=false;if(closed&&closeResolve){try{db.close();closeResolve();}catch(e){closeReject(e);}}}
  }
  reconcile();
  const timer=setInterval(()=>{try{reconcile();}catch(e){error=e;}},2000);timer.unref();
  async function search(request){
    const {query='',mode='exact',scope='materials',filters={},offset=0,limit=20}=request, rows=reconcile().filter(row=>matches(row,scope,filters));
    const term=query.trim().toLocaleLowerCase();if(!term)return {items:[],total:0,nextOffset:null};
    if(mode==='exact')return searchExact({library,rows},request);
    if(mode==='semantic'&&(!started||!initial)){const e=new Error('语义索引尚未准备好');e.code='SEMANTIC_NOT_READY';throw e;}
    const found=[];let currentRows=rows;
    if(mode==='semantic'){
      const [vector]=await embed([query],{priority:'query'});
      const current=new Map(list().map(row=>[row.id,row]));
      currentRows=rows.filter(row=>{const latest=current.get(row.id);return latest&&digest(row)===digest(latest)&&matches(latest,scope,filters);});
      const indexed=new Map(db.prepare('SELECT id,hash FROM records').all().map(row=>[row.id,row.hash]));
      for(const row of currentRows){const hash=digest(row);if(indexed.get(row.id)!==hash)continue;
        let cached=vectorCache.get(row.id);
        if(!cached||cached.hash!==hash){removeCached(row.id);const chunks=db.prepare('SELECT data,vector FROM chunks WHERE record_id=?').all(row.id).map(saved=>({chunk:JSON.parse(saved.data),v:Float64Array.from(JSON.parse(saved.vector))}));const bytes=chunks.reduce((n,c)=>n+c.v.byteLength+2*((c.chunk.text?.length??0)+(c.chunk.input?.length??0))+256,0);cached={hash,chunks,bytes};const maxBytes=64*1024*1024;while(vectorCacheBytes+bytes>maxBytes&&vectorCache.size)removeCached(vectorCache.keys().next().value);if(bytes<=maxBytes){vectorCache.set(row.id,cached);vectorCacheBytes+=bytes;}}
        const canvasTitleOnly=scope==='ideaCanvas'&&row.kind==='idea'&&cached.chunks.every(({chunk})=>chunk.field==='title');
        for(const {chunk,v} of cached.chunks){if(v.length!==vector.length)continue;
          if(scope==='ideaCanvas'&&chunk.field==='title'&&!canvasTitleOnly)continue;
          const score=dot(vector,v);
          if(scope==='ideaCanvas'&&score<canvasMinSimilarity)continue;
          for(const cardId of cards(row,chunk,scope))found.push({row,chunk,cardId,score});
        }
      }
      found.sort((a,b)=>b.score-a.score||String(a.cardId??a.row.id).localeCompare(String(b.cardId??b.row.id)));
    }
    const seen=new Set(),items=[];
    for(const entry of found){const key=entry.cardId??entry.row.id;if(seen.has(key))continue;seen.add(key);items.push(item(entry.row,entry.chunk,entry.cardId));}
    return {items:items.slice(offset,offset+limit),total:items.length,nextOffset:offset+limit<items.length?offset+limit:null};
  }
  return {search,status(){return {state:error?'failed':!started?'missing':!initial?'indexing':running||pending.size?'updating':'ready',completed,total,error:error?{code:'INDEX_FAILED',message:'索引更新失败',retryable:true}:null,canSearchSemantic:started&&initial};},
    start(){started=true;error=null;reconcile();if(!pending.size&&!running){initial=true;db.prepare("INSERT OR REPLACE INTO meta VALUES('complete',?)").run(version);}return this.status();},
    notifyChange(){reconcile();},rebuild(){error=null;started=true;generation++;initial=false;pending.clear();vectorCache.clear();vectorCacheBytes=0;db.transaction(()=>{db.exec('DELETE FROM chunks; DELETE FROM records');db.prepare("DELETE FROM meta WHERE key='complete'").run();})();reconcile();if(!pending.size&&!running){initial=true;db.prepare("INSERT OR REPLACE INTO meta VALUES('complete',?)").run(version);}return this.status();},
    close(){if(closePromise)return closePromise;closed=true;indexAbort.abort();clearInterval(timer);vectorCache.clear();vectorCacheBytes=0;if(!running){try{db.close();closePromise=Promise.resolve();}catch(e){closePromise=Promise.reject(e);}return closePromise;}closePromise=new Promise((resolve,reject)=>{closeResolve=resolve;closeReject=reject;});return closePromise;}};
  }catch(error){db.close();throw error;}
}
