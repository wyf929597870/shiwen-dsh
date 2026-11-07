export function mergeSessionEvents(current,incoming){
  const map=new Map(current.filter(row=>Number.isSafeInteger(row.event?.seq)).map(row=>[row.event.seq,row]));
  for(const row of incoming??[])if(Number.isSafeInteger(row.event?.seq))map.set(row.event.seq,row);
  return [...map.values()].sort((a,b)=>a.event.seq-b.event.seq);
}
export function sessionEventPresentation(row){
  const event=row?.event;if(!event)return null;
  const contentText=content=>(content??[]).filter(part=>part.type==='text').map(part=>part.text).join('\n');
  if(event.type==='user/message')return {role:'user',text:contentText(event.data.content)};
  if(event.type==='assistant/message')return {role:'assistant',text:contentText(event.data.message?.content),interrupted:Boolean(event.data.interrupted)};
  // Preserve unfamiliar tool/event structures for inspection without interpreting them as executable markup.
  if(event.type?.includes('tool'))return {role:'tool',text:JSON.stringify(event.data,null,2),label:event.type};
  return null;
}
