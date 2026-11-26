import React,{useEffect,useRef,useState} from 'react';
import {Drawer,openQuote} from './RecommendationDetail.jsx';

const stateLabels={pending:'待筛选',accepted:'已收下',observing:'观察中',skipped:'已略过',answered:'已回答'};
function RecordPicker({rpc,libraryId,onPick,personal=false}){
 const [quotes,setQuotes]=useState({});
 const [query,setQuery]=useState(''),[page,setPage]=useState(null),[error,setError]=useState('');
 const seq=useRef(0);
 async function search(offset=0){
  const n=++seq.current;
  try{
   const r=await rpc('explorationRecordSearch',{query,offset,expectedLibraryId:libraryId});
   if(n===seq.current){setPage(old=>({...r,items:offset?[...old.items,...r.items]:r.items}));setError('');}
  }catch(e){if(n===seq.current)setError(e.message);}
 }
 return <div><label>查找记录<input value={query} maxLength={100} onChange={e=>{seq.current++;setQuery(e.target.value);setPage(null);}}/></label>
  <button onClick={()=>search()}>查找</button>{page?.items.filter(r=>!personal||r.origin==='personal').map(r=><article className="sw-rec-quote" key={r.id}>
   <small>{r.day} · {r.title}</small><p>{r.excerpt}</p>{personal&&<details><summary>关联其中一句</summary><label>回应原句<input value={quotes[r.id]??''} onChange={e=>setQuotes(old=>({...old,[r.id]:e.target.value}))}/></label></details>}
   <button onClick={()=>onPick({...r,quote:quotes[r.id]})}>选择这篇</button></article>)}
  {page?.nextOffset!=null&&<button onClick={()=>search(page.nextOffset)}>更多记录</button>}{page?.items.length===0&&<p>没有找到记录。</p>}
  {error&&<p role="alert">{error}</p>}</div>;
}

function SourceReview({item,rpc,libraryId,onClose}){
 const [mapped,setMapped]=useState({}),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const retries=useRef(new Map());
 const missing=[...new Set(item.discovery.sources.map(s=>s.externalSourceId).filter(Boolean))];
 async function resolve(){
  const mappings=missing.map(externalSourceId=>({externalSourceId,recordId:mapped[externalSourceId].recordId,revision:mapped[externalSourceId].revision}));
  const key=JSON.stringify(mappings);if(!retries.current.has(key))retries.current.set(key,crypto.randomUUID());
  setBusy(true);
  try{
   const r=await rpc('shiwen_exploration_review',{expectedLibraryId:libraryId,requestId:retries.current.get(key),action:'resolve_source',
     reviewItemId:item.reviewItemId,expectedReviewRevision:item.revision,mappings});
   if(r.status==='source_changed'){setError('来源版本已变化，请重新选择。');setMapped({});return;}
   window.dispatchEvent(new Event('shiwen-library-updated'));onClose();
  }catch(e){setError(e.message);}finally{setBusy(false);}
 }
 return <Drawer title="核对来源" onClose={onClose}><h2>{item.discovery.text}</h2>
  {missing.map(id=><section key={id}><h3>{id}</h3>{mapped[id]&&<p>已选 · {mapped[id].title}</p>}
   <RecordPicker rpc={rpc} libraryId={libraryId} onPick={r=>setMapped(old=>({...old,[id]:{recordId:r.id,revision:r.revision,title:r.title}}))}/></section>)}
  <button disabled={busy||missing.some(id=>!mapped[id])} onClick={resolve}>确认出处</button>{error&&<p role="alert">{error}</p>}</Drawer>;
}

