import {markdownSegments} from '../../legacy/markdown.mjs';
import {decodeReadingNote} from '../../legacy/reading-note.mjs';

export function periodKeys(now,timeZone){
  const day=new Intl.DateTimeFormat('sv-SE',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
  const monday=new Date(day+'T12:00:00Z');
  monday.setUTCDate(monday.getUTCDate()-(monday.getUTCDay()+6)%7);
  return {day,week:monday.toISOString().slice(0,10)};
}

export const normalizedQuestion=text=>text.trim().replace(/\s+/gu,' ');
export const eligibleForHome=(status,sources,manual=false)=>status==='accepted'&&sources.some(s=>manual||s.personal);

export function locateSource(row,input){
  const segments=markdownSegments(row.doc,row.origin);
  const hasPersonal=segments.some(s=>s.origin==='personal'&&s.text.trim());
  const reading=row.kind==='reading_note';
  const label=reading?'来自这篇笔记':'来自这篇记录';
  const base={recordId:row.id,revision:row.revision,scope:'record',title:row.title,kind:row.kind,contentDay:row.contentDay,
    label,personal:!reading&&hasPersonal&&segments.every(s=>!s.text.trim()||s.origin==='personal'),hasPersonal};
  if(!input.quote)return base;
  const fields=[];let offset=0;
  for(const segment of segments){
    fields.push({...segment,field:reading?'reflection':row.kind==='ai_annotation'?'annotation':'body',offset});
    offset+=segment.text.length;
  }
  if(reading){
    for(const [excerptIndex,excerpt] of (decodeReadingNote(row.annotation)?.excerpts??[]).entries()){
      fields.push({text:excerpt.text,origin:'external',field:'excerpt',offset:0,excerptIndex});
    }
  }
  const matches=[];
  for(const f of fields){
    if(input.field&&f.field!==input.field||input.excerptIndex!==undefined&&input.excerptIndex!==f.excerptIndex)continue;
    for(let at=f.text.indexOf(input.quote);at!==-1;at=f.text.indexOf(input.quote,at+1)){
      const start=f.offset+at,end=start+input.quote.length;
      if(input.start!==undefined&&(start!==input.start||end!==input.end))continue;
      matches.push({...base,scope:'passage',field:f.field,origin:f.origin,quote:input.quote,start,end,
        ...(f.excerptIndex===undefined?{}:{excerptIndex:f.excerptIndex}),personal:f.origin==='personal',
        label:f.field==='excerpt'?'书中原文':f.origin==='personal'?'我的原句':f.origin==='ai'?'AI 原话':'来源原文'});
      if(matches.length>1)return {...base,personal:false};
    }
  }
  return matches[0]??{...base,personal:false};
}

export function nextStatus(question,action){
  if(action==='restore'){
    if(question.status!=='skipped')throw Error('只有已略过的问题可以恢复');
    return question.previous_status??'pending';
  }
  return {accept:'accepted',rewrite:'accepted',observe:'observing',skip:'skipped',answered:'answered',continue:'accepted'}[action];
}
