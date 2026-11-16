import {decodeReadingNote} from '../../../library/legacy/reading-note.mjs';

// Old records may contain several excerpts with one shared reflection. Keep the
// record and its revision intact; each card only projects one excerpt.
export function readingCards(records){
 return records.flatMap(record=>{
  const metadata=decodeReadingNote(record.annotation);
  const excerpts=metadata?.excerpts??[];
  if(!excerpts.length)return [{...record,cardId:`${record.id}:thought`,excerpt:null,sharedReflection:false}];
  return excerpts.map((excerpt,index)=>({...record,cardId:`${record.id}:${index}`,excerpt,sharedReflection:excerpts.length>1}));
 });
}
