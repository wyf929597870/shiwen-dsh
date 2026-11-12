import {MessageDialog} from './MessageDialog.jsx';
import './chat-translations.mjs';
import './chat-redesign.css';
import {t,useI18n} from './i18n.js';
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {call} from '../bridge/library.mjs';
import {RemoteChatPanel} from './RemoteChatPanel.jsx';
import {AgentProposals} from './AgentProposals.jsx';
import {SessionSheet} from './SessionSheet.jsx';
import {MarkdownView} from './MarkdownView.jsx';
import {MessageBubble} from './MessageBubble.jsx';

// Writes from mounted and unmounted chat views share one queue. Each queued value
// contains the conversation id captured at edit time, never a mutable selection.
let draftWrites = Promise.resolve();
const queueDraft = (conversationId, draft) => {
  const payload = {...draft, conversationId};
  draftWrites = draftWrites.catch(() => {}).then(() => call('agentSaveDraft', payload));
  return draftWrites;
};
const waitForDraftWrites = () => draftWrites.catch(() => {});
const uid = () => crypto.randomUUID();
const emptyDraft = () => ({id:uid(), input:'', saveOriginal:false, kind:'journal', localGeneration:0});
const isRunning = task => task && ['admitted','running'].includes(task.status);
const terminalLabels = {succeeded:'已完成', failed:'失败', interrupted:'已中断', cancelled:'已取消', admitted:'排队中', running:'正在处理'};
const kindLabels = {journal:'日记', freewrite:'自由书写', reading_note:'读书笔记', idea:'想法', web:'网页', ai:'AI 讨论', reference:'参考资料'};
const mergeTaskPage = (current, rows, position = 'latest') => {
  const latest = new Map(rows.map(row => [row.id, row]));
  const known = new Set(current.map(row => row.id));
  const existing = current.map(row => latest.get(row.id) || row);
  const added = rows.filter(row => !known.has(row.id));
  return position === 'older' ? [...added, ...existing] : [...existing, ...added];
};

