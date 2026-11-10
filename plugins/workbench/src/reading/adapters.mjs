import {validateReadingNote} from '../../../library/legacy/reading-note.mjs';
export function desktopReadingNotes(rpc){
 return {list:()=>rpc('readingNoteList'),save:pending=>rpc('readingNoteSave',{...pending.input,requestId:pending.requestId})};
}
export function mobileReadingNotes(request,libraryId){
 return {
  async list(){
   const records=[];let cursor=null;const seen=new Set();
   do{const page=await request('recordList',{libraryId,kind:'reading_note',cursor,limit:100});records.push(...page.items.filter(r=>r.origin==='personal'&&!r.deleted));cursor=page.nextCursor??null;if(cursor&&seen.has(cursor))throw Error('笔记列表分页未前进，请重试');seen.add(cursor);}while(cursor);
   const full=[];for(let i=0;i<records.length;i+=8){const batch=await Promise.all(records.slice(i,i+8).map(row=>request('recordRead',{libraryId,id:row.id})));full.push(...batch.filter(row=>row.kind==='reading_note'&&row.origin==='personal'&&!row.deleted));}
   return {scope:libraryId,records:full};
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
