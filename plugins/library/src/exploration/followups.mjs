import {markdownSegments} from '../../legacy/markdown.mjs';

// Score exact overlapping Chinese bigrams and whole Latin words. Keep offsets in
// the original spans so a repeated sentence can still be linked unambiguously.
const common=new Set('今天 昨天 后来 这个 那个 时候 什么 怎么 为什么 如何 是否 自己 一个 我的 我在 可以 已经 还是 如果 因为 觉得 有点 事情 之后 开始 继续 可能 真的 我想 发现 the and that with from this'.split(' '));
function terms(text){
  const out=new Set();
  for(const [word] of text.toLowerCase().matchAll(/[\p{Script=Han}]+|[a-z\d]{3,}/gu)){
    if(/^[a-z\d]/u.test(word))out.add(word);
    else for(let i=1;i<word.length;i++)out.add(word.slice(i-1,i+1));
  }
  for(const word of common)out.delete(word);
  return out;
}

export function followupPassages(record){
  if(record.origin!=='personal'||!['journal','freewrite','idea','reading_note','article'].includes(record.kind))return [];
  let offset=0;const passages=[];
  for(const span of markdownSegments(record.doc,record.origin)){
    if(span.origin==='personal')for(const match of span.text.matchAll(/[^\r\n。！？!?]{1,240}[。！？!?]?/gu)){
      const quote=match[0].trim();
      const words=terms(quote);
      if(quote.length<6||words.size<2)continue;
      const start=offset+match.index+match[0].indexOf(quote);
      passages.push({words,locator:{quote,start,end:start+quote.length,field:record.kind==='reading_note'?'reflection':'body'}});
    }
    offset+=span.text.length;
  }
  return passages;
}

export function matchFollowup(passages,question,context){
  const topic=terms(question),background=terms(context);
  let best=null;
  for(const {words,locator} of passages){
    let direct=0,extra=0;
    for(const word of words){
      if(topic.has(word))direct++;
      else if(background.has(word))extra++;
    }
    const score=direct*2+Math.min(extra,4);
    if(score>=4 && (!best||score>best.score))best={score,locator};
  }
  return best;
}
