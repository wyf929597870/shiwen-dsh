import React,{useCallback,useEffect,useRef,useState} from 'react';
import {call} from '../bridge/library.mjs';
import {MarkdownView} from './MarkdownView.jsx';
import {t,useI18n} from './i18n.js';

const labels={
  initialize:['把手机资料库启用到空服务','Initialize an empty server from this phone'],
  'coordinator-recovery':['恢复协调服务','Recover a coordinating server'],
  'device-restore':['核对恢复后的设备','Reconcile a restored device'],
  receiving:['正在传输完整资料','Transferring the complete library'],
  ready:['资料已校验，等待核对','Validated and ready for review'],
  needsReview:['有分支需要核对','Branches need review'],
  aligning:['正在核对本机同步状态','Checking local sync status'],
  'needs-review':['本机同步需要处理','Local sync needs attention'],
  syncing:['同步中','Syncing'],
  completed:['本次对账已结束','Reconciliation finished'],
  failed:['操作未完成','Operation incomplete'],
  conflict:['双方都有修改','Both sides changed'],
  localOnly:['仅手机持有','Only on this phone'],
  remoteOnly:['仅服务端持有','Only on the server'],
  deletedConflict:['删除与编辑冲突','Deletion conflicts with an edit'],
  retained:['已保留为历史分支','Kept as a history branch'],
  merged:['已采用','Applied'],discarded:['未合并，历史保留','Not merged; history kept'],
};
const label=value=>labels[value]?t(...labels[value]):String(value||'—');
const number=value=>Number(value||0).toLocaleString();
const countLabel=(value)=>value==null?t('尚未提供','Not available'):number(value);

