import React,{useEffect,useRef,useState} from 'react';
import {keepDiscussion} from './DiscussionTransfer.jsx';
import {createPortal} from 'react-dom';
import {requestRecord} from './RelatedArticles.jsx';
import {requestTheme} from './Themes.jsx';
import {recordSection} from '../../library/legacy/record-sections.mjs';

export const sceneNames={revisit:'原文重读',experience:'过去的经验',reading:'相关书摘',writing:'写作选题'};
const relationNames={revisit:'重读原文',outcome:'同一件事的后续',comparison:'可对照的经历',intention:'只找到当时的想法',reading:'书摘与问题',writing:'选题依据'};
const fieldName=q=>q.field==='excerpt'?'书中原话':q.sharedReflection?'整篇读书感想':q.field==='reflection'?'个人读书感想':'个人原文';
const cite=q=>[q.contentDay||'日期待确认',q.title,q.chapter,q.page,fieldName(q)].filter(Boolean).join(' · ');
const today=()=>new Date(Date.now()-new Date().getTimezoneOffset()*60000).toISOString().slice(0,10);
export function Drawer({title,onClose,children}){
 const ref=useRef(null);
 useEffect(()=>{const node=ref.current,prior=document.activeElement;node.showModal();return()=>{node.close();if(prior?.isConnected)prior.focus({preventScroll:true});};},[]);
 return createPortal(<dialog ref={ref} className="sw-rec-drawer" aria-label={title} onCancel={e=>{e.preventDefault();onClose();}} onClick={e=>{if(e.target===ref.current&&e.clientX<ref.current.getBoundingClientRect().left)onClose();}}>
 <div className="sw-rec-paper"><header><small>拾文 / {title}</small><button onClick={onClose} aria-label="关闭">关闭 ×</button></header>{children}</div></dialog>,document.body);
}
export function openQuote(q,layout,libraryId){
 if(layout.openSource)return layout.openSource(q.recordId,{field:q.field,text:q.text,anchor:{start:q.start,end:q.end,excerptIndex:q.excerptIndex}});
 requestRecord(q.recordId,layout,recordSection(q.kind),{libraryId,match:{field:q.field,text:q.text,anchor:{start:q.start,end:q.end,excerptIndex:q.excerptIndex}}});
}
export function CardDetail({initial,rpc,layout,composer,captured,onClose,onChange,onNavigate=onClose}){
 const [card,setCard]=useState(initial),[selection,setSelection]=useState(initial.quotes.filter(q=>!q.unavailable).map(q=>q.quoteId));
 const [form,setForm]=useState(''),[title,setTitle]=useState(initial.question),[decision,setDecision]=useState(''),[day,setDay]=useState(today);
 const [themes,setThemes]=useState([]),[theme,setTheme]=useState(''),[newTheme,setNewTheme]=useState('');
 const [note,setNote]=useState(''),[busy,setBusy]=useState(false),[discussion,setDiscussion]=useState(''),[feedbackReason,setFeedbackReason]=useState('');
 const inflight=useRef(false),retries=useRef(new Map()),insertion=useRef(captured?.span),destination=useRef(captured?.actions);
 const own=card.resultId?{resultId:card.resultId,resultVersion:card.resultVersion}:{cardId:card.cardId,cardRevision:card.cardRevision};
 const base={expectedLibraryId:card.libraryId,...own};
 const read=()=>rpc('shiwen_recommendation_read',{expectedLibraryId:card.libraryId,cardId:card.cardId});
 const selected=card.quotes.filter(q=>!q.unavailable&&selection.includes(q.quoteId));
 const quoteIds=selected.map(q=>q.quoteId);
 const record=(id,section,edit=false)=>{onNavigate();if(layout.openTarget)return layout.openTarget(id,section,edit);requestRecord(id,layout,section,{libraryId:card.libraryId,edit});};
 async function run(fn){if(inflight.current)return;inflight.current=true;setBusy(true);setNote('');try{await fn();}catch(e){setNote(e.message);}finally{setBusy(false);inflight.current=false;}}
 async function write(name,args,success){
  const payload={...base,...args},key=JSON.stringify([name,payload]);
  if(!retries.current.has(key))retries.current.set(key,crypto.randomUUID());
  try{
   const res=await rpc(name,{...payload,requestId:retries.current.get(key)});
   if(!card.resultId)setCard(await read());
   else setCard(c=>({...c,resultVersion:res.cardRevision,cardRevision:res.cardRevision,targets:{
    drafts:res.articleId&&!c.targets.drafts.some(x=>x.id===res.articleId)?[...c.targets.drafts,{id:res.articleId,title:res.title}]:c.targets.drafts,
    themes:res.themeId?[...c.targets.themes.filter(t=>t.themeId!==res.themeId),{themeId:res.themeId,title:newTheme||themes.find(t=>t.id===res.themeId)?.title,items:res.items}]:c.targets.themes,
    decisions:res.recordId?[...c.targets.decisions,{id:res.recordId,title:decision}]:c.targets.decisions}}));
   retries.current.delete(key);onChange?.();window.dispatchEvent(new Event('shiwen-library-updated'));success(res);
  }catch(e){if(e.code==='revision_conflict'&&!card.resultId)setCard(await read());throw e;}
 }
 const post=(name,args,cb)=>run(()=>write(name,args,cb));
 const feedback=(action,extra={})=>post('shiwen_recommendation_feedback',{action,...extra},()=>setNote('反馈已保存'));
 const toggleQuote=id=>setSelection(old=>old.includes(id)?old.filter(x=>x!==id):[...old,id]);
 const openForm=type=>run(async()=>{
  if(type==='theme'){const values=await rpc('themeList');setThemes(values);setTheme(values[0]?.id||'');}
  if(type==='discuss')setDiscussion([card.question,...selected.map(q=>'“'+q.text+'”\n'+cite(q))].join('\n\n'));
  setForm(type);
 });
 const draft=card.targets.drafts.find(d=>!d.removed);
 return <Drawer title={sceneNames[card.scene]} onClose={onClose}><h2>{card.question}</h2><p>{card.reason}</p>
 {card.relations.length>0&&<small>{[...new Set(card.relations.map(r=>relationNames[r.type]))].join(' · ')}</small>}{card.followup&&<p className="sw-rec-followup">{card.followup}</p>}
 <h3>原文依据</h3>{card.quotes.map(q=>q.unavailable?<p key={q.quoteId}>来源已变化，无法定位这段原文。</p>:<article key={q.quoteId} className="sw-rec-quote"><label><input type="checkbox" checked={selection.includes(q.quoteId)} onChange={()=>toggleQuote(q.quoteId)}/>{cite(q)}{card.todayUpdate?.quoteIds.includes(q.quoteId)?' · 今日新增':card.newQuoteIds?.includes(q.quoteId)&&' · 新增'}</label><blockquote>{q.text}</blockquote><button onClick={()=>{onNavigate();openQuote(q,layout,card.libraryId);}}>打开原文 ↗</button></article>)}
 {card.offline&&<p role="status">离线保存的引文 · 连接电脑后可处理推荐。</p>}
 <fieldset disabled={busy||card.offline}><div className="sw-rec-actions">
 <button disabled={!selected.length} onClick={()=>openForm('discuss')}>继续讨论</button><button onClick={()=>openForm('decision')}>记下这次决定</button>
 <button disabled={!selected.length} onClick={()=>openForm('theme')}>加入主题</button><button disabled={!draft&&!selected.length} onClick={()=>draft?record(draft.id,'articles',true):openForm('draft')}>{draft?'继续写':'起草大纲'}</button>
 {draft&&<button disabled={!selected.length} onClick={()=>openForm('another')}>另起一稿</button>}
 {!card.resultId&&<button disabled={!selected.length} onClick={()=>run(async()=>{await navigator.clipboard.writeText(JSON.stringify({...base,quoteIds}));setNote('已复制所选引用');})}>复制所选引用</button>}</div>
 {form==='discuss'&&<div className="sw-rec-form"><label>讨论草稿<textarea value={discussion} onChange={e=>setDiscussion(e.target.value)}/></label><button onClick={()=>run(async()=>{if(composer&&destination.current===composer){if(composer.insertText('\n'+discussion,insertion.current)){setForm('');setNote('已加入对话输入框，可继续编辑');}else{insertion.current=composer.captureInsertion();setNote('对话草稿已变化，请确认后再次加入');}}else{keepDiscussion(discussion,card.libraryId);setNote('讨论草稿已备好。打开目标对话，点击「加入当前对话」即可继续编辑。');}})}>{composer?'加入当前对话':'带到对话'}</button></div>}
 {form==='decision'&&<div className="sw-rec-form"><label>我的决定<textarea value={decision} onChange={e=>setDecision(e.target.value)}/></label><label>内容日期<input type="date" value={day} onChange={e=>setDay(e.target.value)}/></label><button disabled={!decision.trim()||!day} onClick={()=>post('shiwen_assist_save_decision',{body:decision,day},()=>{setForm('');setNote('已保存为个人想法');})}>确认保存决定</button></div>}
 {form==='theme'&&<div className="sw-rec-form"><label>收进主题<select value={theme} onChange={e=>setTheme(e.target.value)}><option value="">新建主题…</option>{themes.map(t=><option key={t.id} value={t.id}>{t.title}</option>)}</select></label>{!theme&&<label>主题名<input value={newTheme} onChange={e=>setNewTheme(e.target.value)}/></label>}<button disabled={!quoteIds.length||(!theme&&!newTheme.trim())} onClick={()=>post('shiwen_assist_add_to_theme',{quoteIds,...(theme?{themeId:theme,themeRevision:themes.find(t=>t.id===theme).revision}:{newThemeTitle:newTheme})},r=>{setForm('');setNote(r.items.map(i=>'第 '+(card.quotes.findIndex(q=>q.quoteId===i.quoteId)+1)+' 段 · '+({added:'已收录',already_present:'已在主题中',source_changed:'来源已变化'}[i.status])).join('；'));})}>收录所选 {quoteIds.length} 段</button></div>}
 {['draft','another'].includes(form)&&<div className="sw-rec-form"><label>草稿标题<input value={title} onChange={e=>setTitle(e.target.value)}/></label><button disabled={!title.trim()||!quoteIds.length} onClick={()=>post('shiwen_assist_create_draft',{title,quoteIds,mode:form==='another'?'another':'first'},r=>record(r.articleId,'articles',true))}>用所选原文创建草稿</button></div>}
 {!card.resultId&&<details><summary>推荐反馈</summary><div className="sw-rec-actions"><button onClick={()=>feedback(card.savedForLater?'remove_later':'save_later')}>{card.savedForLater?'移出稍后看':'稍后看'}</button><button onClick={()=>feedback('skip')}>略过这个问题</button></div>{card.relations.length>0&&<label>纠错原因<input value={feedbackReason} maxLength={200} onChange={e=>setFeedbackReason(e.target.value)}/></label>}{card.relations.map(r=><button key={r.relationId} onClick={()=>feedback('reject_relation',{relationId:r.relationId,quoteIds:r.quoteIds,...(feedbackReason.trim()?{reason:feedbackReason}:{})})}>{relationNames[r.type]} · 关联不对（{r.quoteIds.map(id=>card.quotes.findIndex(q=>q.quoteId===id)+1).join('、')}）</button>)}</details>}
 </fieldset>
 {card.targets.decisions.map(t=><button key={t.id} disabled={t.removed} onClick={()=>record(t.id,'library')}>打开决定 · {t.title}{t.removed&&'（已删除）'}</button>)}
 {card.targets.drafts.map(t=><button key={t.id} disabled={t.removed} onClick={()=>record(t.id,'articles',true)}>续写 · {t.title}{t.removed&&'（已删除）'}</button>)}
 {card.targets.themes.map(t=><button key={t.themeId} disabled={t.removed} onClick={()=>{onNavigate();if(layout.openTheme)layout.openTheme(t.themeId);else requestTheme(t.themeId,card.libraryId,layout);}}>查看主题 · {t.title}（{t.items.filter(i=>i.memberId&&!i.removed).length} 段）</button>)}
 {note&&<p role="status">{note}</p>}</Drawer>;
}
