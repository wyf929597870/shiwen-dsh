import {decodeReadingNote} from '../../library/legacy/reading-note.mjs';

export function readingSourceCards(records){
 const seen=new Set();
 return records.flatMap(record=>{
  if(seen.has(record.id))return [];seen.add(record.id);
  const metadata=decodeReadingNote(record.annotation);
  if(!metadata)return [{...record,kind:'reading_note',cardId:`${record.id}:unknown`,metadata:null,excerpt:null}];
  const excerpts=metadata.excerpts.length?metadata.excerpts:[null];
  return excerpts.map((excerpt,index)=>({...record,kind:'reading_note',cardId:`${record.id}:${index}`,metadata,excerpt,sharedReflection:metadata.excerpts.length>1}));
 });
}
export function materialTypes(records){
 return [...new Set(records.map(row=>row.kind).filter(kind=>typeof kind==='string'&&kind.trim()&&kind!=='reading_note'))];
}
export function matchesSource(card,query){
 const needle=query.trim().toLocaleLowerCase();
 return !needle||[card.title,card.body,card.markdown,card.metadata?.chapter,card.excerpt?.text].join(' ').toLocaleLowerCase().includes(needle);
}
export function sourceCitation(card,zh=true){
 if(card.kind!=='reading_note')return '';
 const book=card.title?.trim(),chapter=card.metadata?.chapter?.trim(),page=(card.excerpt?.page||card.metadata?.page||'').trim();
 return [!card.excerpt?(zh?'个人感想':'Personal reflection'):'',book?`《${book}》`:'',chapter,page?`${zh?'页码':'Page'} ${page}`:''].filter(Boolean).join(' · ');
}
export function insertSourceQuote(body,cursor,sources,source,text){
 const pos=Math.max(0,Math.min(cursor??body.length,body.length));
 const safeCitation=String(source.citation||'').replace(/[\r\n]+/g,' ').replace(/[\\`*_{}\[\]()<>#!|~]/g,'\\$&');
 const citation=safeCitation?`\n>\n> — ${safeCitation}`:'';
 const quote=text.split(/\r?\n/).map(line=>'> '+line).join('\n')+citation;
 const prefix=pos&&body[pos-1]!=='\n'?'\n\n':pos&&body[pos-2]!=='\n'?'\n':'';
 const suffix=body.slice(pos)&&!body.slice(pos).startsWith('\n')?'\n\n':'\n';
 return {body:body.slice(0,pos)+prefix+quote+suffix+body.slice(pos),sources:sources.includes(source.id)?sources:[...sources,source.id],cursor:pos+prefix.length+quote.length+suffix.length};
}