export function ExplorationQuestion({initial,rpc,layout,onClose,readOnly=false}){
 const [q,setQ]=useState(initial),[mode,setMode]=useState(''),[text,setText]=useState(''),[error,setError]=useState('');
 const [busy,setBusy]=useState(false),[replacements,setReplacements]=useState(null);
 useEffect(()=>{
  let live=true,latest=0;
  async function refresh(){
   const sequence=++latest;
   try{const next=await rpc('shiwen_exploration_read',{expectedLibraryId:initial.libraryId,questionId:initial.questionId});
    if(live&&sequence===latest)setQ(next);
   }catch(e){if(live)setError(e.message);}
  }
  window.addEventListener('shiwen-library-updated',refresh);
  return()=>{live=false;window.removeEventListener('shiwen-library-updated',refresh);};
 },[initial.questionId,initial.libraryId,rpc]);
 const pending=useRef(new Map()),responseId=useRef(null),active=useRef(false);
 const base={expectedLibraryId:q.libraryId,questionId:q.questionId,expectedRevision:q.revision};
 async function write(method,args){
  if(active.current)return;
  active.current=true;setBusy(true);setError('');
  const payload={...base,...args},key=JSON.stringify([method,payload]);
  if(!pending.current.has(key))pending.current.set(key,crypto.randomUUID());
  try{
   const updated=await rpc('shiwen_exploration_'+method,{...payload,requestId:pending.current.get(key)});
   if(updated.status==='full'){
    const options=await Promise.all(updated.replaceable.map(questionId=>rpc('shiwen_exploration_read',{expectedLibraryId:q.libraryId,questionId})));
    setReplacements({period:args.period,options});return;
   }
   pending.current.clear();setQ(updated);setMode('');setText('');setReplacements(null);
   window.dispatchEvent(new Event('shiwen-library-updated'));
  }catch(e){
   setError(e.message);
   try{setQ(await rpc('shiwen_exploration_read',{expectedLibraryId:q.libraryId,questionId:q.questionId}));}catch{}
  }finally{active.current=false;setBusy(false);}
 }
 const review=(action,extra={})=>write('review',{action,...extra});
 function place(period,action,replaceQuestionId){
  const p=q.placements[period];
  return write('place',{period,action,periodKey:p.key,expectedPlacementRevision:p.revision,accept:q.status==='pending',replaceQuestionId});
 }
 return <Drawer title={q.type==='follow_up'?'待跟进':'待探索'} onClose={onClose}>
  <small>{stateLabels[q.status]}</small><h2>{q.text}</h2>
  {q.text!==q.originalText&&<p>原提问 · {q.originalText}</p>}
  {q.sources.map((s,i)=><article key={i} className="sw-rec-quote"><small>{s.label} · {s.contentDay||'日期待确认'}</small>
   {s.quote&&<blockquote>{s.quote}</blockquote>}<button onClick={()=>{onClose();openQuote({...s,text:s.quote??''},layout,q.libraryId);}}>{s.title||'打开原文'} ↗</button>
   {!readOnly&&s.scope==='record'&&s.hasPersonal&&!s.personal&&<button disabled={busy} onClick={()=>review('confirm_personal_context',{recordId:s.recordId,sourceRevision:s.revision})}>确认针对整篇个人感想</button>}
  </article>)}
  {q.possibleDuplicates?.map(m=><section key={m.evidenceFingerprint}><h3>可能重复</h3><p>{m.text}</p><p>{q.sources.filter(s=>m.recordIds.includes(s.recordId)).map(s=>s.title).join('、')}</p>
   {!readOnly&&['merge','keep_separate'].map(action=><button key={action} disabled={busy} onClick={()=>review(action,{targetQuestionId:m.questionId,expectedTargetRevision:m.revision,evidenceFingerprint:m.evidenceFingerprint})}>{action==='merge'?'合并到这个问题':'分别保留'}</button>)}</section>)}
  {q.mergedQuestions?.map(m=><p key={m.decisionId}>已合并 · {m.text} {!readOnly&&<button disabled={busy} onClick={()=>review('undo_merge',{questionId:m.questionId,expectedRevision:m.revision,targetQuestionId:q.questionId,expectedTargetRevision:q.revision,decisionId:m.decisionId})}>撤销合并</button>}</p>)}
  {!q.sources.length&&<p>当前没有有效来源。</p>}
  {q.responses.map(r=><p key={r.recordId}>已有回应 · <button onClick={()=>{onClose();openQuote({recordId:r.recordId,kind:r.kind,...r.passage,text:r.passage?.quote??""},layout,q.libraryId);}}>{r.title||"打开回应"} ↗</button></p>)}
  {!readOnly&&<fieldset disabled={busy} className="sw-rec-actions">
   {q.status==='skipped'?<button onClick={()=>review('restore')}>撤销略过</button>:<>
    {q.status==='pending'&&<button onClick={()=>review('accept')}>收下</button>}
    <button onClick={()=>{setMode('rewrite');setText(q.text);}}>改个问法再收下</button>
    {q.status!=='observing'&&<button onClick={()=>review('observe')}>留着观察</button>}
    {['answered','observing'].includes(q.status)&&<button onClick={()=>review('continue')}>继续探索</button>}
    {['accepted','pending'].includes(q.status)&&Object.entries({day:'今天',week:'本周'}).map(([period,label])=>{
     const pinned=q.placements[period].pinned;
     return <button key={period} onClick={()=>place(period,pinned?'unpin':'pin')}>{pinned?'撤下'+label:q.status==='pending'?'收下并放到'+label:'放到'+label}</button>;
    })}
    <button onClick={()=>{responseId.current=crypto.randomUUID();setMode('respond');setText('');}}>{q.type==='follow_up'?'补记后来发生了什么':'接着写'}</button>
    <button onClick={()=>setMode('link')}>关联已有回应</button>
    {q.status!=='answered'&&q.responses.length>0&&<button onClick={()=>review('answered')}>已经回答</button>}
    <button onClick={()=>review('skip')}>略过</button></>}
  </fieldset>}
  {mode==='link'&&<RecordPicker rpc={rpc} libraryId={q.libraryId} personal onPick={r=>write('respond',{responseRecordId:r.id,sourceRevision:r.revision,...(r.quote?{passage:{recordId:r.id,revision:r.revision,quote:r.quote}}:{})})}/>}
  {['rewrite','respond'].includes(mode)&&<div><label>{mode==='rewrite'?'我的问法':'自由书写'}<textarea autoFocus value={text} onChange={e=>setText(e.target.value)}/></label>
   <button disabled={busy||!text.trim()} onClick={()=>mode==='rewrite'?review('rewrite',{text}):write('respond',{responseRecordId:responseId.current,body:text})}>保存</button>
   <button disabled={busy} onClick={()=>setMode('')}>取消</button></div>}
  {replacements&&<div><p>固定位已满，选择要替换的问题。</p>{replacements.options.map(o=><button key={o.questionId} disabled={busy} onClick={()=>place(replacements.period,'replace',o.questionId)}>{o.text}</button>)}
   <button onClick={()=>setReplacements(null)}>取消</button></div>}
  {error&&<p role="alert">{error}</p>}
 </Drawer>;
}

