import {usePullRefresh} from './ListInteractions.jsx';
import MarkdownIt from 'markdown-it';
import {decodeReadingNote} from '../../library/legacy/reading-note.mjs';
import React,{useCallback,useEffect,useLayoutEffect,useRef,useState} from 'react';
import {kindLabel,fieldLabel} from './ContentSearch.jsx';

let pendingTheme=null;const themeListeners=new Set();
export function requestTheme(id,libraryId,layout){pendingTheme={id,libraryId};layout.selectPanel('shiwen-themes');for(const listener of themeListeners)listener();}
// Capture a selection only when its exact location in the persisted field is unambiguous.
export function selectedFragment(container,text){
 const selection=window.getSelection();if(!selection||selection.isCollapsed||!container?.contains(selection.anchorNode)||!container.contains(selection.focusNode))return null;
 const quote=selection.toString();if(!quote)return null;const start=String(text??'').indexOf(quote);
 if(start<0||String(text).indexOf(quote,start+1)!==-1)return {invalid:true};
 return {quote,start,end:start+quote.length};
}
export function AddToTheme({rpc,t,sourceRecordId,sourceRevision,sourceLibraryId,field='body',excerptIndex,fragment,selectionRoot,sourceText,label}){
 const [open,setOpen]=useState(false),[items,setItems]=useState([]),[selected,setSelected]=useState(''),[name,setName]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[retry,setRetry]=useState(0),[captured,setCaptured]=useState(null),[scope,setScope]=useState('');
 useEffect(()=>{if(!open)return;let live=true;setError('');setScope('');rpc('themeContext').then(async context=>{if(!context?.libraryId)throw Error(t('资料库标识不可用','Library identity unavailable'));if(!sourceLibraryId||context.libraryId!==sourceLibraryId)throw Error(t('资料库已切换，请重新读取原文','Library changed; reload the source'));const rows=await rpc('themeList');const current=await rpc('themeContext');if(current.libraryId!==context.libraryId)throw Error(t('资料库已切换，请重新打开','Library changed; reopen this dialog'));if(live){setScope(context.libraryId);setItems(rows);setSelected(v=>rows.some(r=>r.id===v)?v:(rows[0]?.id||''));}}).catch(e=>{if(live)setError(e.message);});return()=>{live=false;};},[open,rpc,retry,sourceLibraryId]);
 const show=()=>{const selection=selectionRoot?selectedFragment(selectionRoot.current,sourceText):null;setCaptured(selection||fragment||null);setNotice('');setOpen(true);};
 async function add(){if(busy||!scope)return;setBusy(true);setError('');try{if(captured?.invalid)throw Error(t('选中文字无法在原文中唯一定位，请选择更长的片段或重新读取。','The selection cannot be uniquely located. Select a longer passage or reload.'));let theme;if(name.trim()){theme=await rpc('themeSave',{title:name.trim(),summary:'',expectedLibraryId:scope});setItems(rows=>[theme,...rows]);setSelected(theme.id);setName('');}else{if(!selected)throw Error(t('请选择主题或新建主题','Choose or create a theme'));theme=items.find(x=>x.id===selected);if(!theme)throw Error(t('主题列表已变化，请重试','Theme list changed; retry'));}await rpc('themeMemberAdd',{themeId:theme.id,revision:theme.revision,sourceRecordId,sourceRevision,expectedLibraryId:scope,field,...(field==='excerpt'?{excerptIndex}:{}),...(captured||{})});setNotice(t('已加入主题','Added to theme'));setName('');setOpen(false);window.dispatchEvent(new Event('shiwen-themes-updated'));}catch(e){setError(e.message);}finally{setBusy(false);}}
 return <span className="sw-theme-add"><button type="button" onMouseDown={e=>e.preventDefault()} onClick={show}>{label||t('加入主题','Add to theme')}</button>{notice&&<small role="status">{notice}</small>}{open&&<span className="sw-theme-popover" role="dialog" aria-label={t('加入主题','Add to theme')}><strong>{captured?t('加入选中的片段','Add selected passage'):t('加入整条内容','Add entire content')}</strong>{captured?.quote&&<q>{captured.quote.slice(0,180)}</q>}<label>{t('选择主题','Choose theme')}<select value={selected} disabled={busy} onChange={e=>setSelected(e.target.value)}><option value="">{t('请选择','Choose')}</option>{items.map(item=><option key={item.id} value={item.id}>{item.title}</option>)}</select></label><label>{t('或新建主题','Or create a theme')}<input value={name} maxLength={200} disabled={busy} onChange={e=>setName(e.target.value)}/></label>{error&&<span role="alert">{error} <button type="button" onClick={()=>setRetry(v=>v+1)}>{t('刷新主题列表','Refresh themes')}</button></span>}<span><button type="button" disabled={busy} onClick={()=>setOpen(false)}>{t('取消','Cancel')}</button> <button type="button" disabled={busy||!scope} onClick={add}>{busy?t('保存中…','Saving…'):t('加入','Add')}</button></span></span>}</span>;
}

