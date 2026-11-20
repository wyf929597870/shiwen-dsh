import {markdownSource} from '../../legacy/markdown.mjs';
import {decodeReadingNote} from '../../legacy/reading-note.mjs';

// Preserve original UTF-16 offsets rather than anchoring a rendered document.
export async function splitText(text, {size=384, overlap=32, countTokens, prefix=''}={}) {
  if (!text) return [];
  if(typeof countTokens!=='function')throw new Error('countTokens is required');
  const points=Array.from(text), offsets=[0];
  for (const point of points) offsets.push(offsets.at(-1)+point.length);
  const chunks=[];
  for (let start=0; start<points.length;) {
    let end=Math.min(start+size,points.length), low=start+1, high=end, fitting=start;
    while(low<=high){const mid=Math.floor((low+high)/2);if(await countTokens(prefix+text.slice(offsets[start],offsets[mid]))<=512){fitting=mid;low=mid+1;}else high=mid-1;}
    if(fitting===start)throw new Error('Token limit cannot fit a single character');
    end=fitting;
    if(end<points.length) {
      for(let i=end;i>start+Math.floor(size/2);i--) {
        if(/[\n。！？!?；;]/u.test(points[i-1])) {end=i;break;}
      }
    }
    chunks.push({start:offsets[start],end:offsets[end],text:text.slice(offsets[start],offsets[end])});
    if(end===points.length)break;
    start=Math.max(start+1,end-overlap);
  }
  return chunks;
}

export async function recordChunks(record, countTokens) {
  const reading=record.kind==='reading_note', metadata=reading?decodeReadingNote(record.annotation):null;
  const fields=[['title',record.title??'',null], [reading?'reflection':'body',markdownSource(record.doc),null]];
  for(const [index,excerpt] of (metadata?.excerpts??[]).entries()) fields.push(['excerpt',excerpt.text,index]);
  const result=[];
  for(const [field,text,excerptIndex] of fields){
    const prefix=field==='title'?'':`${Array.from(record.title??'').slice(0,32).join('')}\n`;
    for(const chunk of await splitText(text,{countTokens,prefix}))result.push({...chunk,field,excerptIndex,input:prefix+chunk.text});
  }
  return result;
}