function DiscoveryControls({rpc,libraryId,onComplete}){
 const [config,setConfig]=useState(null),[job,setJob]=useState(null),[error,setError]=useState('');
 const refresh=()=>rpc('shiwen_exploration_settings',{expectedLibraryId:libraryId});
 useEffect(()=>{let live=true;refresh().then(c=>{if(live){setConfig(c);if(c.jobId)setJob({jobId:c.jobId});}}).catch(e=>{if(live)setError(e.message);});return()=>{live=false;};},[libraryId,rpc]);
 useEffect(()=>{
  if(!job?.jobId||['ready','failed'].includes(job.status))return;
  let timer,live=true;
  const poll=async()=>{try{const j=await rpc('shiwen_assist_result',{jobId:job.jobId});if(!live)return;setJob(j);
    if(j.status==='pending')timer=setTimeout(poll,500);else onComplete();
   }catch(e){if(live)setError(e.message);}};
  void poll();return()=>{live=false;clearTimeout(timer);};
 },[job?.jobId,job?.status==='ready',job?.status==='failed']);
 async function start(mode){try{const j=await rpc('shiwen_exploration_import',{expectedLibraryId:libraryId,requestId:crypto.randomUUID(),mode});setJob(j);}catch(e){setError(e.message);}}
 async function setting(key){try{setConfig(await rpc('shiwen_exploration_settings',{expectedLibraryId:libraryId,requestId:crypto.randomUUID(),expectedRevision:config.revision,[key]:!config[key]}));}catch(e){setError(e.message);}}
 return <details><summary>整理与发现</summary><div className="sw-rec-actions"><button onClick={()=>start('history')}>整理历史批注</button><button onClick={()=>start('incremental')}>现在整理</button></div>
 {config&&<><label><input type="checkbox" checked={config.enabled} onChange={()=>setting('enabled')}/>每日发现</label>
 <label><input type="checkbox" checked={config.model} onChange={()=>setting('model')}/>允许模型分析个人原文</label></>}
 {job?.progress&&<p role="status">已扫 {job.progress.scanned} · 已完成 {job.progress.checked} · 新增 {job.progress.created} · 待核对 {job.progress.needs_review} · 待重试 {job.progress.retry}</p>}
 {error&&<p role="alert">{error}</p>}</details>;
}