export function ThemesPage({rpc,t,onOpenSource,draftNamespace,onNavigation}){
 const [scope,setScope]=useState(''),[error,setError]=useState(''),[retry,setRetry]=useState(0);
 useEffect(()=>{let live=true;setError('');rpc('themeContext').then(value=>{if(live){if(!value?.libraryId)throw Error(t('资料库标识不可用','Library identity unavailable'));setScope(value.libraryId);}}).catch(e=>{if(live)setError(e.message);});return()=>{live=false;};},[rpc,retry]);
 if(error)return <main className="sw-view"><p role="alert">{error} <button onClick={()=>setRetry(v=>v+1)}>{t('重试','Retry')}</button></p></main>;
 if(!scope)return <main className="sw-view" role="status">{t('正在读取资料库…','Loading library…')}</main>;
 return <ThemesPageInner key={scope} rpc={rpc} t={t} onOpenSource={onOpenSource} onNavigation={onNavigation} scope={scope} draftKey={`shiwen-theme-draft:${scope}${draftNamespace?':'+draftNamespace:''}`}/>;
}
function ThemesPageInner({rpc:baseRpc,t,onOpenSource,draftKey,scope,onNavigation}){
 const rpc=useCallback(async(method,args={})=>{const context=await baseRpc('themeContext');if(context.libraryId!==scope)throw Error(t('资料库已切换，请重新打开主题页','Library changed; reopen Themes'));const writes=['themeSave','themeDelete','themeMemberAdd','themeMemberRemove'];const value=await baseRpc(method,writes.includes(method)?{...args,expectedLibraryId:scope}:args);const current=await baseRpc('themeContext');if(current.libraryId!==scope)throw Error(t('资料库已切换，请重新打开主题页','Library changed; reopen Themes'));return value;},[baseRpc,scope]);
 const savedDraft=useRef();if(savedDraft.current===undefined){try{savedDraft.current=JSON.parse(localStorage.getItem(draftKey)||'null');}catch{savedDraft.current=null;}}
 const [list,setList]=useState([]),[id,setId]=useState(()=>savedDraft.current?.id||''),[theme,setTheme]=useState(null),[title,setTitle]=useState(()=>savedDraft.current?.title||''),[summary,setSummary]=useState(()=>savedDraft.current?.summary||''),[dirty,setDirty]=useState(()=>Boolean(savedDraft.current)),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[loading,setLoading]=useState(false),[retry,setRetry]=useState(0),[context,setContext]=useState(null);
 const serial=useRef(0),contextSerial=useRef(0),preserveDraft=useRef(false);
 const refresh=()=>rpc('themeList').then(setList).catch(e=>setError(e.message));
 const detailCanReload=useRef(false);detailCanReload.current=Boolean(id&&!dirty&&!busy);
 useEffect(()=>{refresh();const reload=()=>{refresh();if(detailCanReload.current)setRetry(n=>n+1);};window.addEventListener('shiwen-themes-updated',reload);return()=>window.removeEventListener('shiwen-themes-updated',reload);},[rpc]);
 useEffect(()=>{const token=++serial.current;if(!id){setTheme(null);setLoading(false);return;}setLoading(true);setError('');setContext(null);rpc('themeRead',{id}).then(value=>{if(token===serial.current){const draft=savedDraft.current?.id===id?savedDraft.current:null;if(preserveDraft.current){preserveDraft.current=false;setTheme(value);setNotice(t('已读取最新版本。保存会用当前输入覆盖最新的标题和说明，请先核对。','Latest version loaded. Saving will replace its title and description with your edits; review them first.'));}else{setTheme(draft?{...value,revision:draft.revision}:value);setTitle(draft?.title??value.title);setSummary(draft?.summary??value.summary);setDirty(Boolean(draft));savedDraft.current=null;}}}).catch(e=>{if(token===serial.current){setTheme(null);setError(e.message);}}).finally(()=>{if(token===serial.current)setLoading(false);});},[id,rpc,retry]);
 const leave=()=>!busy&&(!dirty||window.confirm(t('放弃未保存的主题修改？','Discard unsaved theme changes?')));
 const discardDraft=()=>{savedDraft.current=null;try{localStorage.removeItem(draftKey);}catch{}setDirty(false);};
 const detailPane=useRef(null),page=useRef(null),returnPoint=useRef(null),backButton=useRef(null);
 const [narrow,setNarrow]=useState(()=>window.matchMedia('(max-width: 760px)').matches);
 useEffect(()=>{
   const media=window.matchMedia('(max-width: 760px)');
   const update=()=>setNarrow(media.matches);
   media.addEventListener('change',update);
   return ()=>media.removeEventListener('change',update);
 },[]);
 const singlePane=Boolean(onNavigation)||narrow;
 const [editing,setEditing]=useState(()=>Boolean(savedDraft.current));
 const [actionId,setActionId]=useState('');
 const showEditor=!singlePane||editing||dirty;
 const detailOpen=singlePane&&Boolean(id||dirty);
 const refreshRef=usePullRefresh(refresh,Boolean(onNavigation)&&!detailOpen);
 useLayoutEffect(()=>{
   if(!singlePane&&detailPane.current)detailPane.current.scrollTop=0;
 },[id,singlePane]);
 const scrollHost=()=>page.current?.closest('.app > main')||page.current;
 function rememberList(button){
   if(singlePane&&!detailOpen)returnPoint.current={top:scrollHost().scrollTop,button};
 }
 function backToList(){
   if(!leave())return;
   discardDraft();setEditing(false);setActionId('');setId('');setTheme(null);setTitle('');setSummary('');setError('');setNotice('');setContext(null);
 }
 useLayoutEffect(()=>{onNavigation?.({depth:detailOpen,back:backToList});});
 useLayoutEffect(()=>{
   if(!singlePane)return;
   if(detailOpen){
     scrollHost().scrollTop=0;
     backButton.current?.focus({preventScroll:true});
   }else if(returnPoint.current){
     const {top,button}=returnPoint.current;
     const restore=setTimeout(()=>{
       scrollHost().scrollTop=top;button?.focus({preventScroll:true});returnPoint.current=null;
     },0);
     return ()=>clearTimeout(restore);
   }
 },[singlePane,detailOpen]);
 const choose=(next,button,edit=false)=>{
   if(next!==id&&leave()){
     rememberList(button);discardDraft();setActionId('');setEditing(edit);setId(next);
   }
 };
 function newTheme(event){
   if(!leave())return;
   rememberList(event.currentTarget);discardDraft();setEditing(true);setActionId('');setId('');setTheme(null);setTitle('');setSummary('');setDirty(true);setError('');setNotice('');
 }
 useEffect(()=>{const receive=()=>{if(!pendingTheme)return;const request=pendingTheme;pendingTheme=null;if(request.libraryId!==scope){setError(t('资料库已切换，请重新打开原文','Library changed; reopen the source'));return;}choose(request.id);};themeListeners.add(receive);receive();return()=>{themeListeners.delete(receive);};},[id,dirty,busy,scope]);
 useEffect(()=>{if(!dirty)return;try{localStorage.setItem(draftKey,JSON.stringify({id,title,summary,revision:theme?.revision}));}catch{setError(t('无法保存本机主题草稿','Could not preserve the local theme draft'));}},[dirty,id,title,summary,theme?.revision]);
 useEffect(()=>{const warn=e=>{if(dirty||busy){e.preventDefault();e.returnValue='';}};window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn);},[dirty,busy]);
 async function save(){if(busy||!title.trim()||(id&&!theme))return;setBusy(true);setError('');try{const value=await rpc('themeSave',{...(theme?{id:theme.id,revision:theme.revision}:{}),title:title.trim(),summary});discardDraft();setNotice('');await refresh();if(theme){setTheme({...theme,...value});}else setId(value.id);setEditing(false);}catch(e){setError(e.message);}finally{setBusy(false);}}
 async function removeTheme(){if(!theme||busy||!window.confirm(t('删除这个主题及其片段关联？原始记录会保留。','Delete this theme and its links? Original records remain.')))return;setBusy(true);setError('');try{await rpc('themeDelete',{id:theme.id,revision:theme.revision});discardDraft();setId('');setTheme(null);await refresh();}catch(e){setError(e.message);}finally{setBusy(false);}}
 async function removeMember(member){if(!theme||busy||!leave())return;setBusy(true);setError('');try{const value=await rpc('themeMemberRemove',{themeId:theme.id,revision:theme.revision,memberId:member.id});setTheme(value);setTitle(value.title);setSummary(value.summary);discardDraft();await refresh();}catch(e){setError(e.message);}finally{setBusy(false);}}
 async function showContext(member){if(['deleted','library_mismatch'].includes(member.location?.status))return;const token=serial.current,contextToken=++contextSerial.current;setContext({id:member.id,loading:true});try{const record=await rpc('readMarkdown',{id:member.sourceRecordId});if(token===serial.current&&contextToken===contextSerial.current)setContext({id:member.id,record});}catch(e){if(token===serial.current&&contextToken===contextSerial.current)setContext({id:member.id,error:e.message});}}
 function openMember(member){
  if(!leave())return;
  const loc=member.location;
  const match=['current','moved'].includes(loc?.status)&&Number.isInteger(loc?.start)
   ?{field:member.field,text:member.quote,anchor:{start:loc.start,end:loc.end,...(member.field==='excerpt'?{excerptIndex:loc.excerptIndex}:{})}}
   :null;
  onOpenSource(member.sourceRecordId,{kind:member.currentKind||member.sourceKind,libraryId:scope,match,unlocated:!match});
 }
 const status={current:t('原文可定位','Located'),moved:t('原文位置已变化','Moved'),ambiguous:t('原文位置不唯一','Ambiguous'),changed:t('原文已变化','Changed'),deleted:t('原文已删除','Deleted'),library_mismatch:t('原文来自其他资料库','Different library')};
 return <main ref={page} className="sw-view sw-themes" data-single-pane={singlePane||undefined}>
  {detailOpen
   ? <button type="button" className="sw-theme-back" ref={backButton} disabled={busy} onClick={backToList}>‹ {t('返回主题列表','Back to themes')}</button>
   : !onNavigation&&<header className="sw-head">
      <div><h1>{t('主题','Themes')}</h1><p className="sw-sub">{t('把不同记录中的片段放在一起。','Bring passages from different records together.')}</p></div>
      <button className="sw-primary" onClick={newTheme}>{t('新建主题','New theme')}</button>
     </header>}
  {error&&<p role="alert" className="sw-error">{error} <button onClick={()=>{
    refresh();if(id){preserveDraft.current=dirty;setRetry(v=>v+1);}
   }}>{dirty?t('读取最新版本并保留修改','Reload latest and keep edits'):t('重试读取','Retry loading')}</button></p>}
  {notice&&<p role="status">{notice}</p>}
  <div className="sw-columns">
   <aside ref={refreshRef} hidden={detailOpen} className="sw-list" aria-label={t('主题列表','Themes')}>
    {onNavigation&&<button type="button" className="sw-primary phone-create-fab" onClick={newTheme}>＋ {t('新建主题','New theme')}</button>}
    {list.map(row=><ThemeListItem key={row.id} row={row} t={t} current={row.id===id}
      singlePane={singlePane} showAction={actionId===row.id} setActionId={setActionId} choose={choose}/>)}
    {!list.length&&<p>{t('还没有主题','No themes yet')}</p>}
   </aside>
   <section ref={detailPane} hidden={singlePane&&!detailOpen} className="sw-detail">
    {loading?<p role="status">{t('正在读取…','Loading…')}</p>:(!theme&&!dirty)?<p>{t('选择或新建主题','Choose or create a theme')}</p>:<>
     {showEditor?<>
      <label>{t('主题标题','Theme title')}
       <input aria-label={t('主题标题','Theme title')} value={title} maxLength={200} disabled={busy} onChange={e=>{setTitle(e.target.value);setDirty(true);}}/>
      </label>
      <label>{t('说明','Description')}
       <textarea aria-label={t('说明','Description')} value={summary} maxLength={10000} disabled={busy} onChange={e=>{setSummary(e.target.value);setDirty(true);}}/>
      </label>
      <div className="sw-theme-actions">
       <button className="sw-primary" disabled={busy||!dirty||!title.trim()||(Boolean(id)&&!theme)} onClick={save}>{t('保存主题','Save theme')}</button>
       {theme&&<button className="sw-danger" disabled={busy} onClick={removeTheme}>{t('删除主题','Delete theme')}</button>}
      </div>
     </>:<div className="sw-theme-intro">
      <h1>{theme.title}</h1>
      {theme.summary&&<ThemeSummary key={theme.id} summary={theme.summary} t={t}/>}
     </div>}
     {theme&&(!singlePane||!showEditor)&&<section className="sw-theme-passages">
      <h2>{t('主题片段','Passages')} · {theme.members.length}</h2>
      {!theme.members.length&&<p>{t('还没有片段，可从素材或读书笔记加入。','Add passages from materials or reading notes.')}</p>}
      <PassageGrid members={theme.members}>{theme.members.map(member=>(
       <ThemePassageCard key={member.id} member={member} t={t} status={status[member.location?.status]||member.location?.status}
        busy={busy} context={context?.id===member.id?context:null} showContext={showContext}
        openSource={openMember} removeMember={removeMember}/>
      ))}</PassageGrid>
     </section>}
    </>}
   </section>
  </div>
 </main>;
}

