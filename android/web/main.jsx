import {MessageDialog} from './MessageDialog.jsx';
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {bootstrap, call, isNative, leaveApp} from '../bridge/library.mjs';
import './style.css';
import './theme.css';
import './shell.css';
import {ChatPanel} from './ChatPanel.jsx';
import {SettingsPanel} from './SettingsPanel.jsx';
import {RecordPanel} from './RecordPanel.jsx';
import {MarkdownView} from './MarkdownView.jsx';
import {attachmentImageIds} from './markdown-renderer.mjs';
import {applyAppearance,setLanguage,useI18n} from './i18n.js';
import {enqueueRecordDraft,flushRecordDraft} from './record-draft-queue.mjs';
import './mobile-translations.mjs';
const fresh = () => ({requestId: crypto.randomUUID(), title: '', markdown: '', kind: 'journal', origin:'personal', localGeneration: 0});
const localDay=()=>{const date=new Date();return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;};
function Icon({name}) {
  const paths = {chat: 'M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-2 2V11.5a9.5 9.5 0 0 1 19 0Z',
    notes: 'm12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5',
    write: 'm15 4 5 5M4 20l4-1L21 6l-4-4L4 15v5Z',
    review: 'M12 7v5l4 2M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z',
    services:'M4 5h16v6H4zM4 14h16v6H4zM7 8h.01M7 17h.01',sync:'M20 7h-5V2M4 17h5v5M20 7a8 8 0 0 0-14-2M4 17a8 8 0 0 0 14 2',model:'M8 3h8v3H8zM5 8h14v12H5zM9 12h6M9 16h6',settings: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm0-5v2m0 14v2m9-9h-2M5 12H3m15.36-6.36-1.42 1.42M7.06 16.94l-1.42 1.42m12.72 0-1.42-1.42M7.06 7.06 5.64 5.64'};
  return <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]}/></svg>;
}
function App() {
  const {t}=useI18n();
  const libraryLabel=value=>({standalone:t('仅本机','On phone'),coordinated:t('已连接','Connected'),replica:t('同步副本','Replica'),paused:t('已暂停','Paused'),'rebind-required':t('需要重新绑定','Rebind required'),complete:t('完整副本','Complete replica'),incomplete:t('资料不完整','Incomplete'),initializing:t('初次同步中','Initial sync'),idle:t('已连接','Connected'),syncing:t('同步中','Syncing'),conflicted:t('有待处理冲突','Conflicts need attention'),error:t('同步异常','Sync error')}[value]||value||t('未知','Unknown'));
  const originLabel=value=>({personal:t('自己书写','Written by me'),external:t('外部资料','External source'),ai:t('AI 内容','AI content'),translation:t('译文','Translation')}[value]||t('来源待确认','Source unconfirmed'));
  const [ready, setReady] = useState(false), [tab, setTab] = useState('chat'), [draft, setDraft] = useState(fresh);
  const [appVersion,setAppVersion]=useState(isNative?'':t('预览','Preview'));
  useEffect(()=>{if(ready&&isNative)call('appInfo').then(info=>setAppVersion(info.versionName?`v${info.versionName}`:t('版本未知','Version unknown'))).catch(()=>setAppVersion(t('版本未知','Version unknown')));},[ready]);
  const [libraryId, setLibraryId] = useState(''), [libraryContext,setLibraryContext]=useState(null), [libraries,setLibraries]=useState([]), [modelConfig, setModelConfig] = useState({configured:false});
  const [legacyArticleDraft,setLegacyArticleDraft]=useState(null);
  useEffect(()=>{if(!ready||!libraryId)return;let active=true;call('recordDraftRead',{libraryId,slot:'articles'}).then(result=>{if(active)setLegacyArticleDraft(Boolean(result.draft));}).catch(()=>{if(active)setLegacyArticleDraft(null);});return()=>{active=false;};},[ready,libraryId,tab]);
  const [libraryConnection,setLibraryConnection]=useState(null);
  useEffect(()=>{
    if(!ready||!libraryId)return;
    let disposed=false,busy=false,timer;
    setLibraryConnection(null);
    const refresh=async()=>{
      if(disposed||busy||document.visibilityState==='hidden')return;
      clearTimeout(timer);busy=true;
      try{
        const snapshot=await call('libraryConnectionStatus');
        if(!disposed&&snapshot.libraryId===libraryId)setLibraryConnection(snapshot);
      }catch{if(!disposed)setLibraryConnection(null);}
      finally{busy=false;if(!disposed)timer=setTimeout(refresh,5000);}
    };
    const visibility=()=>{if(document.visibilityState==='visible')void refresh();else clearTimeout(timer);};
    void refresh();document.addEventListener('visibilitychange',visibility);
    return()=>{disposed=true;clearTimeout(timer);document.removeEventListener('visibilitychange',visibility);};
  },[ready,libraryId]);
  const [pageState, setPageState] = useState({dirty:false,busy:false});
  const [agentSending, setAgentSending] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const childNavigation=useRef(null),backRunning=useRef(false);
  const [childDepth,setChildDepth]=useState(false);
  const onNavigation=useCallback(value=>{childNavigation.current=value;setChildDepth(Boolean(value.depth));},[]);
  const listViews = useRef({});
  const saveMaterialsView = useCallback(value => { listViews.current[`${libraryId}:materials`] = value; }, [libraryId]);
  const saveArticlesView = useCallback(value => { listViews.current[`${libraryId}:articles`] = value; }, [libraryId]);
  useEffect(() => {
    if (!libraryOpen) return;
    const previous = document.activeElement;
    const handleKey = event => {
      if (event.key === 'Escape') { event.preventDefault(); setLibraryOpen(false); }
    };
    document.addEventListener('keydown', handleKey);
    return () => { document.removeEventListener('keydown', handleKey); previous?.focus?.(); };
  }, [libraryOpen]);
  const [reading, setReading] = useState(null), [message, setMessage] = useState('');
  const [uncertain, setUncertain] = useState(false), [saving, setSaving] = useState(false), [saved, setSaved] = useState(null), [editor, setEditor] = useState(false);
  const [journalNotice,setJournalNotice]=useState(false);
  useEffect(()=>{setJournalNotice(Boolean(editor&&!uncertain&&draft.kind==='journal'));},[editor,uncertain,draft.kind]);
  const timer = useRef(), writing = useRef(Promise.resolve()), draftRef = useRef(draft),generationRef=useRef(0),pendingMutationRef=useRef(null);
  const refreshLibraries = async () => {const value=await call('libraryList');setLibraries(value.items||[]);return value;};
  const activateLibrary = async context => {
    const stored=await call('recordDraftRead',{libraryId:context.libraryId,slot:'composer'});
    const pending=stored.draft?.pendingMutation||null;
    const value=stored.draft?{requestId:stored.draft.requestId,title:stored.draft.content?.title||'',markdown:stored.draft.content?.markdown||'',kind:stored.draft.content?.kind||'journal',origin:stored.draft.content?.origin,localGeneration:Number(stored.draft.localGeneration||0)}:{...fresh(),localGeneration:Number(stored.nextGeneration||0)};
    draftRef.current=value;setDraft(value);generationRef.current=Number(value.localGeneration);pendingMutationRef.current=pending;setUncertain(Boolean(pending));
    setLibraryContext(context);setLibraryId(context.libraryId);setPageState({dirty:false,busy:false});setReading(null);setSaved(null);setEditor(false);
    setMessage(pending?t('该资料库有一条上次提交待核对；草稿已恢复，请用同一请求再次确认。','This library has a previous save that needs verification. The draft is restored; verify it with the same request.'):'');
    return pending;
  };
  useEffect(() => {
    let active = true;
    if (!isNative) return;
    bootstrap().then(async context => {
      if (active) {setLibraryId(context.libraryId);setLibraryContext(context);}
      const [stored, legacyStored, registry, model, appearance] = await Promise.all([
        call('recordDraftRead',{libraryId:context.libraryId,slot:'composer'}).catch(()=>({draft:null,nextGeneration:0})),
        call('readDraft').catch(()=>({draft:null})),
        call('libraryList').catch(()=>({items:[],activeId:context.libraryId})),
        call('modelConfig').catch(() => ({configured:false})),call('settingsGet').catch(()=>null)
      ]);
      if(active)setLibraries(registry.items||[]);
      if (active) setModelConfig(model);
      generationRef.current=Number(stored.nextGeneration||0);
      if(active&&appearance){setLanguage(appearance.language);applyAppearance(appearance.theme,appearance.systemDark);}
      const found=stored.draft?stored.draft:legacyStored.draft?{requestId:legacyStored.draft.requestId,localGeneration:legacyStored.draft.localGeneration,content:legacyStored.draft,pendingMutation:null}:null;
      if(found){
        const content=found.content||{};const restored={requestId:found.requestId,title:content.title||'',markdown:content.markdown||'',kind:content.kind||'journal',origin:content.origin,localGeneration:Number(found.localGeneration||0)};
        generationRef.current=restored.localGeneration;draftRef.current=restored;if(active)setDraft(restored);
        if(found.pendingMutation){
          pendingMutationRef.current=found.pendingMutation;
          try{
            const pending=found.pendingMutation;
            const result=await call('recordCreate',{libraryId:context.libraryId,requestId:pending.requestId,localGeneration:pending.localGeneration,record:pending.record});
            const ack=await enqueueRecordDraft(`${context.libraryId}:composer`,()=>call('recordDraftAcknowledge',{libraryId:context.libraryId,slot:'composer',requestId:pending.requestId,localGeneration:pending.localGeneration}));
            if(!ack.cleared)throw new Error(t('记录已保存，草稿回执仍待确认。','Record saved; the draft receipt still needs confirmation.'));
            pendingMutationRef.current=null;generationRef.current=Number(pending.localGeneration)+1;
            if(active){setSaved(result.record);setMessage(t('上次提交的记录已确认保存。','The previous save was confirmed.'));}
          }catch(e){if(active){setUncertain(true);setMessage(`${t('上次记录提交结果待核对，正文已恢复：','The previous save needs verification. The text was restored: ')}${String(e.message||e)}`);}}
        }
      }
      if (active) setReady(true);
    }).catch(e => active && setMessage(e.message));
    return () => {active = false; clearTimeout(timer.current);};
  }, []);
  const persist = (next,pending=null) => {
    const content={title:next.title,markdown:next.markdown,kind:next.kind,...(next.origin?{origin:next.origin}:{})};
    writing.current = enqueueRecordDraft(`${libraryId}:composer`,()=>call('recordDraftSave',{libraryId,slot:'composer',requestId:next.requestId,localGeneration:next.localGeneration,content,pendingMutation:pending||undefined}));
    writing.current.catch(e => setMessage(`${t('草稿未保存：','Draft was not saved: ')}${e.message}`));
    return writing.current;
  };
  const edit = patch => {
    const next = {...draftRef.current, ...patch, localGeneration: Math.max(draftRef.current.localGeneration,generationRef.current) + 1};
    generationRef.current=next.localGeneration;
    draftRef.current = next; setDraft(next); clearTimeout(timer.current);
    timer.current = setTimeout(() => persist(next), 300);
  };
  const save = async () => {
    if (!ready || saving) return;
    if(!pendingMutationRef.current&&attachmentImageIds(draftRef.current.markdown).size){setMessage(t('正文引用的图片不存在，请到素材或创作页插入图片。','An image referenced in the text is missing. Insert images from Materials or Writing.'));return;}
    clearTimeout(timer.current); setSaving(true); setMessage('');
    const pending = {...draftRef.current};
    try {
      await persist(pending);
      const mutation=pendingMutationRef.current||(()=>{const markdown=pending.markdown.trim();return {action:'create',requestId:pending.requestId,localGeneration:pending.localGeneration,record:{kind:pending.kind,title:pending.title.trim()||markdown.slice(0,32),markdown,origin:pending.origin||'personal',processing:'original',contentDay:localDay(),dateBasis:'手机直接记录',url:'',annotation:'',stage:'draft',sourceIds:[],sources:[{text:markdown,origin:pending.origin||'personal'}]}};})();
      pendingMutationRef.current=mutation;
      await persist(pending,mutation);
      const result = await call('recordCreate', {libraryId,requestId:mutation.requestId,localGeneration:mutation.localGeneration,record:mutation.record});
      if(!result.record?.id)throw new Error(t('保存回执没有记录编号','The save receipt has no record ID.'));
      const ack=await enqueueRecordDraft(`${libraryId}:composer`,()=>call('recordDraftAcknowledge',{libraryId,slot:'composer',requestId:mutation.requestId,localGeneration:mutation.localGeneration}));
      if(!ack.cleared)throw new Error(t('保存成功但草稿回执未确认。','Saved, but the draft receipt is not confirmed.'));
      pendingMutationRef.current=null;generationRef.current=mutation.localGeneration+1;
      setSaved(result.record); setUncertain(false);
      const next = {...fresh(),localGeneration:generationRef.current}; draftRef.current = next; setDraft(next); setEditor(false);
      setMessage(result.syncState==='pending'?t('记录已保存在手机，等待同步。','Saved on this phone and waiting to sync.'):result.syncState==='local-only'?t('记录已保存到本机资料库。','Saved in the local library.'):t('记录已保存到当前资料库。','Saved to the current library.'));
    } catch (e) { setUncertain(true); setMessage(`${t('保存结果待核对，文字仍在编辑区。请点击再次核对：','The save needs verification. Your text remains in the editor. Check again: ')}${e.message}`); }
    finally {setSaving(false);}
  };
  const switchTab = async target => {
    if (target === tab) return;
    if(uncertain||pendingMutationRef.current){setMessage(t('当前记录提交结果尚未确认，请先留在本资料库核对。','The previous save is not verified. Stay in this library and check it first.'));return;}
    if (pageState.busy) { setMessage(t('当前操作尚未完成，请等待保存或同步结束后再离开。','The current operation is still running. Wait for it to finish before leaving.')); return; }
    if (pageState.dirty && !window.confirm(t('离开将丢弃当前页面尚未保存的编辑。确定离开吗？','Leaving will discard unsaved edits on this page. Continue?'))) return;
    setPageState({dirty:false,busy:false});
    if (ready) {clearTimeout(timer.current); try {await persist(draftRef.current);} catch {return;}}
    childNavigation.current=null;setChildDepth(false);setTab(target); setReading(null); setEditor(false);
  };
  const read = async id => {try {setReading(await call('recordRead', {libraryId,id}));} catch(e) {setMessage(e.message);}};
  const changeLibrary=async id=>{
    if(!id||id===libraryId||agentSending||saving)return;
    if(uncertain||pendingMutationRef.current){setMessage(t('当前记录提交结果尚未确认，请先核对后再切换资料库。','The previous save is not verified. Check it before switching libraries.'));return;}
    if(pageState.busy){setMessage(t('当前操作尚未完成，完成后再切换资料库。','The current operation is still running. Switch libraries after it finishes.'));return;}
    if(pageState.dirty&&!window.confirm(t('切换资料库会放弃当前页面尚未保存的编辑。确定继续吗？','Switching libraries will discard unsaved edits on this page. Continue?')))return;
    try{clearTimeout(timer.current);await persist(draftRef.current);await writing.current;const context=await call('librarySelect',{libraryId:id});await activateLibrary(context);const snapshot=await refreshLibraries();setLibraries(snapshot.items||[]);}
    catch(e){setMessage(`${t('切换资料库失败：','Could not switch library: ')}${String(e.message||e)}`);}
  };
  useEffect(()=>{
    window.__shiwenBack=()=>{
      if(window.__shiwenModalBack){window.__shiwenModalBack();return true;}
      if(backRunning.current)return true;
      if(!ready&&!libraryOpen)return false;
      backRunning.current=true;
      Promise.resolve().then(async()=>{
        if(libraryOpen){setLibraryOpen(false);return;}
        if(reading){setReading(null);return;}
        if(saving||agentSending||uncertain||pendingMutationRef.current||pageState.busy){setMessage(t('当前操作尚未完成，请先核对。','Finish or verify the current operation first.'));return;}
        if(editor){clearTimeout(timer.current);await persist(draftRef.current);setEditor(false);return;}
        if(childNavigation.current?.depth){await childNavigation.current.back();return;}
        if(pageState.dirty&&!window.confirm(t('放弃尚未保存的修改？','Discard unsaved changes?')))return;
        if(ready){clearTimeout(timer.current);await persist(draftRef.current);}
        await leaveApp();
      }).catch(e=>setMessage(`${t('无法返回：','Could not go back: ')}${e.message||e}`)).finally(()=>{backRunning.current=false;});
      return true;
    };
    return()=>{delete window.__shiwenBack;};
  });
  const selectedLibrary=libraries.find(item=>item.libraryId===libraryId);
  const connectionState=libraryConnection?.libraryId===libraryId?libraryConnection.state:'unknown';
  const connectionLabel=({online:t('在线','Online'),offline:t('离线','Offline'),'no-network':t('离线','Offline'),
    'login-required':t('在线 · 需登录','Online · sign in'),local:t('本机','On phone'),checking:t('检查中','Checking'),
    'identity-mismatch':t('身份不匹配','Identity mismatch'),'service-error':t('服务异常','Service error'),
    unbound:t('未连接','Not connected')}[connectionState]||t('待检查','Not checked'));
  const connectionTone=['online','login-required'].includes(connectionState)?'online':
    ['offline','no-network','identity-mismatch','service-error'].includes(connectionState)?'offline':'neutral';

  return <div className="app">
    <header className="shell-header"><div className="brand"><img src="./shiwen-mark.png" alt=""/><strong>{tab==='chat'?t('皮皮','Pipi'):({notes:t('素材','Materials'),reading:t('读书笔记','Reading notes'),write:t('创作','Writing'),review:t('回顾','Review'),sync:t('同步','Sync'),services:t('服务','Server'),model:t('模型','Model'),settings:t('设置','Settings')}[tab])}</strong><small className="app-version">{appVersion}</small></div><button className="library-trigger" type="button" aria-haspopup="dialog" aria-expanded={libraryOpen} onClick={()=>setLibraryOpen(true)} disabled={!ready||agentSending||saving||pageState.busy||childDepth}><span className="library-trigger-content"><span className="library-trigger-name">{selectedLibrary?.name||t('选择资料库','Choose library')}</span>{ready&&<span className={`library-connection is-${connectionTone}`} role="status"><i aria-hidden="true"/>{connectionLabel}</span>}</span><span className="library-trigger-chevron" aria-hidden="true">⌄</span></button></header>
    {libraryOpen && <div className="sheet-backdrop" onClick={()=>setLibraryOpen(false)}><section className="library-sheet" role="dialog" aria-modal="true" aria-label={t('切换资料库','Switch library')} onClick={e=>e.stopPropagation()}><div className="sheet-heading"><h2>{t('切换资料库','Switch library')}</h2><button type="button" onClick={()=>setLibraryOpen(false)} aria-label={t('关闭','Close')}>×</button></div><div className="sheet-list">{libraries.map(item=><button type="button" key={item.libraryId} className="sheet-library" aria-current={item.libraryId===libraryId?'true':undefined} onClick={async()=>{await changeLibrary(item.libraryId);setLibraryOpen(false);}}><span><strong>{item.name}</strong><small>{libraryLabel(item.role||'standalone')} · {libraryLabel(item.integrity)}</small></span>{item.libraryId===libraryId&&<span aria-hidden="true">✓</span>}</button>)}</div><button type="button" className="sheet-manage" onClick={()=>{setLibraryOpen(false);switchTab('settings');}}>{t('管理资料库和服务','Manage libraries and servers')}　›</button></section></div>}
    {!isNative && <p className="notice">{t('浏览器布局预览 · 保存需要 Android 原生资料库','Browser layout preview · saving requires the native Android library')}</p>}
    <main className={tab === 'chat' && !reading && !editor ? 'chat-main' : undefined}>
      {reading ? <article className="reading"><button className="text" onClick={() => setReading(null)}>‹ {t('返回','Back')}</button><h1>{reading.title}</h1><p className="secondary">{originLabel(reading.origin)} · {reading.contentDay||reading.createdAt?.slice(0, 10)||t('日期待确认','Date unconfirmed')}</p><MarkdownView markdown={reading.markdown} libraryId={libraryId} recordId={reading.id} attachmentDescriptors={reading.attachmentDescriptors}/></article> : tab === 'chat' ? <>
        {editor ? <><button className="text" onClick={() => setEditor(false)}>‹ {t('返回助手','Back to assistant')}</button><h1>{t('直接记录','Quick note')}</h1><p className="secondary">{t('保存到手机资料库，无需模型或电脑服务。','Save to the phone library without a model or desktop service.')}</p></> : <ChatPanel key={libraryId} libraryId={libraryId} ready={ready} config={modelConfig} onRead={read} onSending={setAgentSending} onOpenSettings={() => switchTab('settings')} onOpenModel={() => switchTab('model')} onDirect={async (text, options = {}) => {
          if(options.submit && (saving || uncertain || draftRef.current.markdown || draftRef.current.title)){setMessage(t('已有一条未完成的记录，请先处理。会话原文不会丢失。','There is already an unfinished note. Handle it first; the conversation text is preserved.'));setEditor(true);return;}
          if (text && (text !== draftRef.current.markdown || (options.origin && options.origin !== (draftRef.current.origin||'personal')))) {
            if (saving || uncertain || draftRef.current.markdown || draftRef.current.title) {setMessage(t('已有一条未完成的记录，请先处理。会话原文不会丢失。','There is already an unfinished note. Handle it first; the conversation text is preserved.'));setEditor(true);return;}
            else edit({markdown:text, kind:options.kind || 'journal', origin:options.origin || 'personal'});
          }
          if(options.submit){await save();return;}
          setEditor(true);
        }}/>}
        {!editor&&(draft.markdown||draft.title||uncertain)&&<button className="chip" onClick={()=>setEditor(true)}>{uncertain?t('核对未完成的记录','Verify unfinished note'):t('继续未完成的记录','Continue unfinished note')}</button>}
      </> : tab === 'notes' ? <RecordPanel key={`${libraryId}-materials`} libraryId={libraryId} libraries={libraries} mode="materials" onNavigation={onNavigation} viewState={listViews.current[`${libraryId}:materials`]} onViewStateChange={saveMaterialsView} onPageStateChange={setPageState}/> : tab === 'write' ? <RecordPanel key={`${libraryId}-articles`} libraryId={libraryId} libraries={libraries} mode="articles" legacyOnly onNavigation={onNavigation} viewState={listViews.current[`${libraryId}:articles`]} onViewStateChange={saveArticlesView} onPageStateChange={setPageState}/> : ['settings','services','model'].includes(tab) ? <SettingsPanel key={tab} initialPage={tab==='services'?'services':tab==='model'?'model':'home'} pageState={pageState} onNavigation={onNavigation} ready={ready} libraryId={libraryId} libraries={libraries} libraryContext={libraryContext} config={modelConfig} onConfig={setModelConfig} onPageStateChange={setPageState} onNavigate={switchTab} onLibrariesRefresh={refreshLibraries} onLibraryChange={context=>activateLibrary(context).then(refreshLibraries).then(snapshot=>setLibraries(snapshot.items||[])).catch(e=>setMessage(`${t('切换资料库失败：','Could not switch library: ')}${String(e.message||e)}`))}/>: null}
      {tab==='notes'&&legacyArticleDraft!==false&&!childDepth&&<button className="chip" onClick={()=>switchTab('write')}>{legacyArticleDraft?t('继续未完成的文章草稿','Continue unfinished article draft'):t('核对旧文章草稿','Check old article draft')}</button>}
      {message&&<MessageDialog message={message} onClose={()=>{setMessage('');setSaved(null);}}>{saved&&<button className="chip" onClick={()=>{setMessage('');setSaved(null);read(saved.id);}}>{t('查看已保存记录','View saved record')}</button>}</MessageDialog>}
    </main>
    {editor && !reading && <section className="composer" aria-label={t('直接记录','Quick note')}>
      {editor && <input aria-label={t('标题','Title')} placeholder={t('标题（可选）','Title (optional)')} value={draft.title} onChange={e => edit({title: e.target.value})} disabled={saving || uncertain || !ready} maxLength={200}/>}
      <textarea aria-label={t('记录正文','Note content')} placeholder={t('写下日记或刚刚闪过的想法…','Write a journal entry or a thought…')} value={draft.markdown} onChange={e => edit({markdown: e.target.value})} disabled={saving || uncertain || !ready} maxLength={1_000_000}/>
      {journalNotice&&<MessageDialog message={t('同一天已有日记时，内容会追加到当日日记。','If a journal already exists for this day, this text will be appended.')} onClose={()=>setJournalNotice(false)}/>}
      <div><select aria-label={t('记录类型','Note type')} value={draft.kind} onChange={e => edit({kind: e.target.value})} disabled={saving || uncertain || !ready}><option value="journal">{t('日记','Journal')}</option><option value="idea">{t('想法','Idea')}</option><option value="freewrite">{t('自由书写','Freewriting')}</option><option value="reading_note">{t('读书笔记','Reading note')}</option><option value="web">{t('网页','Web')}</option><option value="ai">{t('AI 讨论','AI discussion')}</option><option value="reference">{t('参考资料','Reference')}</option></select><button className="primary" disabled={!ready || saving || !draft.markdown.trim()} onClick={save}>{saving ? t('核对并保存…','Verifying and saving…') : uncertain ? t('再次核对','Check again') : t('直接记录','Save note')}</button></div>
    </section>}
    <nav hidden={Boolean(reading || editor || childDepth)} aria-label={t('主导航','Main navigation')}>{[['chat','对话','Chat'],['notes','素材','Materials'],['model','模型','Model'],['settings','设置','Settings']].map(([key,label,en]) => <button key={key} aria-current={tab===key?'page':undefined} disabled={saving || agentSending} onClick={() => switchTab(key)}><Icon name={key}/><span>{t(label,en)}</span></button>)}</nav>
  </div>;
}
createRoot(document.getElementById('root')).render(<App/>);
