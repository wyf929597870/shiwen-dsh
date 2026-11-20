import React from 'react';
import {createRoot} from 'react-dom/client';
import {apply} from '../../plugins/workbench/src/client.jsx';

const panels={};
function show(id){const Page=panels[id];root.render(<Page key={id}/>);}
const root=createRoot(document.getElementById('root'));
apply({
  locale:{subscribe:()=>()=>{},getSnapshot:()=>({active:'zh'})},layout:{selectPanel:show},uiWorkspace:{},
  effect:fn=>fn(),slots:{inject:(_,fn)=>fn(),register:(slot,component)=>{if(slot.name==='main')panels[slot.key]=component;}}
});
show('shiwen-library');

async function until(get){
  for(let i=0;i<160;i++){
    const result=get();if(result)return result;
    await new Promise(resolve=>setTimeout(resolve,40));
  }
  throw Error('等待失败 '+get);
}
const pick=(container,label)=>[...container.querySelectorAll('button')].find(button=>button.textContent===label&&!button.disabled);
async function verify(){
  (await until(()=>document.querySelector('.sw-list:not([inert]) .sw-row[title="每周回看"]'))).click();
  if(document.querySelector('.sw-row[title="日记的另一种读法"],.sw-row[title="园艺笔记"]'))throw Error('记录列表混入收藏或书摘');
  (await until(()=>pick(document,'在画布中展开'))).click();
  const canvas=await until(()=>document.querySelector('.sw-idea-canvas[open]'));
  const first=await until(()=>canvas.querySelector('.sw-canvas-children .sw-canvas-card'));
  const titles=()=>[...canvas.querySelectorAll('.sw-canvas-content strong')].map(el=>el.textContent);
  if(titles().filter(x=>x==='每周回看').length!==1||titles().includes('春天播种'))throw Error('重复起点或出现无关结果');
  pick(first,'查看原文').click();
  const mark=await until(()=>canvas.querySelector('.sw-canvas-reader mark'));
  if(!mark.textContent.trim()||!canvas.querySelector('.sw-canvas-reader .sw-markdown'))throw Error('原文或命中缺失');
  pick(canvas,'返回画布').click();
  pick(first,'继续展开').click();
  const deeper=await until(()=>first.nextElementSibling?.querySelector('.sw-canvas-card'));
  if(!deeper||new Set(titles()).size!==titles().length)throw Error('不同分支重复展示了同一条记录');
  const viewport=canvas.querySelector('.sw-canvas-viewport');
  viewport.scrollTop=24;
  const top=viewport.scrollTop;
  pick(canvas,'全屏').click();
  await until(()=>pick(canvas,'退出全屏'));
  const bounds=canvas.querySelector('.sw-canvas-surface').getBoundingClientRect();
  if(bounds.x!==0||bounds.y!==0||Math.abs(bounds.width-innerWidth)>1||Math.abs(bounds.height-innerHeight)>1)throw Error('全屏画布未铺满窗口');
  pick(deeper,'查看原文').click();
  await until(()=>canvas.querySelector('.sw-canvas-reader mark'));
  pick(canvas,'返回画布').click();
  await until(()=>!canvas.querySelector('.sw-canvas-reader'));
  if(!pick(canvas,'退出全屏'))throw Error('关闭原文时丢失了全屏状态');
  pick(canvas,'退出全屏').click();
  await until(()=>pick(canvas,'全屏'));
  if(!deeper.isConnected||first.nextElementSibling.hidden||viewport.scrollTop!==top)throw Error('退出全屏后分支或滚动位置丢失');
  pick(first,'收起').click();
  await until(()=>first.nextElementSibling.hidden);
  pick(first,'继续展开').click();
  await until(()=>!first.nextElementSibling.hidden);
  const seed=canvas.querySelector('.sw-canvas-seed');
  const check=card=>card.querySelector('input[type="checkbox"]');
  if(pick(canvas,'生成文章大纲'))throw Error('空选择可以提交');
  check(deeper).click();check(first).click();check(seed).click();
  pick(seed,'移除').click();
  await until(()=>seed.hidden&&!check(seed).checked);
  if(!check(deeper).checked||!deeper.checkVisibility())throw Error('移除起点丢失子节点');
  pick(canvas,'撤销移除').click();
  await until(()=>!seed.hidden&&check(seed).checked);
  pick(first,'移除').click();
  await until(()=>first.hidden&&!check(first).checked);
  const removedTitle=first.querySelector('strong').textContent;
  const childTitle=deeper.querySelector('strong').textContent;
  pick(canvas,'生成文章大纲').click();
  await until(()=>canvas.querySelector('[role="alert"]')?.textContent.includes('test lost response'));
  pick(canvas,'生成文章大纲').click();
  const outline=await until(()=>canvas.querySelector('dialog[aria-label="文章大纲"]'));
  const md=outline.querySelector('.sw-markdown');
  if(!md.querySelector('h2')||md.querySelector('h3')?.textContent!==childTitle||md.textContent.includes(removedTitle))throw Error('大纲层级或选中范围错误');
  pick(outline,'在创作中打开').click();
  await until(()=>document.querySelector('.sw-detail h2')?.textContent==='每周回看 · 文章大纲');
  if(!pick(document,'编辑'))throw Error('大纲无法进入创作编辑');
  const references=await until(()=>document.querySelector('.sw-detail .sw-article-references'));
  if(!pick(references,'每周回看')||!pick(references,childTitle)||pick(references,removedTitle))throw Error('引用素材没有按标题显示');
  if(document.querySelector('.sw-article-tools')?.open)throw Error('文章工具默认展开');
  pick(references,'每周回看').click();
  await until(()=>document.querySelector('.sw-detail h2')?.textContent==='每周回看');
  show('shiwen-collections');
  (await until(()=>document.querySelector('.sw-list:not([inert]) .sw-row[title="日记的另一种读法"]'))).click();
  if(document.querySelector('.sw-row[title="每周回看"]'))throw Error('收藏混入个人记录');
  (await until(()=>pick(document,'在画布中展开'))).click();
  await until(()=>document.querySelector('.sw-canvas-seed strong')?.textContent==='日记的另一种读法');
  pick(document,'返回收藏').click();
  show('shiwen-global');
  const input=await until(()=>document.querySelector('input[aria-label="全局搜索"]'));
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'番红花');
  input.dispatchEvent(new Event('input',{bubbles:true}));
  (await until(()=>document.querySelector('.sw-search-result'))).click();
  await until(()=>document.querySelector('.rn-detail-excerpt')?.textContent==='番红花开在秋天。');
  if(document.querySelector('.rn-detail-thought'))throw Error('纯书摘存在空感想区');
  (await until(()=>pick(document,'在画布中展开'))).click();
  await until(()=>document.querySelector('.sw-canvas-seed .sw-canvas-content span')?.textContent==='番红花开在秋天。');


}
verify().then(()=>{document.querySelector('#result').textContent='passed';},e=>{document.querySelector('#result').textContent=e.message;});