function ThemeListItem({row,t,current,singlePane,showAction,setActionId,choose}){
 const button=useRef(null),press=useRef(null),held=useRef(false);
 function cancelPress(){clearTimeout(press.current?.timer);press.current=null;}
 useEffect(()=>cancelPress,[singlePane]);
 function reveal(){cancelPress();held.current=true;setActionId(row.id);}
 function start(event){
   cancelPress();held.current=false;
   if(!singlePane||!event.isPrimary||event.button!==0||event.pointerType==='mouse')return;
   press.current={x:event.clientX,y:event.clientY,timer:setTimeout(reveal,500)};
 }
 function move(event){
   const point=press.current;
   if(point&&Math.hypot(point.x-event.clientX,point.y-event.clientY)>8)cancelPress();
 }
 return <div className="sw-theme-list-line" onBlur={event=>{
   if(showAction&&!event.currentTarget.contains(event.relatedTarget))setActionId('');
 }} onKeyDown={event=>{
   if(event.key==='Escape'&&showAction){setActionId('');button.current.focus();}
 }}>
   <button type="button" ref={button} className="sw-theme-list-item" aria-current={current?'true':undefined}
    aria-keyshortcuts={singlePane?'Shift+F10':undefined}
    onPointerDown={start} onPointerMove={move} onPointerCancel={cancelPress} onPointerUp={cancelPress} onPointerLeave={cancelPress}
    onContextMenu={event=>{if(singlePane){event.preventDefault();reveal();}}}
    onKeyDown={event=>{
      if(singlePane&&(event.key==='ContextMenu'||(event.shiftKey&&event.key==='F10'))){event.preventDefault();reveal();}
    }}
    onClick={event=>{
      if(singlePane&&held.current&&event.detail!==0){held.current=false;return;}
      choose(row.id,button.current);
    }}>
     <strong>{row.title}</strong><small>{row.memberCount} {t('个片段','passages')}</small>
   </button>
   {singlePane&&showAction&&<button type="button" className="sw-theme-list-edit"
    onClick={()=>choose(row.id,button.current,true)}>{t('编辑','Edit')}</button>}
 </div>;
}