function AddQuestion({rpc,libraryId,recordId,revision,selection,onAdded}){
 const [text,setText]=useState(''),[quote,setQuote]=useState(selection),[type,setType]=useState('explore');
 const [busy,setBusy]=useState(false),[error,setError]=useState('');
 const retry=useRef(null);
 async function save(){
  const signature=JSON.stringify([libraryId,recordId,revision,type,text,quote]);
  if(retry.current?.signature!==signature)retry.current={signature,id:crypto.randomUUID()};
  const id=retry.current.id;
  setBusy(true);setError('');
  try{
   const r=await rpc('shiwen_exploration_suggest',{expectedLibraryId:libraryId,requestId:id,suggestions:[{type,text,externalItemId:id,
    sources:[{recordId,revision,...(quote?{quote}:{})}]}]});
   const item=r.items[0];
   if(!item.questionId)throw Error(item.status==='source_changed'?'原文已经更新，请重新打开记录。':'请先核对来源。');
   setText('');setQuote('');onAdded();
  }catch(e){setError(e.message);}finally{setBusy(false);}
 }
 return <details><summary>从这篇记录提出问题</summary><label>类型<select value={type} onChange={e=>setType(e.target.value)}><option value="explore">待探索</option><option value="follow_up">待跟进</option></select></label>
 <label>我的问题<textarea value={text} onChange={e=>setText(e.target.value)}/></label>
 <label>引用原句（留空关联整篇）<textarea value={quote} onChange={e=>setQuote(e.target.value)}/></label>
 <button disabled={!text.trim()||busy} onClick={save}>加入原始池</button>{error&&<p role="alert">{error}</p>}</details>;
}
export function ExplorationEntry({rpc,layout,recordId,revision,sourceLibraryId,label='待探索'}){
 const [open,setOpen]=useState(false),[view,setView]=useState('raw'),[page,setPage]=useState(null),[selected,setSelected]=useState(null);
 const [error,setError]=useState(''),[tick,setTick]=useState(0);
 const seq=useRef(0);const [selection,setSelection]=useState(''),[type,setType]=useState('');
 async function load(cursor){
  const n=++seq.current;
  try{
   const {libraryId}=await rpc('themeContext');
   if(sourceLibraryId&&libraryId!==sourceLibraryId)throw Error('资料库已切换，请重新打开记录。');
   const result=await rpc('shiwen_exploration_list',{expectedLibraryId:libraryId,view,recordId,cursor,...(type&&view!=='reviews'?{type}:{}),...(view==='reviews'?{reason:'source_unmapped'}:{})});
   if(n===seq.current){setError('');setPage(old=>({...result,libraryId,items:cursor?[...(old?.items??[]),...result.items]:result.items}));}
  }catch(e){if(n===seq.current)setError(e.message);}
 }
 useEffect(()=>{
  if(!open)return;setPage(null);void load();
  const reload=()=>setTick(t=>t+1);window.addEventListener('shiwen-library-updated',reload);
  return()=>{seq.current++;window.removeEventListener('shiwen-library-updated',reload);};
 },[open,recordId,view,tick,rpc,type,sourceLibraryId]);
 return <><button onClick={()=>{setSelection(window.getSelection()?.toString()||'');setOpen(true);}}>{label}</button>{open&&<Drawer title="待探索" onClose={()=>setOpen(false)}>
  <h2>{recordId?'这篇记录的待探索':'待探索'}</h2><div className="sw-rec-actions">{Object.entries({raw:'原始池（待筛选）',accepted:'探索池（已收下）',skipped:'已略过',...(!recordId?{reviews:'来源待核对'}:{})}).map(([key,title])=>
   <button key={key} aria-pressed={view===key} onClick={()=>setView(key)}>{title}</button>)}</div>
  {recordId&&revision&&page&&<AddQuestion rpc={rpc} libraryId={page.libraryId} recordId={recordId} revision={revision} selection={selection} onAdded={()=>{setView('raw');setTick(t=>t+1);}}/>}
  {view!=='reviews'&&<label>类型<select value={type} onChange={e=>setType(e.target.value)}><option value="">全部</option><option value="explore">待探索</option><option value="follow_up">待跟进</option></select></label>}
  {!recordId&&page?.libraryId&&<DiscoveryControls rpc={rpc} libraryId={page.libraryId} onComplete={()=>load()}/>}
  {error&&<p role="alert">{error}</p>}{page?.items.map(q=>q.reviewItemId?<article key={q.reviewItemId} className="sw-rec-quote"><button onClick={()=>setSelected({...q,libraryId:page.libraryId})}>{q.discovery.text}</button></article>:<article className="sw-rec-quote" key={q.questionId}><small>{q.possibleDuplicates?.length>0&&'可能重复 · '}{stateLabels[q.status]} · {q.sources[0]?.title||'来源已失效'}</small>
   <button onClick={()=>setSelected(q)}>{q.text}</button></article>)}
  {page&&!page.items.length&&<p>这里暂时没有问题。</p>}{page?.nextCursor!=null&&<button onClick={()=>load(page.nextCursor)}>加载更多</button>}
 </Drawer>}{open&&selected?.reviewItemId&&<SourceReview item={selected} rpc={rpc} libraryId={selected.libraryId} onClose={()=>setSelected(null)}/>}
 {open&&selected?.questionId&&<ExplorationQuestion initial={selected} rpc={rpc} layout={layout} onClose={()=>setSelected(null)}/>}</>;
}
