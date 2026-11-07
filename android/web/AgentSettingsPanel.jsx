import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {call} from '../bridge/library.mjs';
import {getLanguage} from './i18n.js';

const tx=(chinese,english)=>getLanguage()==='en'?english:chinese;
const categories = {user:['用户信息','User information'], memory:['长期记忆','Long-term memory']};
const categoryLabel=value=>categories[value]?.[getLanguage()==='en'?1:0]||value;
const isConflict = error => /REVISION|CONFLICT|VERSION|记忆已变更|配置已变更|版本冲突|请刷新/i.test(String(error?.message || error));
export function AgentSettingsPanel({node, onBack, onStateChange}) {
  const [profile, setProfile] = useState(null), [identity, setIdentity] = useState(''), [soul, setSoul] = useState('');
  const [memoryBodies, setMemoryBodies] = useState({}), [newBody, setNewBody] = useState(''), [newCategory, setNewCategory] = useState('memory');
  const [loading, setLoading] = useState(false), [busy, setBusy] = useState(false), [stale, setStale] = useState(false);
  const [conflict, setConflict] = useState(false), [writeUnknown, setWriteUnknown] = useState(false), [feedback, setFeedback] = useState(null);
  const message=feedback?.text||'';
  const setMessage=(value,kind='error')=>setFeedback(value?{kind,text:value}:null);
  const identityDirty = Boolean(profile && identity !== (profile.identity?.body || ''));
  const soulDirty = Boolean(profile && soul !== (profile.soul?.body || ''));
  const memoryDirty = useMemo(() => Boolean(profile?.memories?.some(item => memoryBodies[item.id] != null && memoryBodies[item.id] !== item.body)), [profile, memoryBodies]);
  const anyDirty = identityDirty || soulDirty || memoryDirty || Boolean(newBody.trim());

  useEffect(() => { onStateChange?.({dirty:anyDirty, busy}); }, [anyDirty, busy, onStateChange]);

  const applySnapshot = useCallback((snapshot, overwrite) => {
    setProfile(snapshot);
    setIdentity(current => overwrite || !identityDirty ? (snapshot.identity?.body || '') : current);
    setSoul(current => overwrite || !soulDirty ? (snapshot.soul?.body || '') : current);
    setMemoryBodies(current => {
      if (overwrite) return Object.fromEntries((snapshot.memories || []).map(item => [item.id, item.body]));
      const next = {...current};
      for (const item of snapshot.memories || []) {
        const wasDirty = profile?.memories?.some(old => old.id === item.id && next[item.id] != null && next[item.id] !== old.body);
        if (!wasDirty) next[item.id] = item.body;
      }
      for (const id of Object.keys(next)) if (!(snapshot.memories || []).some(item => item.id === id)) delete next[id];
      return next;
    });
    setStale(false); setConflict(false);
  }, [identityDirty, soulDirty, profile]);

  const load = useCallback(async ({overwrite = false, checkConnection = false} = {}) => {
    if (!node?.id) { setProfile(null); setMessage(tx('没有绑定服务节点。请返回设置，选择一个节点后再管理 Agent 与记忆。','No server is selected. Return to Settings and choose one before managing the agent and memories.')); return; }
    if (overwrite && anyDirty && !window.confirm(tx('刷新会覆盖尚未保存的身份、人设或记忆编辑。请先复制需要保留的文字。确定继续刷新吗？','Refreshing will replace unsaved identity, persona, or memory edits. Copy anything you need first. Continue?'))) return;
    setLoading(true); setMessage('');
    try {
      let connectionMessage = '';
      if (checkConnection) {
        try { await call('nodeCheck', {id:node.id}); }
        catch (error) { connectionMessage = `${tx('连接检查未完成：','Connection check did not finish: ')}${error.message}. `; }
      }
      const snapshot = await call('nodeAgentState', {id:node.id});
      applySnapshot(snapshot, overwrite);
      if (overwrite) setNewBody('');
      if (connectionMessage) setMessage(`${connectionMessage}${tx('已读取该服务节点当前可用的人设状态。','The available agent profile from this server was loaded.')}`,'warning');
    } catch (error) {
      setStale(true);
      setMessage(`${tx(`无法读取「${node.name}」的人设快照：`,`Could not read the agent profile from “${node.name}”: `)}${error.message}${tx('。未显示虚构内容；可检查节点登录状态后重试。','. No placeholder profile was shown. Check the server sign-in and try again.')}`);
    } finally { setLoading(false); }
  }, [node, anyDirty, applySnapshot]);

  useEffect(() => { load(); }, [node?.id]);

  const runWrite = async (operation, successText) => {
    if (!node?.id || busy || writeUnknown || conflict) return null;
    setBusy(true); setMessage(''); setConflict(false);
    try {
      const result = await operation();
      if (!result?.saved) throw Error(tx('服务没有确认保存结果','The server did not confirm the save.'));
      if(result.nodeChanged){
        setStale(true);
        setMessage(tx('写入已在原服务节点确认，但当前节点配置已变化。请重新读取当前节点状态；不要再次提交这次写入。','The write was confirmed on the previous server node, but the current node configuration changed. Reload the current node state; do not submit this write again.'),'warning');
        return null;
      }
      if (result.profileSynced === false) setMessage(tx('服务已保存，人设同步待重试。不要重复提交。','Saved on the server; profile sync will retry. Do not submit again.'),'warning');
      else setMessage(successText || tx('已保存并同步人设。','Saved and synced to the agent profile.'),'success');
      return result;
    } catch (error) {
      if (String(error?.message || error).includes('NODE_WRITE_RESULT_UNKNOWN')) {
        setWriteUnknown(true); setStale(true);
        setMessage(tx('保存结果待核对，输入内容仍保留。请先检查节点快照，不要重复提交。','Save result needs verification. Your edits are preserved. Check the server snapshot before submitting again.'));
      } else if (isConflict(error)) {
        setConflict(true);
        setMessage(`${tx('版本冲突，当前编辑内容仍保留。','Version conflict. Your edits are preserved. ')}${error.message}${tx('。请先复制需要保留的文字，再通过“检查并更新”明确替换。','. Copy anything you need, then use “Check and refresh” to explicitly replace the snapshot.')}`);
      } else setMessage(`${tx('保存失败，编辑内容仍保留：','Save failed; your edits are preserved: ')}${error.message}`);
      return null;
    } finally { setBusy(false); }
  };
  const saveDocument = async (name, body, current) => {
    if (!body.trim()) { setMessage(tx('内容不能为空。','Content cannot be empty.')); return; }
    const result = await runWrite(() => call('nodeAgentDocumentSave', {id:node.id, name, body, revision:current?.revision ?? 0}), tx('已保存并同步人设。','Saved and synced to the agent profile.'));
    if (result?.saved) {
      const item = result.item && 'name' in result.item ? result.item : null;
      if (!item || typeof item.body !== 'string' || !Number.isInteger(item.revision)) {
        setStale(true);
        if (result.profileSynced !== false) setMessage(tx('服务已保存，但版本信息未返回。当前编辑仍保留，请检查并更新后继续，不要重复提交。','Saved on the server, but no revision was returned. Your edits are preserved. Check and refresh before continuing; do not submit again.'));
        return;
      }
      if (name === 'IDENTITY.md') setIdentity(item.body);
      else setSoul(item.body);
      setProfile(currentProfile => currentProfile && ({...currentProfile, [name === 'IDENTITY.md' ? 'identity' : 'soul']:{body:item.body, revision:item.revision}}));
    }
  };
  const saveMemory = async (memory, body, category) => {
    if (!body.trim()) { setMessage(tx('记忆内容不能为空。','Memory content cannot be empty.')); return; }
    const result = await runWrite(() => call('nodeMemorySave', {id:node.id, ...(memory?.id ? {memoryId:memory.id} : {}), body, category, ...(memory?.revision ? {revision:memory.revision} : {})}), tx('记忆已保存并同步。','Memory saved and synced.'));
    if (result?.saved) {
      if (memory?.id) {
        const savedMemory = result.item && 'id' in result.item ? result.item : null;
        if (!savedMemory || typeof savedMemory.body !== 'string' || !Number.isInteger(savedMemory.revision)) {
          setStale(true);
          if (result.profileSynced !== false) setMessage(tx('服务已保存，但记忆版本信息未返回。当前编辑仍保留，请检查并更新后继续，不要重复提交。','Saved on the server, but no memory revision was returned. Your edits are preserved. Check and refresh before continuing; do not submit again.'));
        } else {
          setProfile(current => current && ({...current, memories:current.memories.map(item => item.id === memory.id ? {...item, ...savedMemory} : item)}));
          setMemoryBodies(current => ({...current, [memory.id]:savedMemory.body}));
        }
      }
      else {
        const savedMemory = result.item && 'id' in result.item ? result.item : null;
        if (!savedMemory || typeof savedMemory.body !== 'string' || !Number.isInteger(savedMemory.revision)) {
          setStale(true);
          if (result.profileSynced !== false) setMessage(tx('服务已保存，但记忆版本信息未返回。当前编辑仍保留，请检查并更新后继续，不要重复提交。','Saved on the server, but no memory revision was returned. Your edits are preserved. Check and refresh before continuing; do not submit again.'));
        } else {
          setProfile(current => current && ({...current, memories:[...current.memories.filter(item => item.id !== savedMemory.id), {...savedMemory, category:savedMemory.category || category, status:savedMemory.status || 'active'}]}));
          setNewBody('');
        }
      }
    }
  };
  const decideMemory = async (memory, accept) => {
    const result = await runWrite(
      () => call('nodeMemoryDecide', {id:node.id, memoryId:memory.id, revision:memory.revision, accept}),
      accept ? tx('候选记忆已确认。','Memory candidate accepted.') : tx('候选记忆已拒绝。','Memory candidate rejected.')
    );
    if (result?.saved) {
      const item = result.item && 'id' in result.item ? result.item : null;
      if (accept && (!item || !Number.isInteger(item.revision))) setStale(true);
      if (item) setProfile(current => current && ({...current, memories:accept
        ? current.memories.map(row => row.id === memory.id ? {...row, ...item, status:item.status || 'active'} : row)
        : current.memories.filter(row => row.id !== memory.id)}));
      else setMessage(result.profileSynced === false ? tx('服务已保存，人设同步待重试。不要重复提交。','Saved on the server; profile sync will retry. Do not submit again.') : tx('服务已保存，但候选状态未返回。请检查并更新后确认结果，不要重复操作。','Saved on the server, but the candidate status was not returned. Check and refresh before continuing; do not repeat the operation.'));
    }
  };
  const deleteMemory = memory => {
    if (!window.confirm(tx(`确定删除这条${categoryLabel(memory.category)}？删除会同步到「${node.name}」，无法撤销。`,`Delete this ${categoryLabel(memory.category)}? The deletion will sync to “${node.name}” and cannot be undone.`))) return;
    runWrite(() => call('nodeMemoryDelete', {id:node.id, memoryId:memory.id, revision:memory.revision}), tx('记忆已删除并同步。','Memory deleted and synced.')).then(result => {
      if (result?.saved) setProfile(current => current && ({...current, memories:current.memories.filter(item => item.id !== memory.id)}));
    });
  };
  const acknowledgeWriteCheck = () => {
    setWriteUnknown(false); setMessage(tx('快照已核对。当前编辑仍保留，可以继续修改后提交。','Snapshot checked. Your edits are preserved and can be submitted.'),'success');
  };
  const back = () => {
    if (busy) { setMessage(tx('正在保存，请等待写入确认后再离开。','A save is in progress. Wait for confirmation before leaving.')); return; }
    if (anyDirty && !window.confirm(tx('返回将丢弃未保存编辑。请先保存或复制需要保留的文字。确定返回设置吗？','Returning will discard unsaved edits. Save or copy anything you need first. Return to Settings?'))) return;
    onStateChange?.({dirty:false,busy:false}); onBack?.();
  };

  if (!node?.id) return <section className="agent-settings-page">
    <button className="text" onClick={back}>‹ {tx('返回设置','Back to Settings')}</button><h1>{tx('Agent 与记忆','Agent and memory')}</h1>
    <p className="empty-state">{tx('请先在设置中选择服务节点，再管理该节点的 Agent 身份、人设与全局记忆。','Select a server in Settings before managing its agent identity, persona, and global memories.')}</p>
  </section>;

  const activeMemories = (profile?.memories || []).filter(item => item.status === 'active');
  const candidates = (profile?.memories || []).filter(item => item.status === 'pending');
  return <section className="agent-settings-page" aria-label={tx('Agent 与记忆','Agent and memory')}>
    <button className="text" onClick={back}>‹ {tx('返回设置','Back to Settings')}</button>
    <h1>{tx('Agent 与记忆','Agent and memory')}</h1>
    <p className="secondary"><strong>{node.name} · {tx('拾文助手','Shiwen agent')}</strong><br/>{tx('仅管理此节点上的拾文助手 IDENTITY.md、SOUL.md 与全局记忆；其他 DSH Agent 预设属于独立管理范围。','Manage this node’s Shiwen agent IDENTITY.md, SOUL.md, and global memories. Other DSH agent presets are managed separately.')}</p>
    <div className="agent-profile-toolbar"><span className={`state-pill ${stale ? '' : 'is-ready'}`}>{stale ? tx('状态待核对','Status needs review') : profile ? tx('服务端 Agent 状态','Server agent state') : tx('读取中','Loading')}</span><button className="chip" disabled={loading || busy} onClick={() => load({overwrite:true,checkConnection:true})}>{tx('检查并更新','Check and refresh')}</button></div>
    {writeUnknown && !stale && <div className="conflict-callout" role="alert">{tx('保存结果待核对。请检查当前快照并确认后再发起新的写入。','The save result needs verification. Review the current snapshot before another write.')}<button className="text" onClick={acknowledgeWriteCheck}>{tx('我已核对，继续编辑','I checked; continue editing')}</button></div>}
    <p className="snapshot-note">{tx('当前页面读取并编辑服务节点上的拾文助手状态；此状态与手机本地资料库分开。','This page reads and edits the Shiwen agent on the server. It is separate from the phone’s local library.')}</p>
    {conflict && <p className="conflict-callout" role="alert">{tx('版本冲突：你输入的内容仍保留。重新读取会覆盖未保存编辑，请复制后再继续。','Version conflict: your input is preserved. Reloading will overwrite unsaved edits; copy anything you need first.')}</p>}
    {profile && <>
      <section className="settings-card" aria-labelledby="identity-title">
        <div className="settings-heading"><div><h2 id="identity-title">{tx('拾文助手身份','Agent identity')}</h2><p className="secondary">IDENTITY.md · {tx('此节点的拾文助手身份描述','Identity description for this server agent')}</p></div><span className="state-pill">{identityDirty ? tx('有未保存更改','Unsaved changes') : tx('已保存','Saved')}</span></div>
        <textarea className="agent-document-editor" aria-label={tx('身份内容','Identity content')} value={identity} onChange={event => setIdentity(event.target.value)} disabled={busy || stale} placeholder={tx('描述 Agent 的身份…','Describe the agent identity…')} />
        <button className="primary" disabled={busy || stale || writeUnknown || conflict || !identityDirty} onClick={() => saveDocument('IDENTITY.md', identity, profile.identity)}>{tx('保存身份','Save identity')}</button>
      </section>
      <section className="settings-card" aria-labelledby="soul-title">
        <div className="settings-heading"><div><h2 id="soul-title">SOUL</h2><p className="secondary">SOUL.md · {tx('拾文助手的性格、表达方式与行为原则','The agent’s personality, communication style, and principles')}</p></div><span className="state-pill">{soulDirty ? tx('有未保存更改','Unsaved changes') : tx('已保存','Saved')}</span></div>
        <textarea className="agent-document-editor" aria-label={tx('SOUL 内容','SOUL content')} value={soul} onChange={event => setSoul(event.target.value)} disabled={busy || stale} placeholder={tx('描述 Agent 的性格和行为原则…','Describe the agent’s personality and principles…')} />
        <button className="primary" disabled={busy || stale || writeUnknown || conflict || !soulDirty} onClick={() => saveDocument('SOUL.md', soul, profile.soul)}>{tx('保存 SOUL','Save SOUL')}</button>
      </section>
      <section className="settings-card" aria-labelledby="memory-title">
        <div className="settings-heading"><div><h2 id="memory-title">{tx('已确认记忆','Confirmed memories')}</h2><p className="secondary">{activeMemories.length} {tx('条全局记忆','global memories')}</p></div></div>
        {!activeMemories.length && <p className="empty-state">{tx('此节点目前没有已确认的全局记忆。','This server has no confirmed global memories yet.')}</p>}
        <div className="agent-memory-list">{activeMemories.map(memory => <article className="agent-memory" key={memory.id}>
          <div className="memory-meta"><span>{categoryLabel(memory.category)}</span>{memory.updated && <time>{memory.updated}</time>}</div>
          <textarea aria-label={tx(`编辑记忆 ${memory.id}`,`Edit memory ${memory.id}`)} value={memoryBodies[memory.id] ?? memory.body} onChange={event => setMemoryBodies(current => ({...current, [memory.id]:event.target.value}))} disabled={busy || stale}/>
          {memory.evidence && <p className="memory-evidence">{tx('依据：','Evidence: ')}{memory.evidence}</p>}
          <div className="node-actions"><button className="chip" disabled={busy || stale || writeUnknown || conflict || ((memoryBodies[memory.id] ?? memory.body) === memory.body)} onClick={() => saveMemory(memory, memoryBodies[memory.id] ?? memory.body, memory.category)}>{tx('保存修改','Save changes')}</button><button className="text" disabled={busy || stale || writeUnknown || conflict} onClick={() => deleteMemory(memory)}>{tx('删除','Delete')}</button></div>
        </article>)}</div>
      </section>
      <section className="settings-card" aria-labelledby="candidate-title">
        <div className="settings-heading"><div><h2 id="candidate-title">{tx('待确认记忆','Memories to review')}</h2><p className="secondary">{tx('确认后会加入全局记忆；拒绝后从候选列表移除。','Accepted items join global memory. Rejected items are removed from this list.')}</p></div><span className="state-pill">{candidates.length} {tx('条','items')}</span></div>
        {!candidates.length && <p className="empty-state">{tx('没有待确认的候选记忆。','No candidate memories to review.')}</p>}
        {candidates.map(memory => <article className="agent-memory pending-memory" key={memory.id}>
          <div className="memory-meta"><span>{categoryLabel(memory.category)} · {tx('待确认','Pending')}</span>{memory.updated && <time>{memory.updated}</time>}</div>
          <p>{memory.body}</p>{memory.evidence && <p className="memory-evidence">{tx('依据：','Evidence: ')}{memory.evidence}</p>}
          <div className="node-actions"><button className="primary" disabled={busy || stale || writeUnknown || conflict} onClick={() => decideMemory(memory, true)}>{tx('确认记忆','Accept memory')}</button><button className="chip" disabled={busy || stale || writeUnknown || conflict} onClick={() => decideMemory(memory, false)}>{tx('拒绝候选','Reject candidate')}</button></div>
        </article>)}
      </section>
      <section className="settings-card" aria-labelledby="new-memory-title">
        <h2 id="new-memory-title">{tx('添加全局记忆','Add a global memory')}</h2>
        <p className="secondary">{tx(`记忆绑定到「${node.name}」节点，不会写入手机本地资料库。`,`This memory belongs to server “${node.name}”; it will not be written to the phone library.`)}</p>
        <textarea className="agent-document-editor" aria-label={tx('新记忆内容','New memory content')} value={newBody} onChange={event => setNewBody(event.target.value)} disabled={busy || stale} placeholder={tx('写入一条已确认的长期信息…','Add a confirmed long-term memory…')} />
        <div className="node-actions"><select aria-label={tx('新记忆类别','New memory category')} value={newCategory} onChange={event => setNewCategory(event.target.value)} disabled={busy || stale}><option value="user">{categoryLabel('user')}</option><option value="memory">{categoryLabel('memory')}</option></select><button className="primary" disabled={busy || stale || writeUnknown || conflict || !newBody.trim()} onClick={() => saveMemory(null, newBody, newCategory)}>{tx('添加记忆','Add memory')}</button></div>
      </section>
    </>}
    {loading && !profile && <p className="secondary">{tx('正在读取所选服务节点上的拾文助手状态…','Loading the Shiwen agent state from the selected server…')}</p>}
    {feedback && <p className={feedback.kind==='error'?'error':feedback.kind==='warning'?'notice':'success-note'} role={feedback.kind==='error'?'alert':'status'}>{message}</p>}
    {anyDirty && <p className="draft-preserved">{tx('当前页面有未保存输入；切换前请先保存或复制。','There are unsaved edits. Save or copy them before leaving.')}</p>}
  </section>;
}
