import MarkdownIt from 'markdown-it';

const markdown = new MarkdownIt({html:false});
markdown.inline.ruler.before('link','wiki_image',(state,silent)=>{
  if(!state.src.startsWith('![[',state.pos))return false;
  const end=state.src.indexOf(']]',state.pos+3);if(end<0)return false;
  if(!silent){const token=state.push('image','img',0);token.attrs=[['src',state.src.slice(state.pos+3,end).split('|')[0]]];}
  state.pos=end+2;return true;
});

export function attachmentImageIds(body){
  const ids=new Set();
  for(const block of markdown.parse(String(body??''),{}))for(const token of block.children??[]){
    if(token.type!=='image')continue;
    const match=/^attachment:([A-Za-z0-9_-]{1,100})$/i.exec(token.attrGet('src')??'');
    if(match)ids.add(match[1]);
  }
  return ids;
}