/** All recovery actions are fixed native methods. No credentials or arbitrary RPC enter this form. */
export function RecoveryPanel({node,libraryId,onBack,onStateChange}){
  useI18n();
  const [inspection,setInspection]=useState(null),[task,setTask]=useState(null),[progress,setProgress]=useState(null);
  const [candidates,setCandidates]=useState([]),[cursor,setCursor]=useState(null),[selected,setSelected]=useState(null),[branch,setBranch]=useState(null);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState(''),[unknown,setUnknown]=useState(false),[statusRead,setStatusRead]=useState(false);
  const generation=useRef(0);
  useEffect(()=>{onStateChange?.({dirty:false,busy:busy||unknown});},[busy,unknown,onStateChange]);
  useEffect(()=>()=>{generation.current++;onStateChange?.({dirty:false,busy:false});},[onStateChange]);
  const request=useCallback(async(method,args={})=>{
    const ticket=generation.current;
    const value=await call(method,{libraryId,nodeId:node.id,configRevision:node.configRevision,...args});
    if(ticket!==generation.current)throw Error('STALE_CONTEXT');
    return value;
  },[libraryId,node.id,node.configRevision]);
  const inspect=useCallback(async()=>{
    setBusy(true);setError('');
    try{const value=await request('recoveryInspect');setInspection(value);if(value.activeTask)setTask(value.activeTask);setStatusRead(false);return true;}
    catch(e){setError(e.message);return false;}finally{setBusy(false);}
  },[request]);
  useEffect(()=>{inspect();},[inspect]);
  const readProgress=useCallback(async()=>{
    if(!task?.taskId)return;
    const value=await request('recoveryProgress',{taskId:task.taskId});setProgress(value);
    if(value.errorCode)setError(value.errorCode);
    return value;
  },[request,task?.taskId]);
  useEffect(()=>{
    if(!task?.taskId)return;
    let live=true,waiting=false;
    const update=async()=>{if(waiting||!live||document.visibilityState==='hidden')return;waiting=true;try{await readProgress();}catch(e){if(live)setError(e.message);}finally{waiting=false;}};
    const alignmentTerminal=['complete','needs-review','failed'].includes(progress?.localAlignment);
    const taskTerminal=['completed','needsReview','failed','cancelled'].includes(progress?.state);
    if(!alignmentTerminal&&!taskTerminal){update();const interval=setInterval(update,2500);return()=>{live=false;clearInterval(interval);};}
    return()=>{live=false;};
  },[readProgress,task?.taskId,progress?.state,progress?.localAlignment]);
  const loadCandidates=async(reset=true)=>{
    if(!task?.taskId)return;
    const result=await request('recoveryCandidates',{taskId:task.taskId,cursor:reset?undefined:cursor,limit:20});
    setCandidates(old=>reset?result.items:[...old,...result.items]);setCursor(result.nextCursor??null);
  };
  const refreshPending=()=>run(async()=>{if(task?.taskId){const latest=await readProgress();if(latest?.localAlignment!=='needs-review')await loadCandidates(true);}else if(!await inspect())return;setStatusRead(true);});
  const acknowledgeUnknown=()=>{if(!statusRead||!window.confirm(t('我已查看服务状态、进度与分支列表，解除本页写入锁？','I reviewed the server state, progress, and branch list. Unlock writes on this page?')))return;setUnknown(false);setStatusRead(false);};
  const run=async(action)=>{if(busy)return;setBusy(true);setError('');try{await action();}catch(e){setError(e.message);}finally{setBusy(false);}};
  const start=mode=>run(async()=>{
    if(!inspection||unknown||inspection.source?.integrity!=='complete')return;
    if(!window.confirm(t(`将使用当前手机资料库与「${node.name}」执行：${label(mode)}。请确认选中的服务和资料库。`,`Use the current phone library with “${node.name}” to ${label(mode)}? Verify the selected server and library.`)))return;
    setUnknown(true);setStatusRead(false);
    const target=inspection.target||inspection;
    const result=await request('recoveryStart',{mode,expectedTarget:target});setTask(result);setProgress(null);setCandidates([]);setUnknown(false);
  });
  const readBranch=item=>run(async()=>{const value=await request('recoveryBranchRead',{taskId:task.taskId,branchId:item.branchId});setSelected(item);setBranch(value);});
  const decide=resolution=>run(async()=>{
    if(!selected||unknown)return;
    const prompt=resolution==='use-branch'?t('采用此版本会创建新的当前版本，并保留双方历史。确认采用？','Apply this branch as a new current version, retaining both histories?'):t('此操作保留原分支历史，不把它覆盖到当前正文。确认？','Keep the branch history without replacing the current content?');
    if(!window.confirm(prompt))return;
    setUnknown(true);setStatusRead(false);
    const result=await request('recoveryDecide',{taskId:task.taskId,branchId:selected.branchId,resolution,expectedTargetHead:selected.targetHead??null});
    setUnknown(false);setMessage(label(result.state));setBranch(null);setSelected(null);
    await Promise.all([readProgress(),loadCandidates(true)]);
  });
  const finish=()=>run(async()=>{
    if(unknown||!window.confirm(t('完成本次对账？保留但未采用的历史分支仍会单独列出。','Finish reconciliation? History branches that were not applied remain separate.')))return;
    setUnknown(true);setStatusRead(false);const result=await request('recoveryComplete',{taskId:task.taskId});setProgress(result);setUnknown(false);
    setMessage(t('对账已完成。请回到资料与同步执行一次正常同步，核对各端副本。','Reconciliation finished. Run normal sync to verify each replica.'));
  });
  const source=inspection?.source,target=inspection?.target||inspection;
  const received=progress?.receivedCounts||{},expected=progress?.expectedCounts||{},resolved=progress?.resolvedCounts||{};
  const localNeedsReview=progress?.localAlignment==='needs-review';
  return <section className="settings-page recovery-page">
    <button className="text" disabled={busy||unknown} onClick={onBack}>‹ {t('返回设置','Back to Settings')}</button>
    <h1>{t('初始化与恢复','Initialize and recover')}</h1><p className="secondary">{node.name} · {node.baseUrl}</p>
    <p>{t('普通同步无需进入这里。用于手机先建库、协调服务恢复，以及从备份换机后的版本核对。','Normal sync does not need this page. Use it for a phone-first library, server recovery, or reconciliation after restoring a device.')}</p>
    <button className="chip" disabled={busy} onClick={inspect}>{t('重新核对服务和资料库','Verify server and library')}</button>
    {source&&<section className="settings-card"><h2>{t('当前手机副本','Current phone replica')}</h2><dl className="settings-details"><div><dt>{t('资料库编号','Library ID')}</dt><dd>{source.libraryId}</dd></div><div><dt>{t('完整性','Completeness')}</dt><dd>{source.integrity==='complete'?t('完整且已校验','Complete and verified'):t('不完整，不能恢复服务','Incomplete; cannot restore a server')}</dd></div><div><dt>{t('记录 / 历史 / 附件','Records / history / attachments')}</dt><dd>{number(source.counts?.records)} / {number(source.counts?.versions)} / {number(source.counts?.attachments)}</dd></div></dl>{source.missingAttachments>0&&<p className="error">{t('缺少附件','Missing attachments')}：{source.missingAttachments}</p>}</section>}
    {target&&<section className="settings-card"><h2>{t('目标服务','Target server')}</h2><dl className="settings-details"><div><dt>{t('资料库编号','Library ID')}</dt><dd>{target.libraryId}</dd></div><div><dt>{t('服务编号','Server ID')}</dt><dd>{target.serverId}</dd></div><div><dt>{t('记录数量','Records')}</dt><dd>{number(target.recordCount)} · {target.isEmpty?t('空服务','Empty server'):t('已有资料','Contains data')}</dd></div></dl>
      {!task&&(inspection?.allowedModes||[]).map(mode=><button key={mode} className="chip" disabled={busy||unknown||source?.integrity!=='complete'} onClick={()=>start(mode)}>{label(mode)}</button>)}
      {!task&&!inspection?.allowedModes?.length&&<p className="secondary">{t('此服务与当前副本不满足初始化或恢复条件。','This server and replica are not eligible for initialization or recovery.')}</p>}
    </section>}
    {task&&<section className="settings-card"><h2>{localNeedsReview?label('needs-review'):label(progress?.state||task.state)}</h2><p className="secondary">{label(task.mode)}</p>
      {progress?.localAlignment&&<div className={localNeedsReview?'notice':'sync-progress'} role={localNeedsReview?'status':undefined}>
        <strong>{t('本机资料库同步对齐','Local library sync alignment')}：{label(progress.localAlignment)}</strong>
        {progress.localAlignment==='complete'&&<p>{t('本机对齐已完成。','Local alignment is complete.')}</p>}
        {localNeedsReview&&<>
          <p>{t('恢复对账已经结束，但本机仍有同步事项需要处理；这不代表资料库已完全同步。','Recovery reconciliation has ended, but local sync items still need attention. This does not mean the library is fully synced.')}</p>
          <p>{t('待同步操作','Pending operations')}：{countLabel(progress.pendingOperationCount)} · {t('冲突','Conflicts')}：{countLabel(progress.conflictCount)}</p>
          {progress.localSync?.state&&<p>{t('最近同步任务状态','Latest sync task')}: {label(progress.localSync.state)}{progress.localSync.error?` · ${progress.localSync.error}`:''}</p>}
          {progress.localAlignmentError&&<p className="secondary">{label(progress.localAlignmentError)}</p>}
          <p>{t('返回设置中的“手机资料库与同步”，查看待同步修改、拒绝写入和冲突；需要时再手动同步或处理冲突。','Return to “Phone libraries and sync” in Settings to review pending changes, rejected writes, and conflicts. Sync or resolve conflicts there as needed.')}</p>
          <button className="chip" disabled={busy||unknown} onClick={onBack}>{t('返回设置查看同步状态','Back to Settings sync status')}</button>
        </>}
        {progress.localAlignment==='failed'&&progress.localAlignmentError&&<p className="error">{label(progress.localAlignmentError)}</p>}
      </div>}
      {Object.entries(expected).map(([name,total])=>{const count=Number(received[name]||0);return <div className="management-row" key={name}><span>{t(({records:'正文',heads:'当前版本',versions:'版本历史',activities:'编辑活动',links:'资料关联',attachments:'附件',provenance:'来源',branches:'历史分支',operations:'待同步操作'})[name]||name,name)}</span><span>{number(count)} / {number(total)}{count>=Number(total)?' ✓':''}</span></div>;})}
      {progress?.missingEntities?.length>0&&<p className="error">{t('仍缺少部分资料实体','Some library entities are still missing')}：{progress.missingEntities.map(item=>`${label(item.entity)} ${number(item.received)}/${number(item.expected)}`).join(' · ')}</p>}
      {progress?.missingAttachmentIds?.length>0&&<p className="error">{t('缺少附件','Missing attachments')}：{progress.missingAttachmentIds.length}</p>}
      {progress?.attachments&&<p className="secondary">{t('附件传输','Attachment transfer')}：{number(progress.attachments.receivedBytes)} / {number(progress.attachments.totalBytes)} B</p>}
      <p>{t('需要核对的分支','Branches to review')}：{number(progress?.candidateCount)}</p>
      <p className="secondary">{t('已解决','Resolved')}：{number(progress?.resolvedCount)}</p>
      <p className="secondary">{t('保留历史 / 采用 / 不合并','Kept / applied / not merged')}：{number(resolved.retained)} / {number(resolved.merged)} / {number(resolved.discarded)}</p>
      {(resolved.retained>0||resolved.discarded>0)&&<p className="notice">{t('仍有单独保留的历史分支。对账结束不代表这些分支已成为各端当前正文。','Separate history branches remain. Completing reconciliation does not make them the current content on every device.')}</p>}
      <div className="node-actions"><button className="chip" disabled={busy} onClick={refreshPending}>{t('刷新进度与分支','Refresh progress and branches')}</button>{unknown&&statusRead&&<button className="chip" disabled={busy} onClick={acknowledgeUnknown}>{t('我已核对，解除写入锁','I reviewed it; unlock writes')}</button>}{!localNeedsReview&&['ready','needsReview'].includes(progress?.state)&&<button className="primary" disabled={busy||unknown} onClick={finish}>{t('完成对账','Finish reconciliation')}</button>}</div>
    </section>}
    {candidates.map(item=><button className="management-row" key={item.branchId} disabled={busy} onClick={()=>readBranch(item)}><strong>{item.title||item.recordId}</strong><span>{label(item.classification)} · {item.sourceHead?.revision!=null?`${t('来源版本','Source revision')} ${item.sourceHead.revision}`:''}</span></button>)}
    {cursor&&<button className="chip" disabled={busy} onClick={()=>run(()=>loadCandidates(false))}>{t('加载更多','Load more')}</button>}
    {branch&&<section className="settings-card"><div className="settings-heading"><h2>{branch.record?.title}</h2><button className="text" disabled={busy} onClick={()=>{setSelected(null);setBranch(null);}}>{t('关闭','Close')}</button></div><p className="secondary">{branch.record?.contentDay} · {t('历史版本','Historical versions')} {branch.versions?.length||0} · {t('编辑活动','Edit activities')} {branch.activities?.length||0} · {t('附件','Attachments')} {branch.attachments?.length||0}</p><MarkdownView markdown={branch.record?.markdown||''}/>
      <div className="node-actions"><button className="primary" disabled={busy||unknown} onClick={()=>decide('use-branch')}>{t('采用这个版本','Apply this version')}</button><button className="chip" disabled={busy||unknown} onClick={()=>decide('retain-branch')}>{t('保留为历史分支','Keep as history')}</button><button className="text" disabled={busy||unknown} onClick={()=>decide('discard')}>{t('不合并，保留历史','Do not merge; keep history')}</button></div>
    </section>}
    {unknown&&<p className="notice">{t('操作结果待核对。请刷新原任务状态，不要重复提交。','The result needs verification. Refresh the existing task instead of submitting again.')}</p>}
    {message&&<p role="status">{message}</p>}{error&&<p className="error" role="alert">{error}</p>}
  </section>;
}
