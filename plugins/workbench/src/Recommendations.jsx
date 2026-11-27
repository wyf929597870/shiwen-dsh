import {MoreRows,usePullRefresh} from './ListInteractions.jsx';
import React,{useEffect,useRef,useState} from 'react';
import {CardDetail,Drawer,sceneNames,openQuote} from './RecommendationDetail.jsx';
import {ExplorationQuestion,ExplorationEntry} from './Exploration.jsx';
import {canvasPassage} from './canvas-passage.mjs';

const opened=new Map();
async function job(rpc,name,args,onProgress){
 const {jobId}=await rpc(name,args);
 for(;;){
  const row=await rpc('shiwen_assist_result',{jobId});
  if(row.progress)onProgress?.(row.progress);
  if(row.status==='ready')return row.result;
  if(row.status==='failed')throw Object.assign(Error(row.message),{completedJob:true});
  await new Promise(resolve=>setTimeout(resolve,600));
 }
}
const openKey=s=>[s.libraryId,s.week,s.revision].join('/');
function refreshForOpening(rpc,s,retry=false,opening=0){
 const key=openKey(s);
 let entry=opened.get(key);
 if(!entry||entry.opening!==opening){entry={opening,requestId:crypto.randomUUID()};opened.set(key,entry);}
 if(retry&&entry.error){
  if(entry.error.completedJob||entry.error.code==='result_expired')entry.requestId=crypto.randomUUID();
  entry.promise=null;entry.error=null;
 }
 if(!entry.promise)entry.promise=job(rpc,'shiwen_recommendation_refresh',{expectedLibraryId:s.libraryId,requestId:entry.requestId},progress=>{
  entry.progress=progress;window.dispatchEvent(new CustomEvent('shiwen-recommendation-progress',{detail:{key,opening,progress}}));
 }).catch(e=>{entry.error=e;throw e;});
 return entry.promise;
}
export function WeeklyOpen({rpc}){
 useEffect(()=>{
  let active=true;
  rpc('shiwen_recommendation_settings',{}).then(s=>{if(active&&s.enabled)return refreshForOpening(rpc,s);}).catch(()=>{});
  return()=>{active=false;};
 },[rpc]);
 return null;
}
function weekRange(week){
 const start=new Date(week+'T12:00:00'),end=new Date(start);end.setDate(end.getDate()+6);
 return [start,end].map(x=>(x.getMonth()+1)+'.'+x.getDate()).join(' — ');
}
function Card({item,onOpen}){
 const update=item.todayUpdate;
 const last=item.responses?.[0],clue=item.clues?.[0],step=item.nextStep;
 if(step)return <button className={'sw-rec-card sw-step-card sw-rec-'+item.scene} onClick={onOpen}>
  <small>{{ask:'继续追问',judgment:'我目前的判断',trial:'回看这次尝试',result:'从这次结果继续'}[step.kind]}{step.reviewDay&&' · '+step.reviewDay}</small>
  <strong>{step.text}</strong>{step.observation&&<span>想观察「{step.observation}」</span>}{step.takeaway&&<span>{step.takeaway}</span>}
  <footer>{item.question} <b aria-hidden="true">↗</b></footer></button>;
 const label=update?.kind==='created'?'今日新增':update?'今天补了 '+update.quoteIds.length+' 段原文':'';
 return <button className={'sw-rec-card sw-rec-'+item.scene} onClick={onOpen}><small>{({explore:'待探索',follow_up:'待跟进'}[item.scene]??sceneNames[item.scene])}{label&&' · '+label}</small><strong>{item.question}</strong>{last?<><small>上次回应{last.contentDay&&' · '+last.contentDay}</small><span>{last.preview||last.title}</span></>:!clue&&<span>{item.reason}</span>}{clue&&<><small>可能有关的后续 · {clue.contentDay}</small><span>{clue.quote}</span></>}<footer>{item.quoteCount??item.quotes?.length} 段原文 <b aria-hidden="true">↗</b></footer></button>;
}
export function AssistEntry({rpc,layout,scene,record,selectionRoot,composer}){
 const [open,setOpen]=useState(false),[q,setQ]=useState(''),[selection,setSelection]=useState(null),[data,setData]=useState(null),[card,setCard]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const captured=useRef(null),seq=useRef(0),library=useRef(null),label={experience:'找过去的经验',reading:'找相关书摘',writing:'从我的记录找选题'}[scene];
 const close=()=>{seq.current++;setCard(null);setOpen(false);setBusy(false);};
 useEffect(()=>()=>{seq.current++;},[]);
 function start(){
  captured.current=composer?{actions:composer,span:composer.captureInsertion()}:null;
  const text=canvasPassage(selectionRoot?.current).slice(0,1000);setSelection(record?{recordId:record.id,sourceRevision:record.revision,text}:null);
  library.current=record?.sourceLibraryId??null;setQ(text);setOpen(true);setData(null);setError('');
 }
 async function search(mode){
  const n=++seq.current;setBusy(true);setError('');setData(null);
  try{
   const {libraryId}=await rpc('themeContext');if(library.current&&library.current!==libraryId)throw Error('资料库已切换，请重新打开');library.current=libraryId;
   const result=await job(rpc,'shiwen_assist_analyze',{expectedLibraryId:libraryId,scene,mode,question:q,callId:crypto.randomUUID(),...(selection?{selection}:{})});
   if(n===seq.current&&(await rpc('themeContext')).libraryId===libraryId)setData(result);
  }catch(e){if(n===seq.current)setError(e.message);}finally{if(n===seq.current)setBusy(false);}
 }
 return <><button type="button" className="sw-assist-launch" onMouseDown={e=>e.preventDefault()} onClick={start}>{label}</button>
 {open&&<Drawer title={label} onClose={close}><h2>{label}</h2><label>{scene==='writing'?'想写哪个方向？可以留空，从近 30 天记录中寻找。':'你现在想弄清什么？'}<textarea value={q} maxLength={1000} onChange={e=>setQ(e.target.value)}/></label><div className="sw-rec-actions"><button disabled={busy||(!q.trim()&&!selection&&scene!=='writing')} onClick={()=>search('analyze')}>{busy?'正在查找…':'分析原文'}</button><button disabled={busy} onClick={()=>search('search')}>只检索原文</button></div>
 {error&&<p role="alert">{error}</p>}{data&&<><p>{data.retrieval==='semantic'?'语义与关键词检索':'关键词检索'} · {data.candidates.length} 段候选</p>{data.modelError&&<p role="alert">{data.modelError}。可以查看候选，或再次分析。</p>}
 {data.items.filter(item=>item.relations.length>0).map(item=><Card key={item.resultId} item={item} onOpen={()=>setCard(item)}/>)}{!data.items.length&&!data.modelError&&<p>暂未形成有原文支持的推荐。</p>}
 <details open={!data.items.length}><summary>检索命中的原文</summary>{data.candidates.map(x=><article className="sw-rec-quote" key={x.quoteId}><small>{x.title} · {x.contentDay||'日期待确认'}</small><blockquote>{x.text}</blockquote><button onClick={()=>{close();openQuote(x,layout,library.current);}}>打开原文 ↗</button></article>)}</details></>}</Drawer>}
 {open&&card&&<CardDetail key={card.cardId} initial={card} rpc={rpc} layout={layout} composer={composer} captured={captured.current} onClose={()=>setCard(null)} onNavigate={close}/>}</>;
}
export function Recommendations({rpc,layout,composer,showAssist=true,opening=0}){
 const [config,setConfig]=useState(null),[items,setItems]=useState([]),[card,setCard]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const [batch,setBatch]=useState(null),[progress,setProgress]=useState(null);
 const [view,setView]=useState(null),[page,setPage]=useState(null),[tick,setTick]=useState(0);
 const captured=useRef(null),alive=useRef(0),reads=useRef(0),views=useRef(0),busyAction=useRef(false);
 const readWeek=async n=>{const seq=++reads.current;const r=await rpc('shiwen_recommendation_list',{view:'week'});if(n===alive.current&&seq===reads.current){setItems(r.items.slice(0,10));setBatch(r);}return r;};
 useEffect(()=>{
  const n=++alive.current;let key,version=0;
  function onProgress({detail}){
   if(key!==detail.key||opening!==detail.opening||n!==alive.current)return;
   const p=detail.progress;
   setProgress(old=>old?.checked===p.checked&&old?.total===p.total?old:p);
   if(version!==p.version){version=p.version;refresh();}
  }
  async function init(){
   const s=await rpc('shiwen_recommendation_settings',{});if(n!==alive.current)return;setConfig(s);setError('');setProgress(null);key=openKey(s);
   if(!s.enabled){if(s.poolBased)await readWeek(n);else setItems([]);return;}
   setBusy(true);const week=await readWeek(n);if(n!==alive.current||s.offline||week.offline)return;
   try{await refreshForOpening(rpc,s,true,opening);}finally{if(n===alive.current)await readWeek(n);}
  }
  init().catch(e=>{if(n===alive.current)setError(e.message);}).finally(()=>{if(n===alive.current)setBusy(false);});
  const refresh=()=>{readWeek(n).catch(e=>{if(n===alive.current)setError(e.message);});};window.addEventListener('shiwen-library-updated',refresh);
  window.addEventListener('shiwen-recommendation-progress',onProgress);
  return()=>{alive.current++;window.removeEventListener('shiwen-recommendation-progress',onProgress);window.removeEventListener('shiwen-library-updated',refresh);};
 },[rpc,tick,opening]);
 useEffect(()=>{
  if(!batch?.nextDayAt)return;
  const reload=()=>{if(Date.now()<batch.nextDayAt)return;readWeek(alive.current).catch(e=>setError(e.message));if(view==='today')void browse('today');};
  const timer=setTimeout(reload,Math.max(1,batch.nextDayAt-Date.now()+25));
  window.addEventListener('focus',reload);return()=>{clearTimeout(timer);window.removeEventListener('focus',reload);};
 },[batch?.nextDayAt,config?.enabled,view]);
 useEffect(()=>{
  if(!view)return;
  const reload=()=>{void browse(view);};
  window.addEventListener('shiwen-library-updated',reload);
  return()=>window.removeEventListener('shiwen-library-updated',reload);
 },[view,rpc,config?.libraryId]);
 async function change(){
  if(!config||busyAction.current)return;busyAction.current=true;
  try{await rpc('shiwen_recommendation_settings',{expectedLibraryId:config.libraryId,enabled:!config.enabled,revision:config.revision,requestId:crypto.randomUUID()});setTick(n=>n+1);}catch(e){setError(e.message);}finally{busyAction.current=false;}
 }
 async function show(id){captured.current=composer?{actions:composer,span:composer.captureInsertion()}:null;try{setCard(await rpc('shiwen_recommendation_read',{expectedLibraryId:config.libraryId,cardId:id}));}catch(e){setError(e.message);}}
 async function browse(type,cursor){
  const token=++views.current;setView(type);if(!cursor)setPage(null);
  try{const history=type==='feedback',r=await rpc(history?'shiwen_recommendation_feedback_list':'shiwen_recommendation_list',{...(history?{expectedLibraryId:config.libraryId}:{view:type}),...(cursor?{cursor}:{})});if(token===views.current)setPage(prev=>({...r,items:cursor?[...(prev?.items??[]),...r.items]:r.items}));}catch(e){setError(e.message);}
 }
 async function undo(f){
  try{await rpc('shiwen_recommendation_feedback',{expectedLibraryId:config.libraryId,cardId:f.cardId,cardRevision:f.cardRevision,action:'undo',feedbackId:f.feedbackId,requestId:crypto.randomUUID()});await browse('feedback');await readWeek(alive.current);}catch(e){setError(e.message);}
 }
 const closeView=()=>{views.current++;setView(null);setPage(null);};
 const headings={week:'本周全部',today:'今日更新',later:'稍后看',feedback:'最近反馈'};
 const homeRefresh=usePullRefresh(async()=>{
  try{const settings=await rpc('shiwen_recommendation_settings',{});setConfig(settings);await readWeek(alive.current);setError('');}catch(e){setError(e.message);}
 });
 const viewRefresh=usePullRefresh(()=>browse(view),Boolean(view));
 const daily=batch?.daily??[];
 return <>{(config?.enabled||config?.poolBased)&&<section className="sw-recs sw-daily"><header><div><small>{batch?.day}</small><h2>每日推荐</h2></div></header>
 {daily.length?<div className="sw-daily-grid">{daily.map(item=><Card item={item} key={item.cardId} onOpen={()=>show(item.cardId)}/>)}</div>:<p>{busy?'正在准备今天的推荐…':'暂无可推荐的原文。'}</p>}
 </section>}<section ref={homeRefresh} className="sw-recs"><header><div><small>{config&&weekRange(batch?.week??config.week)}{config?.enabled?' · '+items.length+' 张':''}</small><h2>每周推荐</h2></div>{showAssist&&<AssistEntry rpc={rpc} layout={layout} composer={composer} scene="experience"/>}</header>
 {config&&!config.enabled&&<div className="sw-rec-opt"><p>{config.poolBased?'自动推荐从已收下的问题中选卡。':'开启后，当前模型会收到相关原文节选，用于生成推荐。'}</p><button onClick={change}>开启本周推荐</button></div>}
 {batch?.offline&&<p role="status">离线 · 显示上次连接电脑时保存的推荐（{batch.cachedDay??batch.day}）</p>}
 {(config?.enabled||items.length>0)&&<>{items.length?<div className="sw-rec-grid">{items.map(item=>item.alsoToday?<button className="sw-rec-card" key={item.cardId} onClick={()=>show(item.cardId)}>今日也在写 · {item.nextStep?.text||item.question}</button>:<Card item={item} key={item.cardId} onOpen={()=>show(item.cardId)}/>)}</div>:!error&&<p>{busy?'正在读取探索池…':'本周暂无可推荐的问题。'}</p>}
 <footer className="sw-rec-actions">{batch?.todayCount>0&&<button onClick={()=>browse('today')}>只看今日更新 · {batch.todayCount}</button>}<button onClick={()=>browse('week')}>查看本周全部</button><button disabled={batch?.offline} onClick={()=>browse('later')}>稍后看</button><button disabled={batch?.offline} onClick={()=>browse('feedback')}>最近反馈</button>{config.enabled&&<button disabled={config.offline||batch?.offline} onClick={change}>关闭自动推荐</button>}{busy&&<small role="status">{progress?.total?'已检查 '+progress.checked+' / '+progress.total+' 条候选记录':'正在安排推荐…'}</small>}</footer></>}
 {config&&!config.enabled&&<div className="sw-rec-actions"><button disabled={batch?.offline} onClick={()=>browse('later')}>稍后看</button><button disabled={batch?.offline} onClick={()=>browse('feedback')}>最近反馈</button></div>}
 {showAssist&&config&&!items.length&&<ExplorationEntry rpc={rpc} layout={layout} label="去筛选"/>}
 {error&&<p role="alert">{error} <button onClick={()=>{setTick(n=>n+1);}}>重试</button></p>}
 {view&&<Drawer title={headings[view]} onClose={closeView}><h2 ref={viewRefresh}>{headings[view]}</h2>{!page?<p>正在读取…</p>:!page.items.length?<p>暂无内容。</p>:page.items.map(item=>view==='feedback'?<article key={item.feedbackId} className="sw-rec-quote"><strong>{item.question}</strong><p>{item.action==='skip'?'略过问题':'纠正关联'} · {new Date(item.at).toLocaleDateString()} · {item.active?'已生效':'已撤销'}</p><button onClick={()=>show(item.cardId)}>查看卡片</button>{item.active&&<button onClick={()=>undo(item)}>撤销这次反馈</button>}</article>:<Card key={item.cardId} item={item} onOpen={()=>show(item.cardId)}/>)}{page?.nextCursor!=null&&<MoreRows cursor={page.nextCursor} onClick={()=>browse(view,page.nextCursor)}>加载更多</MoreRows>}{error&&<p role="alert">{error}</p>}</Drawer>}
 {card?.questionId&&<ExplorationQuestion key={card.questionId} resume initial={card} rpc={rpc} layout={layout} readOnly={!config?.poolBased} onClose={()=>setCard(null)}/>}
 {card&&!card.questionId&&<CardDetail key={card.cardId} initial={card} rpc={rpc} layout={layout} composer={composer} captured={captured.current} onClose={()=>setCard(null)} onNavigate={()=>{setCard(null);closeView();}} onChange={()=>{if(view)browse(view);}}/>}</section></>;
}
