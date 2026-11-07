import React,{useCallback,useEffect,useRef,useState} from 'react';
import {call} from '../bridge/library.mjs';
import {MarkdownView} from './MarkdownView.jsx';
import {useI18n} from './i18n.js';
import {syncCompletionMessage} from './sync-summary.mjs';
import './record.css';

const displayDate=value=>{if(!value||value==='null')return '';const date=new Date(value);return Number.isNaN(date.getTime())?value:date.toLocaleString();};
const phaseText=(value,t)=>({identity:t('核对服务身份','Checking server identity'),bootstrap:t('读取资料库','Reading library'),push:t('上传本机更改','Uploading local changes'),receipts:t('核对写入回执','Checking write receipts'),pull:t('接收更新','Receiving updates'),attachments:t('传输附件','Transferring attachments'),ack:t('确认同步进度','Confirming sync progress'),finalize:t('完成收尾','Finalizing')}[value]||value||t('同步','Sync'));
const terminal=new Set(['completed','failed','cancelled']);
const statusText=(value,t)=>{const labels={standalone:['仅本机','On phone'],coordinated:['已连接服务','Connected to server'],initializing:['初次同步中','Initial sync'],idle:['已连接','Connected'],syncing:['同步中','Syncing'],incomplete:['资料不完整','Incomplete'],conflicted:['有待处理冲突','Conflicts need attention'],error:['同步异常','Sync error'],queued:['等待开始','Queued'],running:['进行中','In progress'],completed:['完成','Complete'],failed:['失败','Failed'],cancelled:['已取消','Cancelled'],complete:['完整','Complete'],paused:['已暂停','Paused'],'rebind-required':['需要重新绑定','Rebind required']};return labels[value]?t(...labels[value]):value||t('状态未知','Unknown state');};
const safeError=(e,t)=>({NODE_MANAGEMENT_API_UNSUPPORTED:t('此服务器需要更新拾文插件。','Update the Shiwen plugin on this server.'),NODE_AUTH_REQUIRED:t('服务登录已失效，请返回设置重新登录。','Server sign-in expired. Sign in again in Settings.'),AUTH_REQUIRED:t('请重新登录此服务。','Sign in to this server again.'),NODE_CHANGED:t('服务配置已变更，请重新读取。','Server settings changed. Reload and try again.')}[e?.code||e?.message]||e?.message||t('操作失败','Operation failed'));

