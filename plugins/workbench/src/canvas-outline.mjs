// Paths are sibling positions on the canvas, independent of selection order.
function comparePaths(a,b){
  const length=Math.min(a.length,b.length);
  for(let i=0;i<length;i++)if(a[i]!==b[i])return a[i]-b[i];
  return a.length-b.length;
}

const oneLine=text=>String(text??'').replace(/\s+/gu,' ').trim();
const markdownText=text=>text.replace(/[\\`*_\[\]<>#!|~]/gu,'\\$&');
function shorten(text,limit){
  const chars=Array.from(text);
  return chars.length>limit?chars.slice(0,limit-1).join('')+'…':text;
}

export function canvasOutline(selection,t){
  const cards=[...selection].sort((a,b)=>comparePaths(a.path,b.path));
  const lines=[],parents=[];
  let topic='';
  for(const card of cards){
    while(parents.length&&!parents.at(-1).every((n,i)=>card.path[i]===n))parents.pop();
    const content=card.match?.text||card.text||'';
    const points=content.split(/\n+|(?<=[。！？])|(?<=[.!?])\s+/u)
      .map(line=>oneLine(line.replace(/^\s*(?:#{1,6}\s+|[-*>]\s+)/u,''))).filter(Boolean);
    const heading=oneLine(card.title)||shorten(points[0]||t('未命名','Untitled'),60);
    if(!topic)topic=heading;
    lines.push('#'.repeat(Math.min(2+parents.length,6))+' '+markdownText(heading));
    const supporting=[...new Set(points)].filter(point=>point!==heading).slice(0,3);
    if(supporting.length)lines.push('',...supporting.map(point=>'- '+markdownText(shorten(point,180))));
    lines.push('');
    parents.push(card.path);
  }
  return {
    title:shorten(topic,80)+t(' · 文章大纲',' · Article outline'),
    body:lines.join('\n').trim(),
    sourceIds:cards.filter(card=>card.kind!=='article').map(card=>card.recordId)
  };
}
