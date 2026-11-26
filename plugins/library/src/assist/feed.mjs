import {clean,hash} from './evidence.mjs';

// Keep actual day changes distinguishable from the daily reading selection.
export function dailyPicks(items,day){
  const changed=items.filter(item=>item.todayUpdate?.day===day);
  const ranked=items.filter(item=>!changed.includes(item)).map(item=>({item,key:hash([day,item.cardId])}));
  ranked.sort((a,b)=>a.key.localeCompare(b.key));
  return [...changed,...ranked.map(r=>r.item)].slice(0,2);
}
export function* rereadCandidates(rows,used,readPassages,seen=new Set()){
  for(const row of [...rows].sort((a,b)=>b.updated.localeCompare(a.updated)||a.id.localeCompare(b.id))){
    if(used.has(row.id))continue;
    const quotes=readPassages(row);
    const q=quotes.find(q=>q.field==='excerpt')??quotes.find(q=>q.text.trim().length>=12)??quotes[0];
    if(!q)continue;
    const content=clean(q.text);
    if(!content||seen.has(content))continue;
    seen.add(content);
    const question='重读 · '+(row.title||q.text).slice(0,90);
    const reason=q.text,followup='现在重读这段话，你会保留或补充什么？';
    yield {scene:'revisit',question,reason,followup,quotes:[q],relations:[{type:'revisit',relationId:hash(['revisit',q.quoteId]),quoteIds:[q.quoteId],reason,followup}]};
  }
}