function ThemeSummary({summary,t}){
 const text=useRef(null),[long,setLong]=useState(false),[expanded,setExpanded]=useState(false);
 useLayoutEffect(()=>{
   const node=text.current;
   function measure(){setLong(node.scrollHeight>parseFloat(getComputedStyle(node).lineHeight)*3+1);}
   measure();const observer=new ResizeObserver(measure);observer.observe(node);
   return ()=>observer.disconnect();
 },[summary]);
 return <><p ref={text} className="sw-theme-summary" data-expanded={expanded||undefined}>{summary}</p>
   {long&&<button type="button" className="sw-theme-summary-toggle" aria-expanded={expanded} onClick={()=>setExpanded(v=>!v)}>
     {expanded?t('收起说明','Collapse description'):t('展开说明','Expand description')}
   </button>}</>;
}

// Span a fine grid by each card's measured height. DOM and keyboard order stay
// chronological when the user expands a quote or opens its context.
function PassageGrid({members,children}){
 const grid=useRef(null);
 useLayoutEffect(()=>{
  const el=grid.current;
  const cards=Array.from(el.children);
  function fit(card,height){
   card.style.setProperty('--passage-rows',String(Math.ceil((height+16)/4)));
  }
  for(const card of cards)fit(card,card.getBoundingClientRect().height);
  el.dataset.packed='';
  const observer=new ResizeObserver(entries=>{
   for(const entry of entries)fit(entry.target,entry.borderBoxSize?.[0]?.blockSize??entry.target.getBoundingClientRect().height);
  });
  for(const card of cards)observer.observe(card,{box:'border-box'});
  return ()=>observer.disconnect();
 },[members]);
 return <div ref={grid} className="sw-theme-card-grid">{children}</div>;
}