export function LibraryReplicaPanel({ready,libraryId,libraryContext,nodes,onLibraryChange,onPageStateChange=()=>{}}){
  const {t}=useI18n();
  const label=value=>statusText(value,t);
  const [registry,setRegistry]=useState([]),[status,setStatus]=useState(null),[prefs,setPrefs]=useState(null),[name,setName]=useState(''),[creating,setCreating]=useState(false),[operation,setOperation]=useState(null),[progress,setProgress]=useState(null),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[error,setError]=useState('');
  const [conflicts,setConflicts]=useState([]),[selectedConflict,setSelectedConflict]=useState(null),[conflictCursor,setConflictCursor]=useState(null),[mergeMode,setMergeMode]=useState(false),[mergeBody,setMergeBody]=useState('');
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
    try{const page=await call('syncConflicts',{libraryId,cursor:reset?undefined:conflictCursor,limit:20});setConflicts(old=>reset?page.items:[...old,...page.items]);setConflictCursor(page.nextCursor??null);}
    catch(e){setError(safeError(e,t));}
  };
  const poll=async(library,opId)=>{
    try{
      const next=await call('syncProgress',{boundLibraryId:libraryId,pageGeneration:libraryContext?.pageGeneration,targetLibraryId:library,operationId:opId});setProgress(next);
      if(terminal.has(next.state)){
        setOperation(null);await refresh();
        if(next.state==='completed'&&library!==libraryId){
          const context=await call('librarySelect',{libraryId:library});await onLibraryChange?.(context);
        }
        if(next.state==='completed'){
          try{const status=await call('syncStatus',{libraryId:library});setMessage(syncCompletionMessage(status,t));setError('');}
          catch{setMessage(t('本轮同步操作结束，但无法读取资料库状态。请返回设置核对同步状态。','This sync operation ended, but its library status could not be read. Check the sync status in Settings.'));setError('');}
        }else setMessage(`${t('同步','Sync')} ${label(next.state)}：${next.error||''}`);
        return;
      }
      pollTimer.current=setTimeout(()=>poll(library,opId),1200);
    }catch(e){setOperation(null);setError(`${t('同步进度读取失败：','Could not read sync progress: ')}${safeError(e,t)}`);}
  };
  const begin=async fn=>{if(busy)return;setBusy(true);setError('');setMessage('');setProgress(null);try{return await fn();}catch(e){setError(safeError(e,t));}finally{setBusy(false);}};
  const selectLibrary=id=>begin(async()=>{const context=await call('librarySelect',{libraryId:id});onLibraryChange?.(context);setMessage(t('已切换当前资料库。','Switched current library.'));await refresh();});
  const createLibrary=()=>begin(async()=>{const context=await call('libraryCreate',{name:name.trim()});onLibraryChange?.(context);setCreating(false);setName('');setMessage(t('已创建独立手机资料库。','Created a separate phone library.'));await refresh();});
  const connectNode=nodeId=>begin(async()=>{
    const result=await call('libraryConnect',{nodeId});setOperation({libraryId:result.libraryId,operationId:result.operationId});setProgress({state:result.state,phase:'bootstrap',completed:0,total:null});
    setMessage(t(`正在从「${nodes.find(x=>x.id===nodeId)?.name||'服务'}」下载资料库；现有本机库不会被覆盖。`,`Downloading the library from “${nodes.find(x=>x.id===nodeId)?.name||'server'}”. Existing phone libraries will not be replaced.`));
    await poll(result.libraryId,result.operationId);
  });
  const syncNow=()=>begin(async()=>{const started=await call('syncNow',{mode:'manual'});setOperation({libraryId,operationId:started.operationId});setProgress({state:started.state});await poll(libraryId,started.operationId);});
  const updatePrefs=async patch=>begin(async()=>{const value=await call('librarySettingsUpdate',{libraryId,...patch});setPrefs(value);setMessage(t('同步偏好已保存。','Sync preferences saved.'));});
  const canSync=(status?.role??libraryContext?.role)==='coordinated';
  const openConflict=async item=>begin(async()=>{const result=await call('syncConflictRead',{libraryId,conflictId:item.id});setSelectedConflict(result.conflict);setMergeBody(result.conflict.local?.markdown||result.conflict.remote?.markdown||'');setMergeMode(false);});
  const resolve=resolution=>{
    if(!selectedConflict||busy)return;
    const title=resolution.kind==='keep-local'?t('保留手机版本','Keep phone version'):resolution.kind==='keep-remote'?t('保留服务端版本','Keep server version'):t('保存合并版本','Save merged version');
    if(!window.confirm(t(`${title}并解决此冲突？双方版本会继续保存在历史中。`,`Apply “${title}” and resolve this conflict? Both versions remain in history.`)))return;
    const resolutionKey=`${selectedConflict.id}:${resolution.kind}`;
    if(pendingResolution.current&&pendingResolution.current.key!==resolutionKey){setError(t('上一次冲突处理结果待核对，请先重新读取该冲突。','The previous conflict resolution needs verification. Reload that conflict first.'));return;}
    const pending=pendingResolution.current||{key:resolutionKey,requestId:crypto.randomUUID()};
    pendingResolution.current=pending;sessionStorage.setItem('shiwen-conflict-pending',JSON.stringify(pending));
    begin(async()=>{
      const result=await call('syncConflictResolve',{libraryId,conflictId:selectedConflict.id,expectedRemoteRevision:selectedConflict.remoteRevision??undefined,resolution,requestId:pending.requestId});
      pendingResolution.current=null;sessionStorage.removeItem('shiwen-conflict-pending');
      setSelectedConflict(null);setMergeMode(false);setMessage(`${t('冲突已处理：','Conflict resolved: ')}${result.record?.title||selectedConflict.local?.title||t('记录','Record')}`);await refresh();await refreshConflicts();
    });
  };
  return <section className="library-replica">
    <header className="library-replica-head"><div><h2>{t('手机资料库与同步','Phone libraries and sync')}</h2><p className="secondary">{t('每个资料库在手机单独保存；服务端连接用于建立完整副本并持续汇合修改。','Each library has a separate phone copy. Connecting a server creates a full replica and syncs changes.')}</p></div><button className="chip" disabled={busy} onClick={refresh}>{t('刷新','Refresh')}</button></header>
    <div className="settings-card library-identity-card"><div className="settings-heading"><div><strong>{t('当前资料库','Current library')}</strong><p className="secondary">{registry.find(item=>item.libraryId===libraryId)?.name||t('读取中','Loading')}</p></div><span className="state-pill">{label(status?.state||libraryContext?.role)}</span></div>
      <dl className="settings-details"><div><dt>{t('副本完整性','Replica completeness')}</dt><dd>{label(status?.integrity||libraryContext?.integrity)}</dd></div><div><dt>{t('待同步修改','Changes to sync')}</dt><dd>{status?.pendingCount==null?t('尚未检查','Not checked'):`${status.pendingCount} ${t('条','items')}`}</dd></div><div><dt>{t('待处理冲突','Conflicts to resolve')}</dt><dd>{status?.conflictCount==null?t('尚未检查','Not checked'):`${status.conflictCount} ${t('条','items')}`}</dd></div><div><dt>{t('最近同步','Last synced')}</dt><dd>{displayDate(status?.lastSyncedAt)||t('尚无成功同步记录','No successful sync yet')}</dd></div>{status?.lastError&&status.lastError!=='null'&&<div><dt>{t('最近错误','Latest error')}</dt><dd>{status.lastError}</dd></div>}</dl>
      <div className="node-actions"><button className="primary" disabled={!ready||busy||Boolean(operation)||!canSync} onClick={syncNow}>{busy?t('处理中…','Working…'):t('手动同步','Sync now')}</button><button className="chip" disabled={busy} onClick={()=>refreshConflicts(true)}>{t('查看冲突','View conflicts')}</button></div>
      {prefs&&canSync?<div className="library-sync-preferences"><label><input type="checkbox" checked={Boolean(prefs.autoSync)} disabled={busy} onChange={e=>updatePrefs({autoSync:e.target.checked})}/>{t('自动同步','Automatic sync')}</label><label><input type="checkbox" checked={Boolean(prefs.backgroundSync)} disabled={busy||!prefs.autoSync} onChange={e=>updatePrefs({backgroundSync:e.target.checked})}/>{t('允许后台同步','Allow background sync')}</label></div>:<p className="secondary">{t('当前资料库还没有连接协调服务，本机记录仍会正常保存。','This library is not connected to a sync server. Records are still saved on this phone.')}</p>}
      {operation&&progress&&<div className="sync-progress" role="status"><strong>{label(progress.state)} · {phaseText(progress.phase,t)}</strong><span>{progress.completed!=null?`${progress.completed}${progress.total!=null?` / ${progress.total}`:''}`:t('正在准备','Preparing')}</span>{progress.error&&<p>{progress.error}</p>}</div>}
    </div>
    <section className="settings-card"><h3>{t('可用资料库','Available libraries')}</h3>{registry.map(item=><article className="library-registry-row" key={item.libraryId}><div><strong>{item.name}</strong><small>{label(item.role)} · {label(item.integrity)}</small></div>{item.libraryId===libraryId?<span className="state-pill is-ready">{t('正在使用','In use')}</span>:<button className="chip" disabled={busy} onClick={()=>selectLibrary(item.libraryId)}>{t('切换','Switch')}</button>}</article>)}
      {creating?<div className="library-create-form"><label>{t('资料库名称','Library name')}<input value={name} maxLength={80} onChange={e=>setName(e.target.value)} placeholder={t('例如：个人写作','For example: Personal writing')}/></label><button className="primary" disabled={busy||!name.trim()} onClick={createLibrary}>{t('创建独立资料库','Create separate library')}</button><button className="chip" disabled={busy} onClick={()=>setCreating(false)}>{t('取消','Cancel')}</button></div>:<button className="chip" disabled={busy} onClick={()=>setCreating(true)}>＋ {t('创建手机资料库','Create phone library')}</button>}
    </section>
    <section className="settings-card"><h3>{t('从服务端同步资料库到手机','Sync a server library to this phone')}</h3><p className="secondary">{t('会先核对服务身份。已有同一资料库的手机副本会接续使用；其他资料库会建立独立副本，不覆盖手机已有资料。','The server identity is checked first. A phone copy with the same libraryId is reused; a different ID creates an isolated copy without replacing existing data.')}</p>{nodes.length?nodes.map(node=><div className="library-connect-row" key={node.id}><div><strong>{node.name}</strong><small>{node.baseUrl}</small></div><button className="chip" disabled={!node.authenticated||busy||Boolean(operation)} title={!node.authenticated?t('请先在服务节点设置中登录并检查连接','Sign in and check this server in Settings first'):''} onClick={()=>connectNode(node.id)}>{node.authenticated?t('下载资料库','Download library'):t('需先登录','Sign in first')}</button></div>):<p className="empty-state">{t('请先在服务节点设置中添加并登录服务器。','Add and sign in to a server in Settings first.')}</p>}{!nodes.length&&<p className="secondary">{t('服务端资料库连接使用完整初始化快照，下载未完成时会标为初始化中。','A server library is downloaded from a full snapshot and remains marked as initializing until complete.')}</p>}</section>
    <section className="settings-card"><div className="settings-heading"><h3>{t('同步冲突','Sync conflicts')}</h3><button className="chip" disabled={busy} onClick={()=>refreshConflicts(true)}>{t('刷新列表','Refresh list')}</button></div>{conflicts.map(item=><button className="library-conflict-row" key={item.id} onClick={()=>openConflict(item)}><strong>{item.title||item.recordId}</strong><span>{item.kind||t('记录','Record')} · {item.createdAt||t('待处理','Needs review')}</span></button>)}{conflictCursor&&<button className="chip" onClick={()=>refreshConflicts(false)}>{t('加载更多冲突','Load more conflicts')}</button>}{!conflicts.length&&<p className="empty-state">{t('冲突尚未读取；点击“查看冲突”刷新，避免把未知状态显示成零。','Conflicts have not been read. Refresh the list before treating an unknown count as zero.')}</p>}
      {selectedConflict&&<div className="conflict-detail"><h4>{selectedConflict.local?.title||selectedConflict.remote?.title||selectedConflict.recordId}</h4><div className="conflict-version"><strong>{t('手机版本','Phone version')}</strong><MarkdownView markdown={selectedConflict.local?.markdown||''}/></div><div className="conflict-version"><strong>{t('服务端版本','Server version')}</strong>{selectedConflict.remote?<MarkdownView markdown={selectedConflict.remote.markdown||''}/>:<p>{t('服务端已删除此记录；保留手机版本会恢复并继续保存。','The server deleted this record. Keeping the phone version restores it and preserves its content.')}</p>}</div>{mergeMode&&<label className="conflict-merge-label">{t('手动合并正文','Merge content manually')}<textarea value={mergeBody} onChange={e=>setMergeBody(e.target.value)} spellCheck="false"/></label>}<div className="node-actions"><button className="chip" disabled={busy} onClick={()=>resolve({kind:'keep-local'})}>{t('保留手机版本','Keep phone version')}</button><button className="chip" disabled={busy} onClick={()=>resolve({kind:'keep-remote'})}>{t('保留服务端版本','Keep server version')}</button>{mergeMode?<button className="primary" disabled={busy||!mergeBody.trim()} onClick={()=>{const local=selectedConflict.local||selectedConflict.remote;resolve({kind:'merge',record:{id:selectedConflict.recordId,kind:local.kind,title:local.title,markdown:mergeBody}});}}>{t('保存合并版本','Save merged version')}</button>:<button className="chip" disabled={busy} onClick={()=>setMergeMode(true)}>{t('手动合并','Merge manually')}</button>}<button className="chip" disabled={busy} onClick={()=>setSelectedConflict(null)}>{t('关闭','Close')}</button></div></div>}
    </section>
    {message&&<p className="success-note" role="status">{message}</p>}{error&&<p className="error" role="alert">{error}</p>}
  </section>;
}
