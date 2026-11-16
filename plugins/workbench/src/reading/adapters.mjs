import {validateReadingNote} from '../../../library/legacy/reading-note.mjs';
export function desktopReadingNotes(rpc){
 return {list:()=>rpc('readingNoteList'),save:pending=>rpc('readingNoteSave',{...pending.input,requestId:pending.requestId}),remove:pending=>rpc('remove',{id:pending.id,revision:pending.revision,requestId:pending.requestId})};
}
// Cache only complete records, scoped to the bridge and library for this session.
const mobileCaches=new WeakMap();
export function mobileReadingNotes(request,libraryId){
 let libraries=mobileCaches.get(request);if(!libraries){libraries=new Map();mobileCaches.set(request,libraries);}
 let cache=libraries.get(libraryId);if(!cache){cache=new Map();libraries.set(libraryId,cache);}
 const check=signal=>{if(signal?.aborted)throw Object.assign(new Error('读取已取消'),{name:'AbortError'});};
 return {
  async list({onProgress,signal}={}){
   const records=[];let cursor=null;const seen=new Set();
   do{check(signal);const page=await request('recordList',{libraryId,kind:'reading_note',cursor,limit:100});check(signal);records.push(...page.items.filter(r=>['personal','external'].includes(r.origin)&&!r.deleted));cursor=page.nextCursor??null;if(cursor&&seen.has(cursor))throw Error('笔记列表分页未前进，请重试');seen.add(cursor);}while(cursor);
   const full=new Map(),missing=[];
   for(const row of records){const cached=cache.get(row.id);if(row.revision!=null&&cached?.revision===row.revision&&cached.updatedAt===row.updatedAt)full.set(row.id,{...cached,...row});else missing.push(row);}
   let loaded=full.size;
   const report=()=>{check(signal);const result=records.map(row=>full.get(row.id)).filter(Boolean);onProgress?.({scope:libraryId,records:result,loaded,total:records.length});return result;};
   report();
   for(let i=0;i<missing.length;i+=8){check(signal);const batch=await Promise.all(missing.slice(i,i+8).map(row=>request('recordRead',{libraryId,id:row.id})));check(signal);for(const row of batch){if(row.kind==='reading_note'&&['personal','external'].includes(row.origin)&&!row.deleted){full.set(row.id,row);cache.set(row.id,row);}else cache.delete(row.id);}loaded+=batch.length;report();}
   const ids=new Set(records.map(row=>row.id));for(const id of cache.keys())if(!ids.has(id))cache.delete(id);
   return {scope:libraryId,records:records.map(row=>full.get(row.id)).filter(Boolean)};
  },
  async remove(pending){
   const result=await request('recordDelete',{libraryId,id:pending.id,expectedRevision:pending.revision,requestId:pending.requestId});cache.delete(pending.id);return result;
  },
  async save(pending){
   const {input,requestId,recordId,generation}=pending,value=validateReadingNote(input);
   const fields={title:value.book,markdown:value.reflection,contentDay:value.day,dateBasis:'读书笔记记录日期',annotation:value.annotation,sources:readingSources(input.baseline,value.reflection)};
   const result=input.id?await request('recordUpdate',{libraryId,id:input.id,expectedRevision:input.revision,requestId,localGeneration:generation,patch:fields}):await request('recordCreate',{libraryId,requestId,localGeneration:generation,record:{...fields,id:recordId,kind:'reading_note',origin:'personal',processing:'original',url:'',stage:'draft',sourceIds:[]}});
   return result.record;
  }
 };
}

// Preserve unchanged provenance when editing a mobile note. The baseline travels
// with the durable draft, keeping retry payloads identical after a lost response.
export function readingSources(baseline,after){
 const before=baseline?.markdown??'',segments=baseline?.sources??[];
 if(segments.map(x=>x.text).join('')!==before)throw Error('笔记来源信息格式不完整，请重新打开笔记');
 if(before===after)return segments;
 let prefix=0;while(prefix<before.length&&prefix<after.length&&before[prefix]===after[prefix])prefix++;
 let suffix=0;while(suffix<before.length-prefix&&suffix<after.length-prefix&&before.at(-suffix-1)===after.at(-suffix-1))suffix++;
 const cut=(start,end)=>{let at=0;return segments.flatMap(x=>{const lo=Math.max(0,start-at),hi=Math.min(x.text.length,end-at);at+=x.text.length;return hi>lo?[{...x,text:x.text.slice(lo,hi)}]:[];});};
 return [...cut(0,prefix),...(after.length-prefix-suffix?[{text:after.slice(prefix,after.length-suffix),origin:'personal'}]:[]),...cut(before.length-suffix,before.length)];
}
