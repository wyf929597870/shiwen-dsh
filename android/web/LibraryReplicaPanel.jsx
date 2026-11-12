import {MessageDialog} from './MessageDialog.jsx';
import React,{useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {call} from '../bridge/library.mjs';
import {MarkdownView} from './MarkdownView.jsx';
import {useI18n} from './i18n.js';
import {syncCompletionMessage} from './sync-summary.mjs';
import {conflictTextDiff} from './conflict-diff.mjs';
import './record.css';

const displayDate=value=>{if(!value||value==='null')return '';const date=new Date(value);return Number.isNaN(date.getTime())?value:date.toLocaleString();};
const phaseText=(value,t)=>({identity:t('核对服务身份','Checking server identity'),bootstrap:t('读取资料库','Reading library'),push:t('上传本机更改','Uploading local changes'),receipts:t('核对写入回执','Checking write receipts'),pull:t('接收更新','Receiving updates'),attachments:t('传输附件','Transferring attachments'),ack:t('确认同步进度','Confirming sync progress'),finalize:t('完成收尾','Finalizing')}[value]||value||t('同步','Sync'));
const terminal=new Set(['completed','failed','cancelled']);
const syncErrorText=(value,t)=>{const code=String(value||'');if(code==='SYNC_PARENT_VERSION_MISSING')return t('这条修改缺少原版本信息，尚未上传。手机内容已保留，需要修复版本关联。','A change is missing its base version and has not been uploaded. Phone content is preserved; its version link needs repair.');if(code==='SYNC_PARENT_NOT_CONFIRMED')return t('仍有修改等待前置版本确认，本轮同步未全部完成。请检查待处理冲突或稍后重试。','Some changes are waiting for their parent version. Sync is incomplete; review conflicts or retry later.');if(/IOException|Socket|NODE_OFFLINE|ConnectException|UnknownHost/.test(code))return t('无法连接服务节点，请检查电脑是否在线。待同步内容已保留，连接恢复后可重试。','Cannot reach the server. Pending changes are kept; retry after reconnecting.');if(/IDENTITY_MISMATCH/.test(code))return t('服务身份不匹配，已停止同步。','Server identity mismatch. Sync stopped.');return code;};
const statusText=(value,t)=>{const labels={standalone:['仅本机','On phone'],coordinated:['已连接服务','Connected to server'],initializing:['初次同步中','Initial sync'],idle:['已连接','Connected'],syncing:['同步中','Syncing'],incomplete:['资料不完整','Incomplete'],conflicted:['有待处理冲突','Conflicts need attention'],attention:['需要处理','Needs attention'],error:['同步异常','Sync error'],queued:['等待开始','Queued'],running:['进行中','In progress'],completed:['完成','Complete'],failed:['失败','Failed'],cancelled:['已取消','Cancelled'],complete:['完整','Complete'],paused:['已暂停','Paused'],'rebind-required':['需要重新绑定','Rebind required']};return labels[value]?t(...labels[value]):value||t('状态未知','Unknown state');};
const safeError=(e,t)=>({CONFLICT_HEAD_CHANGED:t('版本已变化，请读取最新版本后重新对比。','A version changed. Load the latest version and compare again.'),SYNC_REMOTE_HEAD_MISSING:t('手机尚未取得可核对的服务端版本，请先手动同步。','The phone has no verifiable server version. Sync first.'),SYNC_REMOTE_RECORD_INVALID:t('服务端版本信息不完整，未修改资料，请同步后重试。','The server version is incomplete. Nothing was changed; sync and try again.'),NODE_MANAGEMENT_API_UNSUPPORTED:t('此服务器需要更新拾文插件。','Update the Shiwen plugin on this server.'),NODE_AUTH_REQUIRED:t('服务登录已失效，请返回设置重新登录。','Server sign-in expired. Sign in again in Settings.'),AUTH_REQUIRED:t('请重新登录此服务。','Sign in to this server again.'),NODE_CHANGED:t('服务配置已变更，请重新读取。','Server settings changed. Reload and try again.')}[e?.code||e?.message]||e?.message||t('操作失败','Operation failed'));
const EMPTY_IMAGE_DESCRIPTORS=Object.freeze([]);
const imageDescriptors=record=>record?.attachmentDescriptors||record?.attachments||EMPTY_IMAGE_DESCRIPTORS;

export function LibraryReplicaPanel({ready,libraryId,libraryContext,nodes,onLibraryChange,onPageStateChange=()=>{}}){
  const {t}=useI18n();
  const label=value=>statusText(value,t);
  const [registry,setRegistry]=useState([]),[status,setStatus]=useState(null),[prefs,setPrefs]=useState(null),[name,setName]=useState(''),[creating,setCreating]=useState(false),[operation,setOperation]=useState(null),[progress,setProgress]=useState(null),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[error,setError]=useState('');
  const [showDownload,setShowDownload]=useState(false),[conflicts,setConflicts]=useState([]),[selectedConflict,setSelectedConflict]=useState(null),[conflictCursor,setConflictCursor]=useState(null),[mergeMode,setMergeMode]=useState(false),[mergeBody,setMergeBody]=useState(''),[showFull,setShowFull]=useState(false),[conflictsLoaded,setConflictsLoaded]=useState(false);
  const pollTimer=useRef(null),generation=useRef(0);
  const pendingResolution=useRef(null);
  if(pendingResolution.current===null){try{pendingResolution.current=JSON.parse(sessionStorage.getItem('shiwen-conflict-pending')||'null');}catch{pendingResolution.current=null;}}
  useEffect(()=>onPageStateChange({dirty:creating&&Boolean(name.trim()),busy:busy||Boolean(operation)}),[creating,name,busy,operation,onPageStateChange]);
  const refresh=useCallback(async()=>{
    const gen=++generation.current;setError('');
    try{const list=await call('libraryList');if(gen!==generation.current)return;setRegistry(list.items||[]);
      const [nextStatus,nextPrefs]=await Promise.all([call('syncStatus',{libraryId}),call('librarySettingsGet',{libraryId})]);
      if(gen!==generation.current)return;setStatus(nextStatus);setPrefs(nextPrefs);
    }catch(e){if(gen===generation.current)setError(safeError(e,t));}
  },[libraryId]);
  useEffect(()=>{refresh();return()=>{generation.current++;clearTimeout(pollTimer.current);};},[refresh]);
  const refreshConflicts=async(reset=true)=>{
    try{const page=await call('syncConflicts',{libraryId,cursor:reset?undefined:conflictCursor,limit:20});setConflicts(old=>reset?page.items:[...old,...page.items]);setConflictCursor(page.nextCursor??null);setConflictsLoaded(true);}
    catch(e){setError(safeError(e,t));}
  };
  useEffect(()=>{if(ready&&libraryId)void refreshConflicts(true);},[ready,libraryId]);
  const poll=async(library,opId)=>{
    try{
      const next=await call('syncProgress',{boundLibraryId:libraryId,pageGeneration:libraryContext?.pageGeneration,targetLibraryId:library,operationId:opId});setProgress(next);
      if(terminal.has(next.state)){
        setOperation(null);await refresh();await refreshConflicts(true);
        if(next.state==='completed'&&library!==libraryId){
          const context=await call('librarySelect',{libraryId:library});await onLibraryChange?.(context);
        }
        if(next.state==='completed'){
          try{const status=await call('syncStatus',{libraryId:library});setMessage(syncCompletionMessage(status,t));setError('');}
          catch{setMessage(t('本轮同步操作结束，但无法读取资料库状态。请返回设置核对同步状态。','This sync operation ended, but its library status could not be read. Check the sync status in Settings.'));setError('');}
        }else setMessage(`${t('同步','Sync')} ${label(next.state)}：${syncErrorText(next.error,t)}`);
        return;
      }
      pollTimer.current=setTimeout(()=>poll(library,opId),1200);
    }catch(e){setOperation(null);setError(`${t('同步进度读取失败：','Could not read sync progress: ')}${safeError(e,t)}`);}
  };
  const begin=async fn=>{if(busy)return;setBusy(true);setError('');setMessage('');setProgress(null);try{return await fn();}catch(e){setError(safeError(e,t));}finally{setBusy(false);}};
  const createLibrary=()=>begin(async()=>{const context=await call('libraryCreate',{name:name.trim()});onLibraryChange?.(context);setCreating(false);setName('');setMessage(t('已创建独立手机资料库。','Created a separate phone library.'));await refresh();});
  const connectNode=nodeId=>begin(async()=>{
    const result=await call('libraryConnect',{nodeId});setOperation({libraryId:result.libraryId,operationId:result.operationId});setProgress({state:result.state,phase:'bootstrap',completed:0,total:null});
    setMessage(t(`正在从「${nodes.find(x=>x.id===nodeId)?.name||'服务'}」下载资料库；现有本机库不会被覆盖。`,`Downloading the library from “${nodes.find(x=>x.id===nodeId)?.name||'server'}”. Existing phone libraries will not be replaced.`));
    await poll(result.libraryId,result.operationId);
  });
  const syncNow=()=>begin(async()=>{const started=await call('syncNow',{mode:'manual'});setOperation({libraryId,operationId:started.operationId});setProgress({state:started.state});await poll(libraryId,started.operationId);});
  const updatePrefs=async patch=>begin(async()=>{const value=await call('librarySettingsUpdate',{libraryId,...patch});setPrefs(value);setMessage(t('同步偏好已保存。','Sync preferences saved.'));});
  const canSync=(status?.role??libraryContext?.role)==='coordinated';
  const reconcilePending=async()=>{
    const pending=pendingResolution.current;if(!pending)return;
    if(pending.libraryId&&pending.libraryId!==libraryId)throw Error(t('另一资料库有待核对的冲突，请切回该资料库核对。','A conflict in another library needs verification. Switch back to that library.'));
    const split=String(pending.key||'').lastIndexOf(':');
    const conflictId=split>0?pending.key.slice(0,split):'';
    if(!conflictId||!pending.requestId)throw Error(t('上次冲突处理信息不完整，请保留现有数据并联系维护者。','The previous conflict request is incomplete. Keep the existing data and contact support.'));
    const receipt=await call('receipt',{libraryId,requestId:pending.requestId});
    const result=await call('syncConflictRead',{libraryId,conflictId});
    const conflict=result.conflict;
    if(receipt.status==='applied'&&receipt.recordId!==conflict.recordId)throw Error(t('冲突回执与记录不一致，请联系维护者。','The conflict receipt does not match the record. Contact support.'));
    if(receipt.status!=='applied'&&!(receipt.status==='unknown'&&conflict.state==='open'))throw Error(t('上次冲突处理仍待核对，请稍后重试。','The previous conflict resolution still needs verification. Try again later.'));
    pendingResolution.current=null;sessionStorage.removeItem('shiwen-conflict-pending');
  };
  const readCurrentConflict=async id=>{
    let result=await call('syncConflictRead',{libraryId,conflictId:id});
    let current=result.conflict;
    for(let attempt=0;attempt<2&&current.state==='open'&&current.headChanged&&current.latestHead;attempt++){
      const head=current.latestHead;
      try{
        await call('syncConflictRefresh',{libraryId,conflictId:id,expectedRemoteRevision:head.revision,
          expectedVersionId:head.versionId,expectedChangeId:head.changeId,expectedLocalRevision:head.localRevision});
        result=await call('syncConflictRead',{libraryId,conflictId:id});
        current={...result.conflict,refreshedLocalRevision:head.localRevision};
      }catch(e){if(!String(e?.message||e).includes('CONFLICT_HEAD_CHANGED'))throw e;current=(await call('syncConflictRead',{libraryId,conflictId:id})).conflict;}
    }
    return current;
  };
  const openConflict=async item=>begin(async()=>{
    await reconcilePending();const current=await readCurrentConflict(item.id);
    if(current.state!=='open'){await refreshConflicts(true);setMessage(t('此冲突已经处理，请查看其他冲突。','This conflict was already resolved. Review the others.'));return;}
    setSelectedConflict(current);setMergeBody(current.local?.markdown||current.remote?.markdown||'');setMergeMode(false);setShowFull(false);
  });
  const refreshConflict=()=>begin(async()=>{
    if(!selectedConflict)return;await reconcilePending();const current=await readCurrentConflict(selectedConflict.id);
    setSelectedConflict(current);setMergeBody(current.local?.markdown||current.remote?.markdown||'');setMergeMode(false);
    if(current.headChanged)setError(t('版本仍在变化，请稍后重试或手动同步。','Versions are still changing. Retry later or sync manually.'));
  });
  const resolve=async resolution=>{
    if(!selectedConflict||busy)return;
    if(selectedConflict.headChanged){setError(t('服务端版本已变化，请先读取最新版本并重新对比。','The server version has changed. Load the latest version and compare again.'));return;}
    if(!Number.isSafeInteger(selectedConflict.remoteRevision)||selectedConflict.remoteRevision<=0){setError(t('这条冲突缺少可核验的服务端版本。请先手动同步，再重新打开；若仍无法处理，请保留双方内容。','This conflict has no verifiable server revision. Sync and reopen it; if it remains unresolved, preserve both versions.'));return;}
    const title=resolution.kind==='keep-local'?t('保留手机版本','Keep phone version'):resolution.kind==='keep-remote'?t('保留服务端版本','Keep server version'):t('保存合并版本','Save merged version');
    if(!window.confirm(t(`${title}并解决此冲突？双方版本会继续保存在历史中。`,`Apply “${title}” and resolve this conflict? Both versions remain in history.`)))return;
    if(pendingResolution.current){try{await reconcilePending();const fresh=await call('syncConflictRead',{libraryId,conflictId:selectedConflict.id});if(fresh.conflict.state!=='open'){setSelectedConflict(null);await refreshConflicts(true);setMessage(t('上一次冲突处理已完成。','The previous conflict resolution completed.'));return;}setSelectedConflict(fresh.conflict);}catch(e){setError(safeError(e,t));return;}}
    const resolutionKey=`${selectedConflict.id}:${resolution.kind}`;
    const pending={key:resolutionKey,libraryId,requestId:crypto.randomUUID()};
    pendingResolution.current=pending;sessionStorage.setItem('shiwen-conflict-pending',JSON.stringify(pending));
    begin(async()=>{
      let result;
      try{result=await call('syncConflictResolve',{libraryId,conflictId:selectedConflict.id,expectedRemoteRevision:selectedConflict.remoteRevision??undefined,...((selectedConflict.refreshedLocalRevision??selectedConflict.latestHead?.localRevision)?{expectedLocalRevision:selectedConflict.refreshedLocalRevision??selectedConflict.latestHead.localRevision}:{}),resolution,requestId:pending.requestId});}
      catch(e){if(String(e?.message||e).includes('CONFLICT_HEAD_CHANGED')){await reconcilePending();const latest=await readCurrentConflict(selectedConflict.id);setSelectedConflict(latest);setMergeBody(latest.local?.markdown||latest.remote?.markdown||'');setMergeMode(false);setError(latest.headChanged?t('版本仍在变化或尚未同步，请稍后重试。','Versions are still changing or have not synced. Try again later.'):t('版本刚刚发生变化，已重新读取，请再次核对差异后选择。','A version changed. It has been reloaded; review the differences before choosing again.'));return;}throw e;}
      pendingResolution.current=null;sessionStorage.removeItem('shiwen-conflict-pending');
      setSelectedConflict(null);setMergeMode(false);setMessage(`${t('冲突已处理：','Conflict resolved: ')}${result.record?.title||selectedConflict.local?.title||t('记录','Record')}`);await refresh();await refreshConflicts();
    });
  };
  const comparison=useMemo(()=>conflictTextDiff(selectedConflict?.local?.markdown,selectedConflict?.remote?.markdown),[selectedConflict?.local?.markdown,selectedConflict?.remote?.markdown]);
  const conflictGroups=[...conflicts.reduce((groups,item)=>{const key=item.recordId||item.id;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(item);return groups;},new Map()).values()];
  const kindName=value=>({journal:t('日记','Journal'),idea:t('想法','Idea'),freewrite:t('自由书写','Freewriting'),reading_note:t('读书笔记','Reading note'),ai:t('AI 讨论','AI discussion'),reference:t('参考资料','Reference'),web:t('网页','Web'),article:t('文章','Article')}[value]||t('记录','Record'));
  return <section className="library-replica">
    <div className="settings-card library-identity-card"><div className="settings-heading"><div><strong>{t('当前资料库','Current library')}</strong><p className="secondary">{registry.find(item=>item.libraryId===libraryId)?.name||t('读取中','Loading')}</p></div><span className="state-pill">{label(status?.state||libraryContext?.role)}</span></div>
      <dl className="settings-details"><div><dt>{t('副本完整性','Replica completeness')}</dt><dd>{label(status?.integrity||libraryContext?.integrity)}</dd></div><div><dt>{t('待同步修改','Changes to sync')}</dt><dd>{status?.pendingCount==null?t('尚未检查','Not checked'):`${status.pendingCount} ${t('条','items')}`}</dd></div><div><dt>{t('待处理冲突','Conflicts to resolve')}</dt><dd>{status?.conflictCount==null?t('尚未检查','Not checked'):`${status.conflictCount} ${t('条','items')}`}</dd></div><div><dt>{t('最近同步','Last synced')}</dt><dd>{displayDate(status?.lastSyncedAt)||t('尚无成功同步记录','No successful sync yet')}</dd></div>{status?.lastError&&status.lastError!=='null'&&<div><dt>{t('最近错误','Latest error')}</dt><dd>{syncErrorText(status.lastError,t)}</dd></div>}</dl>
      <div className="node-actions"><button className="primary" disabled={!ready||busy||Boolean(operation)||!canSync} onClick={syncNow}>{busy?t('处理中…','Working…'):t('手动同步','Sync now')}</button><button className="chip" disabled={busy} onClick={()=>{void refresh();void refreshConflicts(true);}}>{t('刷新状态','Refresh status')}</button><button className="chip" disabled={busy||Boolean(operation)} onClick={()=>setShowDownload(true)}>{t('同步资料到手机','Sync library to phone')}</button></div>
      {prefs&&canSync&&<div className="library-sync-preferences"><label><input type="checkbox" checked={Boolean(prefs.autoSync)} disabled={busy} onChange={e=>updatePrefs({autoSync:e.target.checked})}/>{t('自动同步','Automatic sync')}</label><label><input type="checkbox" checked={Boolean(prefs.backgroundSync)} disabled={busy||!prefs.autoSync} onChange={e=>updatePrefs({backgroundSync:e.target.checked})}/>{t('允许后台同步','Allow background sync')}</label></div>}
      {!canSync&&<p className="secondary">{t('当前资料库还没有连接协调服务，本机记录仍会正常保存。','This library is not connected to a sync server. Records are still saved on this phone.')}</p>}
      {operation&&progress&&<div className="sync-progress" role="status"><strong>{label(progress.state)} · {phaseText(progress.phase,t)}</strong><span>{progress.completed!=null?`${progress.completed}${progress.total!=null?` / ${progress.total}`:''}`:t('正在准备','Preparing')}</span>{progress.error&&<p>{syncErrorText(progress.error,t)}</p>}</div>}
    </div>
    {status?.rejectedCount>0&&<section className="settings-card sync-section conflict-list"><h3>{t('未完成的写入','Writes needing attention')}</h3><p className="secondary">{t('这些修改尚未同步，请查看原因。','These changes have not synced. Review the reason.')}</p>{(status.rejectedOperations||[]).map((item,index)=><button className="library-conflict-row" key={item.operationId||index} onClick={()=>setError(`${t('未完成的写入','Write needing attention')}：${item.title||t('未命名记录','Untitled record')}\n${t('原因代码','Reason code')}：${item.code||'UNKNOWN'}\n${t('请保留手机资料，并提供此代码以便排查。','Keep the phone data and provide this code for troubleshooting.')}`)}><strong>{item.title||t('未命名记录','Untitled record')}</strong><span>{t('查看原因','View reason')}　›</span></button>)}{!status.rejectedOperations?.length&&<p>{t('无法读取详细原因，请刷新状态后重试。','Details could not be read. Refresh the status and try again.')}</p>}</section>}
    {(conflicts.length>0||status?.conflictCount>0)&&<section className="settings-card sync-section conflict-list"><h3>{t('同步冲突','Sync conflicts')}</h3>
      <div className="conflict-list-head"><span className="secondary">{t('逐条查看并选择保留的版本','Review each conflict and choose a version')}</span></div>
      {conflictGroups.map(group=><details className="conflict-group" key={group[0].recordId||group[0].id} open>
        <summary><strong>{group[0].title||t('未命名记录','Untitled record')}</strong><span>{kindName(group[0].kind)}{group[0].contentDay?` · ${group[0].contentDay}`:''} · {group.length} {t('条已加载','loaded')}</span></summary>
        {group.map((item,index)=><button className="library-conflict-row" key={item.id} onClick={()=>openConflict(item)}><strong>{group.length>1?t(`查看第 ${index+1} 条冲突`,`Review conflict ${index+1}`):t('查看并处理','Review and resolve')}</strong><span>{displayDate(item.createdAt)||t('时间未知','Time unknown')}　›</span></button>)}
      </details>)}
      {conflictCursor&&<button className="chip" onClick={()=>refreshConflicts(false)}>{t('加载更多冲突','Load more conflicts')}</button>}{!conflicts.length&&<p className="secondary">{conflictsLoaded?t('暂未读取到冲突，请稍后重试。','Conflicts could not be loaded; try again later.'):t('正在读取冲突…','Loading conflicts…')}</p>}
    </section>}
    {showDownload&&<MessageDialog title={t('同步资料到手机','Sync library to phone')} closeLabel={t('关闭','Close')} onClose={()=>setShowDownload(false)}>
      <p className="secondary">{t('选择服务节点。已有同一资料库的手机副本会接续使用；其他资料库会建立独立副本。','Choose a server. An existing phone copy of the same library is reused; a different library gets a separate copy.')}</p>
      {nodes.length?nodes.map(node=><div className="library-connect-row" key={node.id}><div><strong>{node.name}</strong><small>{node.baseUrl}</small></div><button className="chip" disabled={!node.authenticated||busy||Boolean(operation)} onClick={()=>{setShowDownload(false);void connectNode(node.id);}}>{node.authenticated?t('下载资料库','Download library'):t('需先登录','Sign in first')}</button></div>):<p className="secondary">{t('请先在服务节点设置中添加并登录服务器。','Add and sign in to a server in Settings first.')}</p>}
    </MessageDialog>}
    {selectedConflict&&<MessageDialog title={selectedConflict.local?.title||selectedConflict.remote?.title||t('冲突详情','Conflict details')} closeLabel={t('关闭','Close')} onClose={()=>{setSelectedConflict(null);setMergeMode(false);}}>
      <div className="conflict-detail">{selectedConflict.headChanged&&<div className="conflict-refresh"><p>{t('暂时无法核对最新版本，请先同步后重试。','The latest version cannot be verified. Sync and retry.')}</p>{selectedConflict.latestHead&&<button className="chip" disabled={busy} onClick={refreshConflict}>{t('重试','Retry')}</button>}</div>}
      <p className="conflict-comparison-note">{t('对比手机与最近同步的服务端版本','Comparing phone content with the last synced server version')}</p><div className="conflict-view-toggle"><strong>{showFull?t('完整内容','Full content'):t('内容差异','Differences')}</strong><button type="button" className="chip" onClick={()=>setShowFull(value=>!value)}>{showFull?t('只看差异','Show differences'):t('查看全文','View full content')}</button></div>
      {!showFull&&<ConflictMetadata local={selectedConflict.local} remote={selectedConflict.remote} t={t}/>}
      {!showFull&&comparison.same&&<p className="secondary">{t('正文一致；请检查记录信息和附件。','Text is identical; check record details and attachments.')}</p>}
      {!showFull&&comparison.unavailable&&<p className="secondary">{t('内容较长或差异较多，暂无法生成差异摘要，请查看全文。','The content is too large or different for a summary. View the full content.')}</p>}
      {(showFull||(!comparison.same&&!comparison.unavailable))&&<><div className="conflict-version"><strong>{t('手机版本','Phone version')}</strong>{showFull?<MarkdownView markdown={selectedConflict.local?.markdown||''} libraryId={libraryId} recordId={selectedConflict.recordId} attachmentDescriptors={imageDescriptors(selectedConflict.local)}/>:<DiffExcerpt items={comparison.local} t={t}/>}</div>
      <div className="conflict-version"><strong>{t('服务端版本','Server version')}</strong>{!selectedConflict.remote?<p>{t('服务端已删除此记录。','The server deleted this record.')}</p>:showFull?<MarkdownView markdown={selectedConflict.remote.markdown||''} libraryId={libraryId} recordId={selectedConflict.recordId} attachmentDescriptors={imageDescriptors(selectedConflict.remote)}/>:<DiffExcerpt items={comparison.remote} t={t}/>}</div></>}
      {mergeMode&&<label className="conflict-merge-label">{t('手动合并正文','Merge content manually')}<textarea value={mergeBody} onChange={e=>setMergeBody(e.target.value)} spellCheck="false"/></label>}
      <div className="node-actions conflict-actions"><button className="chip" disabled={busy||selectedConflict.headChanged} onClick={()=>resolve({kind:'keep-local'})}>{t('保留手机版本','Keep phone version')}</button><button className="chip" disabled={busy||selectedConflict.headChanged} onClick={()=>resolve({kind:'keep-remote'})}>{t('保留服务端版本','Keep server version')}</button>{mergeMode?<button className="primary" disabled={busy||selectedConflict.headChanged||!mergeBody.trim()} onClick={()=>{const local=selectedConflict.local||selectedConflict.remote;resolve({kind:'merge',record:{id:selectedConflict.recordId,kind:local.kind,title:local.title,markdown:mergeBody}});}}>{t('保存合并版本','Save merged version')}</button>:<button className="chip" disabled={busy||selectedConflict.headChanged} onClick={()=>setMergeMode(true)}>{t('手动合并','Merge manually')}</button>}</div></div>
    </MessageDialog>}
    {(error||message)&&<MessageDialog message={error||message} onClose={()=>{setError('');setMessage('');}}/>}
  </section>;
}

function DiffExcerpt({items,t}){return <div className="conflict-diff-text">{items?.length?items.map((item,index)=>item.changed?<mark key={index}>{item.text}</mark>:<span key={index}>{item.text}</span>):<span className="secondary">{t('此处无内容','No content here')}</span>}</div>;}
function ConflictMetadata({local,remote,t}){
  const fields=[['title',t('标题','Title')],['kind',t('类型','Type')],['origin',t('来源','Origin')],['contentDay',t('日期','Date')],['processing',t('处理方式','Processing')],['url',t('链接','Link')],['annotation',t('备注','Note')],['stage',t('状态','Stage')],['deleted',t('删除状态','Deletion status')]];
  const changed=fields.filter(([key])=>String(local?.[key]??'')!==String(remote?.[key]??''));
  const sourceLabels=record=>(record?.sources||[]).map(item=>[item.origin||'unknown',item.sourceRef||''].filter(Boolean).join(' · '));
  const attachmentLabels=record=>imageDescriptors(record).map(item=>[item.name||t('附件','Attachment'),item.hash?String(item.hash).slice(0,8):''].filter(Boolean).join(' · '));
  const localSources=sourceLabels(local),remoteSources=sourceLabels(remote),localAttachments=attachmentLabels(local),remoteAttachments=attachmentLabels(remote);
  const sourcesDifferent=JSON.stringify(localSources)!==JSON.stringify(remoteSources);
  const attachmentsDifferent=JSON.stringify(localAttachments)!==JSON.stringify(remoteAttachments);
  if(!changed.length&&!sourcesDifferent&&!attachmentsDifferent)return null;
  return <div className="conflict-metadata-diff">{changed.map(([key,label])=><div key={key}><strong>{label}</strong><span>{t('手机','Phone')}：{String(local?.[key]??'—')}</span><span>{t('服务端','Server')}：{String(remote?.[key]??'—')}</span></div>)}{sourcesDifferent&&<div><strong>{t('来源标注','Source attribution')}</strong><span>{t('手机','Phone')}：{localSources.join('、')||'—'}</span><span>{t('服务端','Server')}：{remoteSources.join('、')||'—'}</span></div>}{attachmentsDifferent&&<div><strong>{t('附件','Attachments')}</strong><span>{t('手机','Phone')}：{localAttachments.join('、')||'—'}</span><span>{t('服务端','Server')}：{remoteAttachments.join('、')||'—'}</span></div>}</div>;
}