// Excerpts support inline emphasis and code. All source HTML is escaped.
const excerptMarkup=new MarkdownIt('zero',{breaks:true}).enable(['emphasis','backticks','newline','escape']);

function ThemePassageCard({member,t,status,busy,context,showContext,openSource,removeMember}){
 const [expanded,setExpanded]=useState(false);
 const quote=member.quote||'';
 const preview=quote.slice(0,140).split('\n').slice(0,4).join('\n').replace(/[\uD800-\uDBFF]$/,'');
 const long=preview.length<quote.length;
 const unavailable=['deleted','library_mismatch'].includes(member.location?.status);
 return <article className="sw-theme-member" data-field={member.field} data-long={long||undefined}>
  <blockquote dangerouslySetInnerHTML={{__html:excerptMarkup.renderInline(long&&!expanded?preview.trimEnd()+'…':quote)}}/>
  {long&&<button type="button" className="sw-theme-quote-toggle" aria-expanded={expanded} onClick={()=>setExpanded(v=>!v)}>{expanded?t('收起片段','Collapse passage'):t('展开片段','Expand passage')}</button>}
  {context&&<div className="sw-theme-context">{context.loading?t('正在读取…','Loading…'):context.error?<span role="alert">{context.error} <button onClick={()=>showContext(member)}>{t('重试','Retry')}</button></span>:(()=>{const loc=member.location,source=member.field==='excerpt'?decodeReadingNote(context.record.annotation)?.excerpts?.[loc?.excerptIndex??member.excerptIndex]?.text:context.record.markdown;const located=typeof source==='string'&&Number.isInteger(loc?.start)&&source.slice(loc.start,loc.end)===member.quote;return <><strong>{context.record.title}</strong><p>{located?t('定位结果见下方上下文，打开原文可阅读全文。','The passage is located below; open the source to read it in full.'):t('原文已变化或无法定位，请对照下方当前内容与片段快照。','The source changed or could not be located; compare the current content with the snapshot.')}</p><pre>{typeof source!=='string'?t('当前内容不可用','Current content unavailable'):located?<>{source.slice(Math.max(0,loc.start-150),loc.start)}<mark>{source.slice(loc.start,loc.end)}</mark>{source.slice(loc.end,Math.min(source.length,loc.end+150))}</>:source}</pre></>;})()}</div>}
  <footer className="sw-theme-card-footer">
   <div className="sw-theme-card-source">{member.currentTitle||member.sourceTitle||t('未命名','Untitled')}</div>
   <div className="sw-theme-card-kind">
    <span>{kindLabel(member.currentKind||member.sourceKind,t)} · {fieldLabel(member.field,t)}</span>
    <small>{status}</small>
   </div>
   <div className="sw-theme-card-actions">
   <button type="button" disabled={busy||unavailable} onClick={()=>showContext(member)}>{t('查看上下文','View context')}</button>
   <button type="button" disabled={busy||unavailable} onClick={()=>openSource(member)}>{t('打开原文','Open source')}</button>
   <button type="button" className="sw-danger" disabled={busy} onClick={()=>removeMember(member)}>{t('移除','Remove')}</button>
   </div>
  </footer>
 </article>;
}
