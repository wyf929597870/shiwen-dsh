import React from '../../android/node_modules/react/index.js';
import {createRoot} from '../../android/node_modules/react-dom/client.js';
import {OriginCorrection} from '../../plugins/workbench/src/OriginCorrection.jsx';
import {ReviewPanel} from '../../android/web/ReviewPanel.jsx';
import {ReviewPage} from '../../plugins/workbench/src/ReviewPage.jsx';
import {Annotations} from '../../plugins/workbench/src/Annotations.jsx';
let root,original,loseResponse=false,failReview=false;
const assert=(ok,message)=>{if(!ok)throw Error(message);};
const pause=()=>new Promise(resolve=>setTimeout(resolve,10));
async function until(check){for(let i=0;i<300;i++){if(check())return;await pause();}throw Error('Timed out: '+check+' '+document.body.textContent);}
const button=label=>[...document.querySelectorAll('button')].find(node=>node.textContent.trim()===label);
async function rpc(method,args={}){
  if(method==='reviewPreview'&&failReview)throw Error('统计暂时不可用');
  const response=await fetch('/rpc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({method,args})});
  const data=await response.json();if(data.error)throw Object.assign(Error(data.error),{httpStatus:response.status});
  if(loseResponse===method){loseResponse=false;throw Error('SIMULATED_RESPONSE_LOST');}return data.result;
}
function MarkdownContent({body}){return <div className="preview">{body}</div>;}
async function mount(){original=await rpc('original');root=createRoot(document.getElementById('root'));root.render(<Annotations key={original.id} original={original} rpc={rpc} MarkdownContent={MarkdownContent} newRequestId={()=>crypto.randomUUID()} zh onEditState={()=>{}}/>);await until(()=>button('新建 AI 标注')&&!button('新建 AI 标注').disabled||button('重试保存')||button('重试操作'));}
async function type(selector,value){const field=document.querySelector(selector);Object.getOwnPropertyDescriptor(field instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(field,value);field.dispatchEvent(new Event('input',{bubbles:true}));await pause();}
async function begin(body){await until(()=>button('新建 AI 标注')&&!button('新建 AI 标注').disabled);button('新建 AI 标注').click();await until(()=>document.querySelector('textarea'));await type('textarea',body);}
async function run(){
  window.confirm=()=>true;const passed=[];await mount();
  await begin('独立的 AI 标注');button('保存标注').click();await until(()=>button('编辑标注'));
  let state=await rpc('inspect');assert(state.original.markdown==='自己的原文'&&state.annotations.length===1,'annotation must not alter original');passed.push('separate original and annotation');
  button('收起标注').click();await until(()=>!document.querySelector('.sw-annotation-detail'));assert(document.activeElement===document.querySelector('.sw-annotation-list button'),'close restores focus');document.querySelector('.sw-annotation-list button').click();await until(()=>button('编辑标注'));document.querySelector('.sw-annotation-list button').click();await until(()=>!document.querySelector('.sw-annotation-detail'));document.querySelector('.sw-annotation-list button').click();await until(()=>button('编辑标注'));document.querySelector('.sw-annotation-detail').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await until(()=>!document.querySelector('.sw-annotation-detail'));state=await rpc('inspect');assert(state.annotations.length===1&&state.original.markdown==='自己的原文','closing must not delete annotation or alter original');document.querySelector('.sw-annotation-list button').click();await until(()=>button('编辑标注'));passed.push('reader close button, title toggle and Escape preserve data');
  button('编辑标注').click();await until(()=>document.querySelector('textarea'));await type('textarea','未保存的标注草稿');await until(()=>localStorage.getItem(`shiwen-draft:annotation:${original.id}`)?.includes('未保存的标注草稿'));
  root.unmount();await mount();await until(()=>document.querySelector('textarea')?.value==='未保存的标注草稿');button('保存标注').click();await until(()=>button('编辑标注'));passed.push('annotation draft survives remount');
  await begin('重试不能重复创建');loseResponse='annotationCreate';button('保存标注').click();await until(()=>button('重试保存')&&!button('重试保存').disabled);assert(document.querySelector('textarea').disabled,'uncertain write frozen');
  root.unmount();await mount();await until(()=>button('重试保存')&&!button('重试保存').disabled);button('重试保存').click();await until(()=>button('编辑标注'));state=await rpc('inspect');assert(state.annotations.length===2,'exact retry must deduplicate');passed.push('lost response and durable exact replay');
  await until(()=>button('删除标注')&&!button('删除标注').disabled);loseResponse='annotationDelete';button('删除标注').click();await until(()=>button('重试操作')&&!button('重试操作').disabled);root.unmount();await mount();await until(()=>button('重试操作')&&!button('重试操作').disabled);button('重试操作').click();await until(()=>button('撤销删除')&&!button('撤销删除').disabled);state=await rpc('inspect');assert(state.annotations.length===1,'annotation deleted independently');loseResponse='annotationRestore';button('撤销删除').click();await until(()=>button('重试操作')&&!button('重试操作').disabled);root.unmount();await mount();await until(()=>button('重试操作')&&!button('重试操作').disabled);button('重试操作').click();await until(()=>!button('重试操作'));state=await rpc('inspect');assert(state.annotations.length===2,'annotation restored');passed.push('delete and restore');
  await rpc('changeOriginal');root.unmount();await mount();await until(()=>document.body.textContent.includes('较早版本'));passed.push('immutable earlier-version anchor');
  root.unmount();
  async function correction(){original=await rpc('original');root=createRoot(document.getElementById('root'));root.render(<OriginCorrection record={original} rpc={rpc} newRequestId={()=>crypto.randomUUID()} zh onPending={()=>{}} onCorrected={async()=>{original=await rpc('original');}}/>);await until(()=>document.querySelector('select')&&!document.querySelector('select').disabled||button('重试更正'));}
  await correction();const select=document.querySelector('select');select.value='external';select.dispatchEvent(new Event('change',{bubbles:true}));await pause();loseResponse='correctRecordOrigin';button('保存更正').click();await until(()=>button('重试更正')&&!button('重试更正').disabled);root.unmount();await correction();await until(()=>button('重试更正')&&!button('重试更正').disabled);button('重试更正').click();await until(()=>!button('重试更正'));state=await rpc('inspect');assert(state.original.origin==='external'&&state.original.markdown==='编辑后的原文','correction only changes provenance');passed.push('separate source correction and durable replay');
  root.unmount();await rpc('reviewFixture');root=createRoot(document.getElementById('root'));root.render(<ReviewPage rpc={rpc} language="zh" md={{render:text=>text}} typeName={kind=>kind}/>);
  await until(()=>document.querySelector('.sw-review-metrics strong'));
  assert(document.querySelector('.sw-review-metrics strong').textContent==='8','main card counts both MCP personal originals, excluding AI and external');
  assert(document.querySelectorAll('.sw-review-table tbody tr').length===2,'detail includes personal references and freewriting');
  assert([...document.querySelectorAll('.sw-goals-day .sw-goals-value')].reduce((sum,n)=>sum+Number(n.textContent.replaceAll(',','')),0)===8,'daily trend agrees with total');
  const metricSelect=document.querySelector('select[aria-label="统计项目"]');metricSelect.value='notes';metricSelect.dispatchEvent(new Event('change',{bubbles:true}));
  await until(()=>document.querySelector('.sw-goals-summary').textContent.includes('暂无数值记录'));
  assert(document.querySelector('.sw-goals').textContent.includes('在「读书笔记」记录感想后'),'reserved reading-note category explains the empty state');
  assert(![...document.querySelectorAll('details')].find(d=>d.querySelector('summary')?.textContent==='编辑与历史统计').open,'secondary statistics start collapsed');
  button('当日').click();await until(()=>document.querySelector('.sw-review-metrics strong'));assert(document.querySelector('.sw-review-metrics strong').textContent==='8','today includes archived personal originals');
  failReview=true;button('刷新').click();await until(()=>document.querySelector('[role=alert]'));assert(!document.querySelector('.sw-review-metrics'),'failed original count must not fall back to legacy number');failReview=false;button('刷新').click();await until(()=>document.querySelector('.sw-review-metrics strong'));passed.push('review original totals, daily trend, personal detail and failure recovery');
  root.unmount();root=createRoot(document.getElementById('root'));root.render(<ReviewPanel libraryId="test" request={rpc}/>);await until(()=>document.querySelector('.review-metrics strong'));
  assert(document.querySelector('.review-metrics strong').textContent==='8字','mobile primary card uses personal originals');
  assert(document.querySelectorAll('.review-day-detail').length===2,'mobile details include both personal originals');
  assert([...document.querySelectorAll('.sw-goals-day .sw-goals-value')].reduce((sum,n)=>sum+Number(n.textContent.replaceAll(',','')),0)===8,'mobile daily bars agree with total');
  failReview=true;button('刷新').click();await until(()=>document.querySelector('.error'));assert(!document.querySelector('.review-metrics'),'mobile must not show stale or legacy totals on failure');failReview=false;button('刷新').click();await until(()=>document.querySelector('.review-metrics strong'));passed.push('Android review UI uses originals and recovers from unavailable statistics');
  await rpc('readingNoteFixture');
  for(const mobile of [false,true]){
    root.unmount();root=createRoot(document.getElementById('root'));
    root.render(mobile?<ReviewPanel libraryId="test" request={rpc}/>:<ReviewPage rpc={rpc} language="zh" md={{render:text=>text}} typeName={kind=>kind}/>);
    await until(()=>document.querySelector('select[aria-label="统计项目"]'));
    const select=document.querySelector('select[aria-label="统计项目"]');select.value='notes';select.dispatchEvent(new Event('change',{bubbles:true}));
    await until(()=>document.querySelector('.sw-goals-summary strong').textContent==='6 字');
    assert(document.querySelector(mobile?'.review-metrics strong':'.sw-review-metrics strong').textContent===(mobile?'14字':'14'),'reading notes are included once in original totals');
    document.querySelector('.sw-goals-day:last-child').click();await until(()=>document.querySelector('.sw-goals-detail'));
    const note=[...document.querySelectorAll('.sw-goals-detail dl div')].find(d=>d.querySelector('dt')?.textContent==='读书笔记');
    assert(note.querySelector('dd').textContent==='6 字','selected day shows independent reading-note characters');
    assert(!document.querySelector('.sw-goals').textContent.includes('在「读书笔记」记录感想后'),'real records replace the reserved empty-state hint');
  }
  passed.push('reading-note metric, daily detail and nonduplicated totals on desktop and mobile');
  root.unmount();document.body.innerHTML='<pre id="result"></pre>';document.getElementById('result').textContent=JSON.stringify({passed});
}
run().catch(error=>{document.body.innerHTML='<pre id="result"></pre>';document.getElementById('result').textContent=JSON.stringify({error:error.stack});});
