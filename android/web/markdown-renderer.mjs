import MarkdownIt from 'markdown-it';

const safeMarkdown = new MarkdownIt({html:false,linkify:false,typographer:false,breaks:true});
const stockValidateLink = safeMarkdown.validateLink.bind(safeMarkdown);
safeMarkdown.validateLink = url => /^attachment:[A-Za-z0-9_-]{1,100}$/i.test(url) || stockValidateLink(url);
safeMarkdown.inline.ruler.before('link','wiki_image',(state,silent)=>{
  if(!state.src.startsWith('![[',state.pos))return false;const end=state.src.indexOf(']]',state.pos+3);if(end<0)return false;
  if(!silent){const [target,...label]=state.src.slice(state.pos+3,end).split('|'),token=state.push('image','img',0);token.attrs=[['src',target]];token.content=label.join('|')||target;}
  state.pos=end+2;return true;
});

// Images remain inert labels until the native library attachment reader is connected.
safeMarkdown.renderer.rules.image = (tokens, index, _options, env) => {
  const token = tokens[index];
  const english=env?.language==='en',alt = safeMarkdown.utils.escapeHtml(token.content || (english?'Image':'图片'));
  const source = token.attrGet('src') || '';
  const attachment = source.match(/^attachment:([A-Za-z0-9_-]{1,100})$/i)?.[1];
  if (attachment) return `<span class="md-attachment-pending" data-attachment-id="${attachment}" role="img" aria-label="${alt}">${english?'Loading image':'图片加载中'}：${alt}</span>`;
  if(source.length<=2048&&!/^(?:[a-z][a-z0-9+.-]*:|\/\/|\/)/i.test(source))return `<span class="md-attachment-pending" data-image-target="${safeMarkdown.utils.escapeHtml(source)}" role="img" aria-label="${alt}">${english?'Loading image':'图片加载中'}：${alt}</span>`;
  if(source.length<=2048&&/^https?:\/\//i.test(source))return `<button type="button" class="md-network-image" data-image-url="${safeMarkdown.utils.escapeHtml(source)}" aria-label="${alt}">${english?'Load remote image':'加载网络图片'}：${alt}</button>`;
  const label = safeMarkdown.utils.escapeHtml(source || '图片');
  return `<span class="md-image-label" role="img" aria-label="${alt}">[${english?'Image not saved':'图片未保存'}：${label}]</span>`;
};
safeMarkdown.renderer.rules.link_open = (tokens, index, options, env, self) => {
  const token = tokens[index];
  token.attrSet('target', '_blank');
  token.attrSet('rel', 'noopener noreferrer');
  return self.renderToken(tokens, index, options);
};
safeMarkdown.renderer.rules.table_open = () => '<div class="md-table"><table>\n';
safeMarkdown.renderer.rules.table_close = () => '</table></div>\n';

export function renderMarkdownHtml(markdown = '', language = 'zh-CN') {
  return safeMarkdown.render(String(markdown ?? ''),{language});
}

export function attachmentImageIds(markdown = '') {
  const ids = new Set();
  for (const block of safeMarkdown.parse(String(markdown ?? ''), {})) for (const token of block.children ?? []) {
    if (token.type !== 'image') continue;
    const match = /^attachment:([A-Za-z0-9_-]{1,100})$/i.exec(token.attrGet('src') || '');
    if (match) ids.add(match[1]);
  }
  return ids;
}
