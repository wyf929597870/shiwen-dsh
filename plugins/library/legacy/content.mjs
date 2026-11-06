import { diffChars } from 'diff';
export const kinds = ['journal', 'freewrite', 'idea', 'web', 'ai', 'article', 'reference'];
export const origins = ['personal', 'external', 'ai', 'translation', 'unknown'];
export const plainDoc = (text = '', origin = 'personal') => ({type:'doc',content:text.split('\n').map(line=>({type:'paragraph',content:line?[{type:'text',text:line,...(origin!=='personal'?{marks:[{type:'provenance',attrs:{origin}}]}:{})}]:[]}))});
export function readDoc(doc, fallback='personal') {
  const groups=Object.fromEntries(origins.map(x=>[x,''])); let text=''; let nodes=0;
  function visit(node, depth=0) {
    if(depth>30 || ++nodes>100000) throw new Error('内容结构过大');
    if(!node || typeof node!=='object') throw new Error('无效的正文结构');
    if(node.type==='text') {
      if(typeof node.text!=='string') throw new Error('无效的正文文本');
      const mark=node.marks?.find(m=>m.type==='provenance');
      const origin=mark?.attrs?.origin??fallback;
      if(!origins.includes(origin)) throw new Error('无效的内容来源');
      groups[origin]+=node.text; text+=node.text;
    }
    for(const child of node.content??[]) visit(child,depth+1);
    if(['paragraph','heading','blockquote','listItem'].includes(node.type)) text+='\n';
  }
  if(doc?.type!=='doc') throw new Error('无效的文档');
  if(JSON.stringify(doc).length>2000000) throw new Error('单条内容超过大小限制');
  visit(doc); return {text:text.trim(),groups};
}
export const count = s => [...s.replace(/\s/g,'')].length;
export function changes(before,after) {
  let added=0, removed=0;
  for(const part of diffChars(before,after)) {if(part.added) added+=count(part.value); if(part.removed) removed+=count(part.value);}
  return {added,removed};
}
export function dateKey(value, timeZone=Intl.DateTimeFormat().resolvedOptions().timeZone) {
  const parts=new Intl.DateTimeFormat('en-US',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(value));
  const val=k=>parts.find(p=>p.type===k)?.value;
  return `${val('year')}-${val('month')}-${val('day')}`;
}
export function dateRange(period='7', month, now=new Date(), timeZone) {
  const today=dateKey(now,timeZone); let start=today,end=today;
  const shift=(key,days)=>{const d=new Date(`${key}T12:00:00Z`); d.setUTCDate(d.getUTCDate()+days);return d.toISOString().slice(0,10);};
  if(period==='month') {
    if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month??'')) throw new Error('请选择有效月份');
    start=month+'-01'; const d=new Date(start+'T12:00:00Z'); d.setUTCMonth(d.getUTCMonth()+1);d.setUTCDate(0);end=d.toISOString().slice(0,10);
    if(month===today.slice(0,7))end=today;
  } else {if(!['1','7','14','30'].includes(String(period)))throw new Error('无效的时间范围');start=shift(today,1-Number(period));}
  const days=[]; for(let key=start;key<=end;key=shift(key,1))days.push(key);
  return {start,end,days,timeZone:timeZone??Intl.DateTimeFormat().resolvedOptions().timeZone};
}

// Export the editable structure rather than dropping headings and lists.
export function toMarkdown(doc) {
  readDoc(doc);
  const escape=text=>text.replace(/([\\`*_\[\]<>])/g,'\\$1');
  function render(node){
    if(node.type==='text'){let text=escape(node.text);for(const mark of node.marks??[]){if(mark.type==='bold')text=`**${text}**`;if(mark.type==='italic')text=`*${text}*`;if(mark.type==='strike')text=`~~${text}~~`;if(mark.type==='code')text='`'+node.text.replaceAll('`','\\`')+'`';if(mark.type==='link'&&/^https?:\/\//.test(mark.attrs?.href??''))text=`[${text}](${mark.attrs.href.replaceAll(')','%29')})`;}return text;}
    const children=(node.content??[]).map(render);
    if(node.type==='hardBreak')return '  \n';
    if(node.type==='horizontalRule')return '---\n\n';
    if(node.type==='codeBlock')return '```'+(node.attrs?.language??'')+'\n'+(node.content??[]).map(n=>n.text??'').join('')+'\n```\n\n';
    if(['bulletList','orderedList'].includes(node.type))return children.map((text,i)=>{const prefix=node.type==='bulletList'?'- ':`${(node.attrs?.start??1)+i}. `;return prefix+text.trim().split('\n').join('\n'+' '.repeat(prefix.length));}).join('\n')+'\n\n';
    const text=children.join('');
    if(node.type==='heading')return '#'.repeat(Math.min(6,Math.max(1,node.attrs?.level??2)))+' '+text+'\n\n';
    if(node.type==='blockquote')return text.trim().split('\n').map(line=>'> '+line).join('\n')+'\n\n';
    if(node.type==='paragraph')return text+'\n\n';
    return text;
  }
  return render(doc).trim();
}