export function ChatPanel(props) {
  useI18n();
  const [mode,setMode]=useState('local'),[nodes,setNodes]=useState([]),[selected,setSelected]=useState(''),[busy,setBusy]=useState(false);
  useEffect(()=>{let active=true;if(props.ready)call('nodeList').then(result=>{if(active){setNodes(result.items??result.nodes??[]);setSelected(result.activeId??'');}}).catch(()=>{});return()=>{active=false;};},[props.ready]);
  const node=nodes.find(item=>item.id===selected);
  const sending=value=>{setBusy(value);props.onSending?.(value);};
  return <div className="chat-execution">
    <details className="chat-execution-bar chat-mode-menu">
      <summary>{mode==='local'?t('手机助手'):t('服务器助手')} ▾</summary><div className="chat-mode-switch" role="group" aria-label={t('助手运行位置')}>
        <button type="button" aria-pressed={mode==='local'} disabled={busy} onClick={()=>setMode('local')}>{t('手机助手')}</button>
        <button type="button" aria-pressed={mode==='remote'} disabled={busy} onClick={()=>setMode('remote')}>{t('服务器助手')}</button>
      </div>
      {mode==='remote'&&<select aria-label={t('会话服务器')} disabled={busy} value={selected} onChange={event=>setSelected(event.target.value)}><option value="">{t('选择服务器')}</option>{nodes.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select>}
    </details>
    {mode==='remote'?<>
      {node?<RemoteChatPanel key={`${node.id}:${node.configRevision}`} node={node} onSending={sending} onDirect={props.onDirect}/>:<p>{t('请先在设置中添加并连接服务器。')}<button className="text" onClick={props.onOpenSettings}>{t('打开设置')}</button></p>}</>:<LocalChatPanel {...props} onSending={sending}/>}
  </div>;
}

function LocalChatPanel({ready, config, onRead, onDirect, onSending, onOpenSettings, onOpenModel}) {
  useI18n();
  const [conversations, setConversations] = useState([]), [activeId, setActiveId] = useState(null);
  const [draft, setDraft] = useState(emptyDraft), [tasks, setTasks] = useState([]), [nextOffset, setNextOffset] = useState(null);
  const [loading, setLoading] = useState(false), [sending, setSending] = useState(false), [message, setMessage] = useState('');
  const [conflict, setConflict] = useState(false), [profileIssue, setProfileIssue] = useState('');
  const [sessionNoticeClosed,setSessionNoticeClosed]=useState(false),[taskError,setTaskError]=useState('');
  const [sheetOpen, setSheetOpen] = useState(false);
  const [composerOpen, setComposerOpen] = useState(true),[chooseSaveKind,setChooseSaveKind]=useState(false),[composerExpanded,setComposerExpanded]=useState(false);
  const draftRef = useRef(draft), activeIdRef = useRef(activeId), conversationsRef = useRef([]), mounted = useRef(false), generation = useRef(0), timer = useRef(null);
  const createId = useRef(null), tasksByConversation = useRef(new Map());
  const active = useMemo(() => conversations.find(item => item.id === activeId) || null, [conversations, activeId]);
  const legacy = activeId === 'legacy-single-tasks';
  const archived = Boolean(active?.archived || active?.readOnly || legacy);
  const revisionChanged = Boolean(config?.configured && active?.modelRevision && active.modelRevision !== config.revision);
  useEffect(()=>setSessionNoticeClosed(false),[activeId,archived,revisionChanged]);

  const loadRecent = useCallback(async (conversationId, offset = 0, append = false) => {
    const result = await call('agentRecent', {conversationId, offset});
    if (!mounted.current || activeIdRef.current !== conversationId) return;
    const rows = [...(result.items || [])].reverse();
    setTasks(current => {
      if (!append) { tasksByConversation.current.set(conversationId, rows); return rows; }
      const merged = mergeTaskPage(current, rows, 'older');
      tasksByConversation.current.set(conversationId, merged);
      return merged;
    });
    setNextOffset(result.nextOffset ?? null);
  }, []);

  const readConversation = useCallback(async (conversationId, token) => {
    await waitForDraftWrites();
    const [stored] = await Promise.all([
      call('agentReadDraft', {conversationId}),
      loadRecent(conversationId, 0, false).catch(() => { if (mounted.current && generation.current === token) setMessage(t('会话记录暂时无法读取。','Conversation history is temporarily unavailable.')); })
    ]);
    if (!mounted.current || generation.current !== token || activeIdRef.current !== conversationId) return;
    let recovered = stored?.draft || emptyDraft(), acknowledgementConflict = false;
    const selected = conversationsRef.current.find(item => item.id === conversationId);
    const readOnly = Boolean(selected?.archived || selected?.readOnly || conversationId === 'legacy-single-tasks');
    if (!readOnly && stored?.draft?.id) {
      try {
        const status = await call('agentStatus', {conversationId, id:stored.draft.id});
        if (status.status !== 'unknown') {
          try {
            await call('agentAcknowledge', {conversationId, id:stored.draft.id, localGeneration:stored.draft.localGeneration});
            recovered = emptyDraft();
          } catch {
            acknowledgementConflict = true;
            setConflict(true);
            setMessage(t('这份草稿与已接收任务不一致，原文仍已保留。请先直接记录原文，确认后再处理会话。','This draft does not match an accepted task. The original text is preserved. Save it directly before continuing with this conversation.'));
          }
        }
      } catch { /* Keep the draft visible if native status lookup is unavailable. */ }
    }
    if (!mounted.current || generation.current !== token || activeIdRef.current !== conversationId) return;
    draftRef.current = recovered; setDraft(recovered); setConflict(acknowledgementConflict);
  }, [loadRecent]);

  const adoptSnapshot = useCallback(snapshot => {
    conversationsRef.current = snapshot.items || [];
    setConversations(conversationsRef.current);
    const id = snapshot.activeId;
    activeIdRef.current = id; setActiveId(id);
    return id;
  }, []);
  const refreshConversationSnapshot = useCallback(async () => {
    const snapshot=await call('agentConversations');
    if(mounted.current){
      conversationsRef.current=snapshot.items||[];
      setConversations(conversationsRef.current);
    }
  },[]);

  useEffect(() => {
    mounted.current = true;
    if (!ready) return () => {mounted.current = false; clearTimeout(timer.current);};
    (async () => {
      setLoading(true);
      try {
      await waitForDraftWrites();
      let snapshot = await call('agentConversations');
      let chosen = snapshot.activeId;
      if (!chosen) {
        createId.current ||= uid();
        snapshot = await call('agentCreateConversation', {id:createId.current});
        createId.current = null; chosen = snapshot.activeId;
      }
      adoptSnapshot(snapshot);
      if (chosen) await readConversation(chosen, generation.current);
      } catch (error) { if (mounted.current) setMessage(`${t('无法打开会话：','Could not open conversation: ')}${error.message}`); }
      finally { if (mounted.current) setLoading(false); }
    })();
    return () => {
      const conversationId = activeIdRef.current;
      const selected = conversationsRef.current.find(item => item.id === conversationId);
      mounted.current = false; clearTimeout(timer.current);
      if (conversationId && !selected?.archived && !selected?.readOnly && conversationId !== 'legacy-single-tasks') {
        queueDraft(conversationId, draftRef.current).catch(() => {});
      }
    };
  }, [ready, adoptSnapshot, readConversation]);

  useEffect(() => { activeIdRef.current = activeId; }, [activeId]);
  const hasRunningTask = tasks.some(isRunning);
  const runningElsewhere = conversations.filter(item => item.id !== activeId && item.running === true);
  const hasRunningConversation = hasRunningTask || runningElsewhere.length > 0;
  useEffect(() => {
    if (!ready || !activeId || !hasRunningConversation) return;
    const interval = setInterval(async () => {
      if (document.visibilityState === 'hidden') return;
      const conversationId = activeIdRef.current;
      const [snapshotResult,recentResult]=await Promise.allSettled([
        call('agentConversations'),
        hasRunningTask?call('agentRecent',{conversationId}):Promise.resolve(null)
      ]);
      if(snapshotResult.status==='fulfilled'&&mounted.current){
        conversationsRef.current=snapshotResult.value.items||[];
        setConversations(conversationsRef.current);
      }
      if(recentResult.status==='fulfilled'&&recentResult.value&&mounted.current&&activeIdRef.current===conversationId){
        const result=recentResult.value;
        try{
          const rows = [...(result.items || [])].reverse();
          const cached = tasksByConversation.current.get(conversationId) || [];
          const known = new Set(cached.map(row => row.id));
          const newCount = rows.filter(row => !known.has(row.id)).length;
          setNextOffset(current => current == null ? (result.nextOffset ?? null) : current + newCount);
          setTasks(current => {
            const merged = mergeTaskPage(current, rows);
            tasksByConversation.current.set(conversationId, merged);
            return merged;
          });
        }catch { /* Keep visible tasks if a status page is malformed. */ }
      }
    }, 3500);
    return () => clearInterval(interval);
  }, [ready, activeId, hasRunningTask, hasRunningConversation]);

  const persist = useCallback((conversationId, value) => {
    queueDraft(conversationId, value).catch(error => {
      if (mounted.current && activeIdRef.current === conversationId) setMessage(`${t('草稿未保存：','Draft not saved: ')}${error.message}`);
    });
    return draftWrites;
  }, []);
  const edit = patch => {
    if (!activeId || archived || conflict) return;
    const next = {...draftRef.current, ...patch, localGeneration:draftRef.current.localGeneration + 1};
    draftRef.current = next; setDraft(next); clearTimeout(timer.current);
    const conversationId = activeId;
    timer.current = setTimeout(() => persist(conversationId, next), 300);
  };
  const flush = async (conversationId, value) => {
    clearTimeout(timer.current);
    await persist(conversationId, value);
    await waitForDraftWrites();
  };

  const selectConversation = async conversationId => {
    if (!conversationId || conversationId === activeId || sending) return;
    const oldId = activeId, oldDraft = draftRef.current;
    try {
      if (oldId && !archived) await flush(oldId, oldDraft);
      const token = ++generation.current;
      setLoading(true); setMessage(''); setConflict(false);
      const snapshot = await call('agentSelectConversation', {id:conversationId});
      if (!mounted.current || generation.current !== token) return;
      adoptSnapshot(snapshot);
      setTasks([]); setNextOffset(null); setProfileIssue('');
      await readConversation(snapshot.activeId || conversationId, token);
    } catch (error) { setMessage(`${t('切换会话失败，原会话草稿已保留：','Could not switch conversations. The previous draft is preserved: ')}${error.message}`); }
    finally { if (mounted.current) setLoading(false); }
  };
  const toggleComposer = useCallback(() => {
    setComposerOpen(open => {
      const next = !open;
      localStorage.setItem('shiwen.chat.composerOpen', next ? '1' : '0');
      return next;
    });
  }, []);
  const deleteConversation = async item => {
    const wasActive = item.id === activeIdRef.current;
    const token = wasActive ? ++generation.current : generation.current;
    try {
      setLoading(true); setMessage('');
      if (wasActive && activeId && !archived) await flush(activeId, draftRef.current);
      const snapshot = await call('agentDeleteConversation', {id:item.id});
      if (!mounted.current || generation.current !== token) return;
      const next = adoptSnapshot(snapshot);
      if (wasActive) {
        setTasks([]); setNextOffset(null); setProfileIssue('');
        if (next) await readConversation(next, token);
      }
    } catch (error) {
      setMessage(`${t('删除会话失败：','Could not delete the conversation: ')}${error.message || error}`);
    } finally { if (mounted.current) setLoading(false); }
  };
  const createConversation = async () => {
    if (sending) return;    try {
      if (activeId && !archived) await flush(activeId, draftRef.current);
      const token = ++generation.current;
      setLoading(true); setMessage(''); setConflict(false);
      createId.current ||= uid();
      const snapshot = await call('agentCreateConversation', {id:createId.current});
      createId.current = null;
      if (!mounted.current || generation.current !== token) return;
      adoptSnapshot(snapshot);
      setTasks([]); setNextOffset(null); setProfileIssue('');
      await readConversation(snapshot.activeId, token);
    } catch (error) { setMessage(`${t('新会话未创建：','Conversation was not created: ')}${error.message}`); }
    finally { if (mounted.current) setLoading(false); }
  };
  const refresh = async () => {
    const conversationId = activeIdRef.current;
    const result = await call('agentRecent', {conversationId});
    if (mounted.current && activeIdRef.current === conversationId) {
      const rows = [...(result.items || [])].reverse();
      const cached = tasksByConversation.current.get(conversationId) || [];
      const known = new Set(cached.map(row => row.id));
      const newCount = rows.filter(row => !known.has(row.id)).length;
      setTasks(current => {
        const merged = mergeTaskPage(current, rows);
        tasksByConversation.current.set(conversationId, merged);
        return merged;
      });
      setNextOffset(current => current == null ? (result.nextOffset ?? null) : current + newCount);
    }
  };
  const send = async () => {
    const conversationId = activeId;
    if (!conversationId || !draft.input.trim() || sending || loading || archived || !config?.configured || revisionChanged || conflict) return;
    setSending(true); onSending?.(true); setMessage('');
    const submitted = {...draftRef.current};
    const modelRevision = active?.modelRevision || config.revision;
    try {
      await flush(conversationId, submitted);
      const status = await call('agentStatus', {conversationId, id:submitted.id});
      if (status.status === 'unknown') {
        await call('agentSend', {conversationId, ...submitted, revision:modelRevision});
      }
      try {
        await call('agentAcknowledge', {conversationId, id:submitted.id, localGeneration:submitted.localGeneration});
      } catch (error) {
        setConflict(true);
        setMessage(`${t('发送内容与当前草稿不一致，原文已保留，请直接记录后再继续。','Sent content does not match the current draft. The original is preserved; save it directly before continuing.')} ${error.message || ''}`);
        return;
      }
      if (activeIdRef.current === conversationId) {
        setProfileIssue('');
        const fresh = emptyDraft(); draftRef.current = fresh; setDraft(fresh); setConflict(false);
        await refresh().catch(() => setMessage(t('任务已接收，列表暂时无法刷新；请稍后回来查看，不要重复发送。','Task accepted, but the list could not refresh. Check again later; do not send it again.')));
      }
    } catch (error) {
      if (activeIdRef.current === conversationId) {
        const code = String(error.message || error);
        if (code.includes('PROFILE_CHANGED')) {
          setProfileIssue(t('服务端人设已更新。草稿仍在编辑框，请新建会话继续。','The server persona changed. Your draft remains in the editor; start a new conversation to continue.'));
          setMessage(t('人设版本发生变化，本轮没有继续执行。草稿已保留。','The persona revision changed, so this turn did not run. Your draft is preserved.'));
        } else if (code.includes('PROFILE_REFRESHING')) {
          setProfileIssue(t('正在同步助手配置，请稍后再发送。草稿已保留。','The assistant profile is syncing. Try again later; your draft is preserved.'));
          setMessage(t('助手配置正在更新，本轮暂未执行。','The assistant profile is updating, so this turn did not run.'));
        } else if (code.includes('PROFILE_NOT_SYNCED')) {
          setProfileIssue(t('当前节点的人设尚未同步。请到设置检查连接和人设同步状态，再返回发送；草稿已保留。','This server’s persona is not synced. Check the connection and profile status in Settings; your draft is preserved.'));
          setMessage(t('人设尚未同步，当前未执行本轮。','The persona is not synced, so this turn did not run.'));
        } else setMessage(`${t('发送状态待核对，草稿仍保留。请先检查任务列表：','Send status needs verification. Your draft is preserved. Check the task list first: ')}${code}`);
      }
    } finally { setSending(false); onSending?.(false); }
  };
  const cancel = async task => {
    const conversationId = task.conversationId || activeIdRef.current;
    try { await call('agentCancel', {conversationId, id:task.id}); await refresh(); }
    catch (error) { if (activeIdRef.current === conversationId) setMessage(`${t('取消状态待核对：','Cancel status needs verification: ')}${error.message}`); }
  };
  const loadOlder = async () => {
    if (!activeId || nextOffset == null || loading) return;
    try { setLoading(true); const oldOffset = nextOffset; await loadRecent(activeId, oldOffset, true); }
    catch (error) { setMessage(`${t('旧记录读取失败：','Could not load older records: ')}${error.message}`); }
    finally { setLoading(false); }
  };
  const rescue = () => onDirect?.(draft.input, {rescue:true, kind:draft.kind});
  const startWithNewModel = async () => { await createConversation(); };
  const sheetItems = conversations.map(item => ({
    id: item.id,
    title: item.title,
    subtitle: [item.archived ? t('归档') : '', item.running ? t('运行中') : '',
      item.updatedAt ? String(item.updatedAt).slice(0,16).replace('T',' ') : ''].filter(Boolean).join(' · '),
    running: item.running === true,
    readOnly: Boolean(item.readOnly),
    archived: false
  }));
  return <section className="chat-panel" aria-label={t('AI 对话')}>
    <div className="chat-toolbar">
      <div><strong>{t('拾文助手')}</strong><span>{active?.title || t('打开或新建会话')}{active?.model ? ` · ${active.model}` : ''}</span></div>
      <div className="chat-session-controls">
        <button type="button" className="session-trigger" aria-haspopup="dialog" aria-expanded={sheetOpen}
          aria-label={t('选择会话')} title={t('选择会话')} disabled={!ready || loading || sending} onClick={() => setSheetOpen(true)}>
          <span>{active?.title || t('选择会话')}</span><span className="session-trigger-caret" aria-hidden="true">▾</span>
        </button>
        <button className="chip chat-icon-action" aria-label={t('刷新会话状态','Refresh conversations')} title={t('刷新会话状态','Refresh conversations')} disabled={!ready||loading||sending} onClick={async()=>{try{await refreshConversationSnapshot();}catch(error){setMessage(`${t('会话状态读取失败：','Could not refresh conversation status: ')}${error.message||error}`);}}}>↻</button>
        <button className="chip chat-icon-action" aria-label={t('新会话','New conversation')} title={t('新会话','New conversation')} disabled={!ready || loading || sending} onClick={createConversation}>＋</button>
      </div>
    </div>
    {runningElsewhere.map(item=><button key={item.id} className="session-running" onClick={()=>selectConversation(item.id)}>{t(`“${item.title}”仍有任务运行 · 查看`,`A task is still running in “${item.title}” · View`)}</button>)}
    {(archived || revisionChanged) && !sessionNoticeClosed && <MessageDialog title={t('会话状态','Conversation status')} onClose={()=>setSessionNoticeClosed(true)}>
      {legacy ? <><strong>{t('历史单次任务（只读）')}</strong><span>{t('旧任务不会自动重发。若有旧草稿，可直接保存到本机资料库。','Old tasks are not resent automatically. Any old draft can be saved directly to the phone library.')}</span></> : archived ? <><strong>{t('归档会话（只读）')}</strong><span>{t('可以查看历史内容；新内容请创建会话。','History is available to read. Create a new conversation to continue.')}</span></> : <><strong>{t('模型配置已变化')}</strong><span>{t('为避免在同一会话混用模型版本，请新建会话继续。','Start a new conversation to avoid mixing model versions in one conversation.')}</span><button className="text" onClick={startWithNewModel}>{t('新建会话继续')}</button></>}
    </MessageDialog>}
    {profileIssue && <MessageDialog title={t('服务端人设状态需要处理')} message={profileIssue} onClose={()=>setProfileIssue('')}><div className="profile-actions"><button className="chip" onClick={()=>{setProfileIssue('');onOpenSettings();}}>{t('打开设置')}</button><button className="chip" onClick={()=>{setProfileIssue('');createConversation();}}>{t('新建会话')}</button></div></MessageDialog>}
    {legacy && draft.input && <div className="legacy-rescue"><p>{draft.input}</p><button className="primary" onClick={rescue}>{t('直接记录这份旧草稿')}</button></div>}
    <div className="conversation" role="log" aria-live="polite">
      {!tasks.length && !draft.input && <div className="chat-welcome"><h1>{t('把想法放在这里')}</h1><p className="secondary">{t('和拾文助手讨论日常、整理资料，再把有价值的内容留在资料库。')}</p></div>}
      {nextOffset != null && <button className="text" disabled={loading} onClick={loadOlder}>{t('加载更早的对话')}</button>}
      {tasks.map(task => <article className="turn" key={task.id}>
        <MessageBubble role="user" text={task.input} onDirect={onDirect}/>
        <div className="agent-message"><img className="chat-avatar" src="./shiwen-mark.png" alt=""/>{task.status!=='succeeded'&&<span className="task-status">{t(terminalLabels[task.status] || task.status)}</span>}
          {isRunning(task) && Number.isInteger(task.contextTurns) && <span className="task-context"> · {t(`本轮参考 ${task.contextTurns} 轮对话${task.omittedTurns ? `，另有 ${task.omittedTurns} 轮未纳入` : ''}`,`Context: ${task.contextTurns} conversation turns${task.omittedTurns ? `; ${task.omittedTurns} more omitted` : ''}`)}</span>}
          {task.output && <MessageBubble role="assistant" text={task.output} onDirect={onDirect} embedded/>}{task.error && <button className="text" onClick={()=>setTaskError(task.error)}>{t('查看失败原因','View error')}</button>}
          {task.recordId && <button className="receipt" onClick={() => onRead?.(task.recordId)}>✓ {t('原文已保存为素材 · 查看','Original saved as material · View')}</button>}
          {isRunning(task) && <button className="text" onClick={() => cancel(task)}>{t('取消任务')}</button>}
        </div>
      </article>)}
      {activeId&&!legacy&&<AgentProposals key={activeId} conversationId={activeId} onRead={onRead}/>}
    </div>
    {!archived && (composerOpen ? <div className={`agent-composer${composerExpanded?' is-expanded':''}`}>
      <div className="composer-input-row"><textarea rows={1} aria-label={t('发送消息')} placeholder={config?.configured?t('输入消息…','Message…'):t('请先配置模型','Configure a model first')} value={draft.input} onChange={event => edit({input:event.target.value})} disabled={!ready || loading || sending || conflict} />
      <button className="primary composer-send" onPointerDown={event=>event.preventDefault()} disabled={!ready || loading || sending || !draft.input.trim() || !config?.configured || revisionChanged || conflict} onClick={send}>{t(sending ? '发送中…' : '发送')}</button></div>
      <div className="composer-save-option"><label><input type="checkbox" checked={draft.saveOriginal} onChange={event=>{if(event.target.checked)setChooseSaveKind(true);else edit({saveOriginal:false});}} disabled={!ready||loading||sending||conflict}/>{t('发送时保存全文','Save full text on send')}</label>{draft.saveOriginal&&<button type="button" className="text composer-kind-button" onClick={()=>setChooseSaveKind(true)}>{t(kindLabels[draft.kind]||kindLabels.journal)} ▾</button>}<button type="button" className="text composer-expand-button" onClick={()=>setComposerExpanded(value=>!value)}>{composerExpanded?t('缩小输入框','Shrink input'):t('展开输入框','Expand input')}</button></div>
    </div> : <button type="button" className="composer-fold-button" aria-expanded="false" onClick={toggleComposer}>⌃ {t('展开输入框')}</button>)}
    {chooseSaveKind&&<MessageDialog title={t('选择素材类型','Choose material type')} closeLabel={t('取消','Cancel')} onClose={()=>setChooseSaveKind(false)}><div className="message-kind-options">{Object.entries(kindLabels).map(([key,label])=><button type="button" className="chip" key={key} onClick={()=>{edit({saveOriginal:true,kind:key});setChooseSaveKind(false);}}>{t(label)}</button>)}</div></MessageDialog>}
    {message&&<MessageDialog message={message} onClose={()=>setMessage('')}/>}
    {taskError&&<MessageDialog title={t('任务失败','Task failed')} message={taskError} onClose={()=>setTaskError('')}/>}
    <SessionSheet open={sheetOpen} title={t('会话')} items={sheetItems} activeId={activeId}
      onSelect={selectConversation} onCreate={createConversation} onPrimary={deleteConversation}
      primaryLabel={t('删除')}
      confirmText={item => t(`删除会话“${item.title || '新会话'}”？对话记录和草稿会一并删除，无法恢复。`,
        `Delete “${item.title || 'Untitled'}”? Its turns and draft are removed and cannot be restored.`)}
      onClose={() => setSheetOpen(false)}/>
  </section>;
}
