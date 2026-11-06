import MarkdownIt from 'markdown-it';
import {diffChars} from 'diff';
import {toMarkdown} from './content.mjs';

const md=new MarkdownIt({html:false,linkify:false,typographer:false,breaks:true});
const esc=md.utils.escapeHtml;
const decode=value=>{try{return decodeURIComponent(value);}catch{return value;}};
const mapped=(target,env)=>env.links?.find(l=>decode(l.target.split('|')[0])===decode(target.split('|')[0]));
function linkHTML(target,label,env,image=false){
  const link=mapped(target,env),safe=esc(label||target);
  if(link?.attachment)return `<a href="#" data-attachment="${esc(link.attachment)}"${image?' class="md-image-link"':''}>${image?'图片：':''}${safe}</a>`;
  if(link?.record)return `<a href="#" data-record="${esc(link.record)}">${safe}</a>`;
  if(/^https?:\/\//i.test(target))return `<a href="#" data-external="${esc(target)}">${image?'图片：':''}${safe}</a>`;
  return `<span class="md-unresolved" title="${esc(target)}">${safe}</span>`;
}
md.inline.ruler.before('link','wikilink',(state,silent)=>{
  const start=state.pos,image=state.src.startsWith('![[',start),offset=image?3:2;
  if(!image&&!state.src.startsWith('[[',start))return false;
  const end=state.src.indexOf(']]',start+offset);if(end<0)return false;
  if(!silent){const text=state.src.slice(start+offset,end),parts=text.split('|');const token=state.push('wiki_link','',0);token.meta={target:parts[0],label:parts.slice(1).join('|')||parts[0],image};}
  state.pos=end+2;return true;
});
md.renderer.rules.wiki_link=(tokens,index,_options,env)=>{const {target,label,image}=tokens[index].meta;return linkHTML(target,label,env,image);};
md.renderer.rules.image=(tokens,index,_options,env)=>linkHTML(tokens[index].attrGet('src')??'',tokens[index].content,env,true);
md.renderer.rules.link_open=(tokens,index,_options,env)=>{
  const target=tokens[index].attrGet('href')??'',link=mapped(target,env);
  const attr=link?.attachment?`data-attachment="${esc(link.attachment)}"`:link?.record?`data-record="${esc(link.record)}"`:/^https?:\/\//i.test(target)?`data-external="${esc(target)}"`:`data-unresolved="${esc(target)}"`;
  return `<a href="#" ${attr}>`;
};
md.renderer.rules.table_open=()=>'<div class="md-table"><table>';
md.renderer.rules.table_close=()=>'</table></div>\n';

export function readingSource(source){
  const lines=source.split('\n'),numbered=lines.filter(l=>l.trim()).map(l=>l.match(/^(\d+)\|(.*)$/));
  if(numbered.length>=5&&numbered.every((m,i)=>m&&+m[1]===+numbered[0][1]+i))return lines.map(l=>l.replace(/^\d+\|/,'')).join('\n');
  return source;
}
export function renderMarkdown(source,links=[],title=''){const env={links},tokens=md.parse(readingSource(source),env);if(title&&tokens[0]?.type==='heading_open'&&tokens[1]?.content.trim()===title.trim())tokens.splice(0,3);return md.renderer.render(tokens,md.options,env);}
export function markdownSummary(source){
  const text=[];
  const visit=tokens=>{for(const token of tokens){if(token.children)visit(token.children);else if(['text','code_inline','fence','code_block','image'].includes(token.type))text.push(token.content);else if(token.type==='wiki_link')text.push(token.meta.label);}};
  visit(md.parse(readingSource(source.slice(0,1200)),{}));return text.join(' ').slice(0,240);
}

// Imported Markdown is canonical source, held in paragraph nodes only to retain
// per-span provenance and reuse version/draft persistence. Never escape it again.
export function markdownSource(doc){
  return (doc.content??[]).map(node=>{
    if(node.type!=='paragraph')return toMarkdown({type:'doc',content:[node]});
    return (node.content??[]).map(n=>{
      if(n.type==='hardBreak')return '\n';
      let text=n.text??'';
      for(const mark of n.marks??[]){if(mark.type==='bold')text=`**${text}**`;if(mark.type==='italic')text=`*${text}*`;if(mark.type==='strike')text=`~~${text}~~`;if(mark.type==='code')text='`'+text+'`';if(mark.type==='link')text=`[${text}](${mark.attrs?.href??''})`;}
      return text;
    }).join('');
  }).join('\n');
}

export function updateMarkdownDoc(doc,source,addedOrigin='personal',fallback='unknown'){
  const before=markdownSource(doc),spans=[];let offset=0;
  for(const [i,node] of (doc.content??[]).entries()){
    if(i){spans.push({start:offset,end:++offset,origin:fallback});}
    const plain=node.type==='paragraph'&&(node.content??[]).every(n=>n.type==='text'&&(n.marks??[]).every(m=>m.type==='provenance'));
    if(plain)for(const n of node.content??[]){const end=offset+n.text.length;spans.push({start:offset,end,origin:n.marks?.find(m=>m.type==='provenance')?.attrs?.origin??fallback});offset=end;}
    else {const end=offset+markdownSource({content:[node]}).length;spans.push({start:offset,end,origin:fallback});offset=end;}
  }
  const paragraphs=[{type:'paragraph',content:[]}];
  const append=(text,origin)=>{for(const [i,line] of text.split('\n').entries()){if(i)paragraphs.push({type:'paragraph',content:[]});if(!line)continue;const content=paragraphs.at(-1).content,last=content.at(-1);if(last?.marks?.[0]?.attrs?.origin===origin)last.text+=line;else content.push({type:'text',text:line,marks:[{type:'provenance',attrs:{origin}}]});}};
  let cursor=0,index=0;
  for(const change of diffChars(before,source)){
    if(change.added){append(change.value,addedOrigin);continue;}
    const end=cursor+change.value.length;
    if(!change.removed){while(cursor<end){while(index<spans.length&&spans[index].end<=cursor)index++;const span=spans[index],stop=Math.min(end,span?.end??end);append(before.slice(cursor,stop),span?.origin??fallback);cursor=stop;}}
    cursor=end;
  }
  return {type:'doc',content:paragraphs};
}
