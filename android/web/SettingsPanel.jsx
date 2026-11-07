import React, {useCallback, useEffect, useRef, useState} from 'react';
import {call} from '../bridge/library.mjs';
import {AgentSettingsPanel} from './AgentSettingsPanel.jsx';
import {ManagementPanel, ExternalAccessPanel} from './ManagementPanel.jsx';
import {LibraryReplicaPanel} from './LibraryReplicaPanel.jsx';
import {LocalAgentProfilePanel} from './LocalAgentProfilePanel.jsx';
import {RecoveryPanel} from './RecoveryPanel.jsx';
import {LibraryTransferPanel} from './LibraryTransferPanel.jsx';
import {ShareInboxPanel} from './ShareInboxPanel.jsx';
import {applyAppearance,setLanguage,useI18n} from './i18n.js';
import {syncCompletionMessage} from './sync-summary.mjs';
import './settings-translations.mjs';
import './settings-redesign.css';

const syncText = (value,t) => ({synced:t('人设已同步','Persona synced'), cached:t('仅有上次缓存','Last verified snapshot cached'), 'not-synced':t('尚未同步','Not synced')}[value] || value || t('尚无同步记录','No sync record yet'));
const syncProgressText = (value,t) => ({queued:t('排队中','Queued'),running:t('同步中','Syncing'),completed:t('已完成','Completed'),failed:t('失败','Failed'),cancelled:t('已取消','Cancelled'),paused:t('已暂停','Paused'),error:t('出错','Error'),initializing:t('初始化中','Initializing'),idle:t('空闲','Idle')}[value]||value||t('状态未知','Unknown status'));
const displayDate = value => { if (!value || value === 'null') return ''; const date = new Date(value); return Number.isNaN(date.getTime()) ? value : date.toLocaleString(); };
const syncPhaseText = (value,t) => ({identity:t('核对服务身份','Checking server identity'),bootstrap:t('读取资料库','Reading library'),push:t('上传本机更改','Uploading local changes'),receipts:t('核对写入回执','Checking write receipts'),pull:t('接收更新','Receiving updates'),attachments:t('传输附件','Transferring attachments'),ack:t('确认同步进度','Confirming sync progress'),finalize:t('完成收尾','Finalizing')}[value]||value||'');
const serviceErrorText = (error,t) => ({NODE_MANAGEMENT_API_UNSUPPORTED:t('此服务器的拾文插件版本较旧，请更新服务器端拾文插件后重试。','This server has an older Shiwen plugin. Update it and try again.'),NODE_AUTH_REQUIRED:t('登录状态已失效，请返回设置重新登录。','Sign-in expired. Sign in again in Settings.')}[error?.code] || error?.message || t('请求失败，请检查服务连接后重试。','Request failed. Check the server connection and try again.'));
const formatBytes = (value,t) => {
  if (!Number.isFinite(Number(value))) return t('未知','Unknown');
  const bytes=Math.max(0,Number(value));
  if(bytes<1024)return `${bytes} ${t('字节','B')}`;
  const units=['KB','MB','GB','TB'];let amount=bytes/1024,index=0;
  while(amount>=1024&&index<units.length-1){amount/=1024;index++;}
  return `${amount.toFixed(amount>=100?0:1)} ${units[index]}`;
};

export function SettingsPanel({ready, libraryId, libraries=[], libraryContext, config, onConfig, onPageStateChange, pageState, onNavigation, onNavigate, onLibraryChange, onLibrariesRefresh}) {
  const {language,t}=useI18n();
  const [nodes, setNodes] = useState([]), [activeId, setActiveId] = useState(null);
  const [settingsPage, setSettingsPage] = useState('home');
  const [managementNode, setManagementNode] = useState(null);
  const managementDetailBack=useRef(null);
  const [agentNode, setAgentNode] = useState(null);
  const [management, setManagement] = useState(null), [externalNode, setExternalNode] = useState(null), [recoveryNode, setRecoveryNode] = useState(null), [more, setMore] = useState(false);
  const [registryGeneration,setRegistryGeneration]=useState(0);
  const [storage,setStorage]=useState(null),[storageName,setStorageName]=useState('');
  const [nodeSync,setNodeSync]=useState(null);
  const syncTimer=useRef(null),syncGeneration=useRef(0),currentContext=useRef({libraryId,libraryContext});
  currentContext.current={libraryId,libraryContext};
  const [busy, setBusy] = useState(false), [feedback, setFeedback] = useState(null);
  const message=feedback?.text||'';
  const setMessage=value=>setFeedback(value?{kind:'error',text:value}:null);
  const setSuccess=value=>setFeedback(value?{kind:'success',text:value}:null);
  const [nativeAvailable, setNativeAvailable] = useState(true);
  const [theme,setTheme]=useState('system'),[appearanceReady,setAppearanceReady]=useState(false);
  const refreshModel = useCallback(async () => {
    try { const value = await call('modelConfig'); onConfig?.(value); setNativeAvailable(true); }
    catch (error) { setMessage(`${t('模型配置读取失败：','Could not read model settings: ')}${error.message}`); }
  }, [onConfig]);
  const refreshNodes = useCallback(async () => {
    try {
      const snapshot = await call('nodeList');
      setNodes(snapshot.items || []); setActiveId(snapshot.activeId ?? null); setNativeAvailable(true);
    } catch (error) {
      // Older preview/native builds may not yet include node APIs; do not draw
      // pretend controls. Keep this as a clearly stated unavailable capability.
      setNodes([]); setActiveId(null); setNativeAvailable(false);
      setMessage(`${t('服务节点设置暂不可用：','Server settings are unavailable: ')}${serviceErrorText(error,t)}`);
    }
  }, []);
  useEffect(() => {
    if (!ready) return;
    refreshModel(); refreshNodes();
    call('settingsGet').then(value=>{setTheme(value.theme||'system');setLanguage(value.language||'zh-CN');applyAppearance(value.theme||'system',value.systemDark);setAppearanceReady(true);}).catch(error=>setMessage(`${t('显示设置读取失败：','Could not read display settings: ')}${error.message}`));
  }, [ready, refreshModel, refreshNodes]);
  const run = async operation => {
    if (busy) return;
    onPageStateChange?.({dirty:false,busy:true});
    setBusy(true); setMessage('');
    try { await operation(); }
    catch (error) { setMessage(error.message || t('操作失败，请重试。','Operation failed. Try again.')); }
    finally { setBusy(false); onPageStateChange?.({dirty:false,busy:false}); }
  };
  useEffect(()=>()=>{syncGeneration.current++;clearTimeout(syncTimer.current);},[]);
  const pollNodeSync=useCallback(async (nodeId,targetLibraryId,operationId,initialState='queued')=>{
    const generation=++syncGeneration.current;
    const source={...currentContext.current};
    setNodeSync({nodeId,libraryId:targetLibraryId,operationId,state:initialState,completed:0,total:null});
    const poll=async()=>{
      if(generation!==syncGeneration.current)return;
      const now=currentContext.current;
      if(now.libraryId!==source.libraryId||now.libraryContext?.pageGeneration!==source.libraryContext?.pageGeneration){
        setNodeSync({nodeId,libraryId:targetLibraryId,operationId,state:'paused',message:t('当前资料库已切换，同步仍在服务端继续。','The current library changed. Sync continues on the server.')});return;
      }
      try{
        const progress=await call('syncProgress',{boundLibraryId:source.libraryId,pageGeneration:source.libraryContext?.pageGeneration,targetLibraryId,operationId});
        if(generation!==syncGeneration.current)return;
        setNodeSync({nodeId,libraryId:targetLibraryId,operationId,...progress});
        if(['completed','failed','cancelled'].includes(progress.state)){
          await refreshNodes();
          if(progress.state==='completed'){
            const snapshot=await call('libraryList');
            if(generation!==syncGeneration.current)return;
            if((snapshot.items||[]).some(item=>item.libraryId===targetLibraryId)){
              const context=await call('librarySelect',{libraryId:targetLibraryId});
              if(generation!==syncGeneration.current)return;
              await onLibraryChange?.(context);await onLibrariesRefresh?.();
              try{const status=await call('syncStatus',{libraryId:targetLibraryId});setSuccess(syncCompletionMessage(status,t));}
              catch{setMessage(t('本轮同步操作结束，但无法读取资料库状态。请返回设置核对同步状态。','This sync operation ended, but its library status could not be read. Check the sync status in Settings.'));}
            }else setMessage(t('同步已完成，但资料库尚未出现在本机列表中。请刷新后检查。','Sync completed, but the library is not in the local list yet. Refresh and check again.'));
          }else setMessage(`${t('资料库同步','Library sync')}: ${syncProgressText(progress.state,t)}${progress.error?` · ${progress.error}`:''}`);
          return;
        }
        syncTimer.current=setTimeout(poll,1200);
      }catch(error){
        if(generation!==syncGeneration.current)return;
        setNodeSync({nodeId,libraryId:targetLibraryId,operationId,state:'error',error:error.message||String(error)});
      }
    };
    await poll();
  },[onLibraryChange,onLibrariesRefresh,refreshNodes,t]);
  const configureModel = () => run(async () => {
    await call('configureModel'); await refreshModel();
  });
  const configureNode = id => run(async () => {
    const result=await call('configureNode', id ? {id} : {});
    const snapshot=await call('nodeList');setNodes(snapshot.items||[]);setActiveId(snapshot.activeId??null);
    if(result.syncError)setMessage(`${t('节点已连接，但资料库同步未能启动：','Server connected, but library sync could not start: ')}${result.syncError}`);
    else if(result.sync?.operationId)await pollNodeSync(id||snapshot.activeId,result.sync.libraryId,result.sync.operationId,result.sync.state);
  });
  const selectNode = id => run(async () => {
    const snapshot = await call('nodeSelect', {id});
    setNodes(snapshot.items || []); setActiveId(snapshot.activeId ?? null);
  });
  const checkNode = id => run(async () => {
    try {
      const snapshot = await call('nodeCheck', {id});
      setNodes(snapshot.items || []); setActiveId(snapshot.activeId ?? null);
      if(snapshot.syncError)setMessage(`${t('连接已核验，但资料库同步未能启动：','Connection verified, but library sync could not start: ')}${snapshot.syncError}`);
      else if(snapshot.sync?.operationId)await pollNodeSync(id,snapshot.sync.libraryId,snapshot.sync.operationId,snapshot.sync.state);
    } catch (error) {
      await refreshNodes();
      throw error;
    }
  });
  const selectPhoneProfile = () => run(async () => {
    const snapshot = await call('nodeSelect', {id:''});
    setNodes(snapshot.items || []); setActiveId(snapshot.activeId ?? null);
  });
  const removeNode = id => {
    if (!window.confirm(t('从此手机移除此服务节点？服务端资料不会被删除。','Remove this server from the phone? Its server data will not be deleted.'))) return;
    run(async () => {
      const snapshot = await call('nodeRemove', {id});
      setNodes(snapshot.items || []); setActiveId(snapshot.activeId ?? null);
    });
  };
  const modelIsConfigured = Boolean(config?.configured);
  const saveAppearance=(patch)=>run(async()=>{const value=await call('settingsUpdate',patch);setTheme(value.theme||theme);setLanguage(value.language||language);applyAppearance(value.theme||theme,value.systemDark);});

  const childOwner=agentNode?`agent:${agentNode.id}`:management?`management:${management.node.id}:${management.section}`:externalNode?`external:${externalNode.id}`:recoveryNode?`recovery:${recoveryNode.id}`:`page:${settingsPage}`;
  const activeOwner=useRef(childOwner);activeOwner.current=childOwner;
  const reportChildState = useCallback(state => {if(activeOwner.current===childOwner)onPageStateChange?.(state);}, [onPageStateChange,childOwner]);
  const goSettingsHome=()=>{if(busy||pageState?.busy){setMessage(t('当前操作尚未完成，请稍候。','Wait for the current operation to finish.'));return;}if(pageState?.dirty&&!window.confirm(t('放弃尚未保存的修改？','Discard unsaved changes?')))return;setSettingsPage('home');};
  const refreshAfterRestore=useCallback(async()=>{await onLibrariesRefresh?.();setRegistryGeneration(value=>value+1);},[onLibrariesRefresh]);
  const refreshStorage=useCallback(async()=>{
    if(!ready)return;
    try { const value=await call('storageInfo');setStorage(value); }
    catch(error) { setMessage(`${t('存储信息读取失败：','Could not read storage information: ')}${error.message||error}`); }
  },[ready]);
  useEffect(()=>{refreshStorage();},[refreshStorage,libraryId]);
  const currentLibrary=libraries.find(item=>item.libraryId===libraryId);
  useEffect(()=>{setStorageName(currentLibrary?.name||'');},[currentLibrary?.name,libraryId]);
  const renameLibrary=()=>run(async()=>{
    const value=await call('libraryRename',{name:storageName.trim()});
    setStorageName(value.name);await onLibrariesRefresh?.();
    setSuccess(t('资料库名称已更新。','Library name updated.'));
  });
  const clearTemporary=()=>{
    if(!window.confirm(t('仅清理超过 24 小时的临时分享缓存，不会删除资料库内容。继续吗？','Clear only temporary share files older than 24 hours? Library content will not be deleted. Continue?')))return;
    run(async()=>{const result=await call('storageClearTemporary');await refreshStorage();setSuccess(`${t('已清理临时文件：','Temporary files cleared: ')}${formatBytes(result.removedBytes,t)} · ${result.removedFiles||0} ${t('个文件','files')}`);});
  };
  useEffect(()=>{onNavigation?.({depth:Boolean(agentNode||management||externalNode||recoveryNode||managementNode||more||settingsPage!=='home'),back:()=>{
    if(management&&managementDetailBack.current){managementDetailBack.current();return;}
    if(pageState?.busy||busy){setMessage(t('当前操作尚未完成，请稍候。','Wait for the current operation to finish.'));return;}
    if(pageState?.dirty&&!window.confirm(t('放弃尚未保存的修改？','Discard unsaved changes?')))return;
    if(agentNode)setAgentNode(null);else if(management)setManagement(null);else if(externalNode)setExternalNode(null);else if(recoveryNode)setRecoveryNode(null);else if(managementNode)setManagementNode(null);else if(more)setMore(false);else setSettingsPage('home');
  }});});
  if (agentNode) return <AgentSettingsPanel node={agentNode} onBack={() => setAgentNode(null)} onStateChange={reportChildState}/>;
  if (management) return <ManagementPanel detailBackRef={managementDetailBack} node={management.node} section={management.section} onBack={() => setManagement(null)} onStateChange={reportChildState}/>;
  if (externalNode) return <ExternalAccessPanel node={externalNode} onBack={() => setExternalNode(null)} onStateChange={reportChildState}/>;
  if (recoveryNode) return <RecoveryPanel node={recoveryNode} libraryId={libraryId} onBack={() => setRecoveryNode(null)} onStateChange={reportChildState}/>;
  if (managementNode) return <section className="settings-page"><button className="text" onClick={()=>setManagementNode(null)}>‹ {t('返回设置','Back to Settings')}</button><h1>{t('服务工具','Service tools')}</h1><p className="secondary">{managementNode.name} · {managementNode.baseUrl}</p><div className="settings-menu">{[['plugins',t('插件','Plugins')],['schedules',t('自动化任务','Scheduled tasks')],['external',t('外部接入','External access')],['recovery',t('冲突与恢复','Conflicts and recovery')]].map(([key,label])=><button className="management-row" key={key} onClick={()=>{if(key==='plugins'||key==='schedules')setManagement({node:managementNode,section:key});if(key==='external')setExternalNode(managementNode);if(key==='recovery')setRecoveryNode(managementNode);}}><strong>{label}</strong><span>›</span></button>)}</div></section>;
  if (more) {const activeNode=nodes.find(node=>node.id===activeId);return <section className="settings-page"><div className="management-top"><button className="text" onClick={()=>setMore(false)}>‹ {t('返回设置','Back to Settings')}</button></div><h1>{t('更多','More')}</h1><p className="secondary">{t('当前已接入的页面与节点工具。','Available pages and tools for connected nodes.')}</p><section className="settings-card"><h2>{t('拾文','Shiwen')}</h2><div className="settings-menu">{[['chat',t('对话','Chat')],['notes',t('素材','Materials')]].map(([key,label])=><button key={key} className="management-row" onClick={()=>onNavigate?.(key)}><strong>{label}</strong><span>{t('打开页面　›','Open page　›')}</span></button>)}</div></section>{activeNode?<section className="settings-card"><h2>{t('服务节点','Server node')} · {activeNode.name}</h2><div className="settings-menu"><button className="management-row" onClick={()=>{setMore(false);setManagement({node:activeNode,section:'plugins'});}}><strong>{t('浏览插件','Browse plugins')}</strong><span>{t('搜索、安装及管理　›','Search, install, and manage　›')}</span></button><button className="management-row" onClick={()=>{setMore(false);setManagement({node:activeNode,section:'schedules'});}}><strong>{t('自动化任务','Scheduled tasks')}</strong><span>{t('查看与管理　›','View and manage　›')}</span></button><button className="management-row" onClick={()=>{setMore(false);setExternalNode(activeNode);}}><strong>{t('外部接入','External access')}</strong><span>{t('管理客户端凭据　›','Manage client credentials　›')}</span></button><button className="management-row" onClick={()=>{setMore(false);setRecoveryNode(activeNode);}}><strong>{t('初始化与恢复','Initialization and recovery')}</strong><span>{t('查看节点副本与分支恢复　›','Inspect replicas and recover branches　›')}</span></button></div></section>:<section className="settings-card"><h2>{t('插件、自动化任务与外部接入','Plugins, scheduled tasks, and external access')}</h2><p className="secondary">{t('添加并连接服务节点后可使用。','Add and connect a server to use these tools.')}</p></section>}</section>;}

  const pageRow=(label,summary,page,action)=> <button className="management-row" key={page} onClick={()=>action? action():setSettingsPage(page)}><strong>{label}</strong><span>{summary}　›</span></button>;
  if(settingsPage==='home') return <section className="settings-page" aria-label={t('设置','Settings')}>
    <h2 className="settings-group-title">{t('我的工作台','My workspace')}</h2><div className="settings-menu">
      {pageRow(t('模型','Model'),modelIsConfigured?t('已配置','Configured'):t('未配置','Not configured'),'model')}
      {pageRow(t('手机 Agent 与记忆','Phone agent and memory'),t('个性、资料与记忆','Profile and memory'),'local-agent')}
    </div>
    <h2 className="settings-group-title">{t('服务工具','Service tools')}</h2><div className="settings-menu">
      {pageRow(t('服务与同步','Services and sync'),`${nodes.length} ${t('个服务','services')}`,'services')}
      {pageRow(t('插件、自动化与外部接入','Plugins, automation and external access'),t('选择服务节点后管理','Choose a server to manage'),'node-tools',()=>{if(nodes.length===1)setManagementNode(nodes[0]);else setSettingsPage('choose-node');})}
    </div>
    <h2 className="settings-group-title">{t('应用','App')}</h2><div className="settings-menu">
      {pageRow(t('外观与语言','Appearance and language'),t('主题、显示语言','Theme and language'),'appearance')}
      {pageRow(t('导入与备份','Import and backup'),t('资料导入、导出与恢复','Import, export and restore'),'transfer')}
      {pageRow(t('分享收件箱','Share inbox'),t('查看待处理分享','Review incoming shares'),'inbox')}
      {pageRow(t('存储与资料库','Storage and library'),currentLibrary?.name||'','storage')}
      {pageRow(t('关于拾文','About Shiwen'),`Android · ${t('版本信息','Version information')}`,'about')}
    </div>
  </section>;
  if(settingsPage==='choose-node') return <section className="settings-page"><button className="text" onClick={()=>setSettingsPage('home')}>‹ {t('返回设置','Back to Settings')}</button><h1>{t('选择服务节点','Choose a server')}</h1><div className="settings-menu">{nodes.map(node=><button className="management-row" key={node.id} onClick={()=>setManagementNode(node)}><strong>{node.name}</strong><span>{node.baseUrl}　›</span></button>)}</div>{!nodes.length&&<p className="empty-state">{t('请先添加并连接服务节点。','Add and connect a server first.')}</p>}</section>;

  const pageTitles={appearance:t('外观与语言','Appearance and language'),model:t('模型','Model'), 'local-agent':t('手机 Agent 与记忆','Phone agent and memory'),services:t('服务与同步','Services and sync'),storage:t('存储与资料库','Storage and library'),transfer:t('导入与备份','Import and backup'),inbox:t('分享收件箱','Share inbox'),about:t('关于拾文','About Shiwen')};
  return <section className="settings-page" aria-label={t('设置','Settings')}>
    <button className="text" onClick={goSettingsHome}>‹ {t('返回设置','Back to Settings')}</button><h1>{pageTitles[settingsPage]}</h1>
    {settingsPage==='appearance'&&<section className="settings-card"><div className="settings-heading"><div><p className="secondary">{t('应用到拾文的所有页面。','Applies across Shiwen.')}</p></div></div><div className="appearance-grid"><label>{t('主题','Theme')}<select value={theme} disabled={!ready||busy||!appearanceReady} onChange={e=>saveAppearance({theme:e.target.value})}><option value="system">{t('系统','System')}</option><option value="light">{t('浅色','Light')}</option><option value="dark">{t('深色','Dark')}</option></select></label><label>{t('语言','Language')}<select value={language} disabled={!ready||busy||!appearanceReady} onChange={e=>saveAppearance({language:e.target.value})}><option value="zh-CN">{t('中文','Chinese')}</option><option value="en">{t('英文','English')}</option></select></label></div></section>}
    {settingsPage==='model'&&<><p className="secondary">{t('模型凭据由 Android 原生对话框管理，不会进入网页脚本。','Model credentials are managed in native Android dialogs and never enter the web page.')}</p>
    <section className="settings-card" aria-labelledby="model-settings-title">
      <div className="settings-heading"><div><h2 id="model-settings-title">{t('模型','Model')}</h2><p className="secondary">{t('用于手机上的 AI 对话，独立于电脑端配置。','Used for AI chat on this phone; separate from desktop settings.')}</p></div><span className={`state-pill ${modelIsConfigured ? 'is-ready' : ''}`}>{modelIsConfigured ? t('已配置','Configured') : t('未配置','Not configured')}</span></div>
      {modelIsConfigured && <dl className="settings-details"><div><dt>{t('服务商','Provider')}</dt><dd>{config.name}</dd></div><div><dt>{t('模型','Model')}</dt><dd>{config.model}</dd></div><div><dt>{t('接口地址','API endpoint')}</dt><dd>{config.baseUrl}</dd></div></dl>}
      <button className="primary" disabled={!ready || busy} onClick={configureModel}>{modelIsConfigured ? t('修改模型配置','Edit model settings') : t('配置模型','Configure model')}</button>
    </section></>}
    {settingsPage==='local-agent'&&<LocalAgentProfilePanel ready={ready} onPageStateChange={reportChildState}/>}
    {settingsPage==='services'&&<><section className="settings-card" aria-labelledby="node-settings-title">
      <div className="settings-heading"><div><h2 id="node-settings-title">{t('服务节点','Server nodes')}</h2><p className="secondary">{t('连接服务后同步人设配置。人设同步与资料库同步分别管理，资料库状态和操作见下方。','Connecting a server syncs its agent profile. Profile and library synchronization are managed separately below.')}</p></div></div>
      {activeId && <button className="chip local-profile" disabled={!ready || busy} onClick={selectPhoneProfile}>{t('仅使用手机人设','Use phone profile only')}</button>}
      {nodes.length > 0 ? <div className="node-list">{nodes.map(node => <article className="node-card" key={node.id}>
        <div className="settings-heading"><div><h3>{node.name}</h3><p className="secondary node-url">{node.baseUrl}</p></div>{node.refreshing && <span className="state-pill is-refreshing">{t('人设同步中','Syncing profile')}</span>}{!node.refreshing && activeId === node.id && <span className="state-pill is-ready">{t('当前节点','Active node')}</span>}</div>
        <dl className="settings-details"><div><dt>{t('认证状态','Authentication')}</dt><dd>{node.authenticated ? t('上次核验已通过','Last check passed') : t('尚未核验通过','Not verified')}</dd></div><div><dt>{t('人设同步','Profile sync')}</dt><dd>{node.refreshing ? t('正在更新助手配置','Updating agent profile') : syncText(node.profileSyncStatus,t)}</dd></div>{node.profileUpdatedAt && <div><dt>{t('人设更新时间','Profile updated')}</dt><dd>{displayDate(node.profileUpdatedAt)}</dd></div>}{Number.isInteger(node.profileMemoryCount) && <div><dt>{t('记忆条目','Memory items')}</dt><dd>{node.profileMemoryCount} {t('条','items')}</dd></div>}{node.lastCheckedAt && <div><dt>{t('上次核验','Last checked')}</dt><dd>{displayDate(node.lastCheckedAt)}</dd></div>}</dl>
        {node.profileRevision && <details><summary>{t('技术信息','Technical details')}</summary><p className="mono-value">{t('人设版本','Profile revision')}：{node.profileRevision}</p></details>}
        <div className="node-actions"><button className="chip" disabled={!ready || busy} onClick={() => checkNode(node.id)}>{t('检查连接','Check connection')}</button><button className="chip" disabled={!ready || busy} onClick={() => configureNode(node.id)}>{t('编辑登录','Edit sign-in')}</button>{activeId !== node.id && <button className="chip" disabled={!ready || busy} onClick={() => selectNode(node.id)}>{t('设为当前','Set active')}</button>}<button className="chip" disabled={!ready || busy} onClick={() => setAgentNode(node)}>{t('Agent 与记忆','Agent and memory')}</button><button className="text" disabled={!ready || busy} onClick={() => removeNode(node.id)}>{t('移除此节点','Remove this server')}</button></div>
        {nodeSync?.nodeId===node.id && <div className="sync-progress" role="status"><strong>{t('资料库同步','Library sync')} · {syncProgressText(nodeSync.state,t)}</strong>{nodeSync.phase&&<span>{syncPhaseText(nodeSync.phase,t)}</span>}{nodeSync.completed!=null&&<span>{nodeSync.total!=null?`${nodeSync.completed} / ${nodeSync.total}`:nodeSync.completed}</span>}{nodeSync.error&&<p>{nodeSync.error}</p>}{nodeSync.message&&<p>{nodeSync.message}</p>}</div>}
        <div className="settings-menu node-menu"><button className="management-row" disabled={!ready||busy} onClick={()=>setManagement({node,section:'plugins'})}><strong>{t('插件','Plugins')}</strong><span>{t('查看、安装与管理　›','View, install, and manage　›')}</span></button><button className="management-row" disabled={!ready||busy} onClick={()=>setManagement({node,section:'schedules'})}><strong>{t('自动化任务','Scheduled tasks')}</strong><span>{t('创建、编辑与查看执行历史　›','Create, edit, and review history　›')}</span></button><button className="management-row" disabled={!ready||busy} onClick={()=>setExternalNode(node)}><strong>{t('外部接入','External access')}</strong><span>{t('管理客户端凭据　›','Manage client credentials　›')}</span></button><button className="management-row" disabled={!ready||busy} onClick={()=>setRecoveryNode(node)}><strong>{t('初始化与恢复','Initialization and recovery')}</strong><span>{t('查看节点副本与分支恢复　›','Inspect replicas and recover branches　›')}</span></button></div>
      </article>)}</div> : <p className="empty-state">{t('还没有服务节点。添加并连接节点后，才能管理该节点的拾文助手与全局记忆。','No server is connected. Add one to manage its Shiwen agent and global memory.')}</p>}
      <button className="primary" disabled={!ready || busy || !nativeAvailable} onClick={() => configureNode(null)}>{t('添加服务节点','Add server')}</button>
    </section><LibraryReplicaPanel key={`${libraryId}:${registryGeneration}`} ready={ready} libraryId={libraryId} libraryContext={libraryContext} nodes={nodes} onLibraryChange={onLibraryChange} onPageStateChange={reportChildState}/></>}
    {settingsPage==='storage'&&<section className="settings-card storage-settings">
      <div className="settings-heading"><div><h2>{t('存储与资料库','Storage and library')}</h2><p className="secondary">{t('查看本机空间占用，管理当前资料库名称与临时分享缓存。','Review local storage, rename this library, and clear temporary share files.')}</p></div><button className="chip" disabled={!ready||busy} onClick={refreshStorage}>{t('刷新','Refresh')}</button></div>
      <label>{t('资料库名称','Library name')}<div className="storage-rename-row"><input value={storageName} maxLength={80} disabled={!ready||busy} onChange={event=>setStorageName(event.target.value)}/><button className="chip" disabled={!ready||busy||!storageName.trim()||storageName.trim()===currentLibrary?.name} onClick={renameLibrary}>{t('保存名称','Save name')}</button></div></label>
      <dl className="settings-details storage-details"><div><dt>{t('当前资料库占用','Current library')}</dt><dd>{formatBytes(storage?.libraryBytes,t)}</dd></div><div><dt>{t('附件占用','Attachments')}</dt><dd>{formatBytes(storage?.attachmentBytes,t)}</dd></div><div><dt>{t('手机可用空间','Available on device')}</dt><dd>{formatBytes(storage?.availableBytes,t)}</dd></div><div><dt>{t('手机总空间','Device capacity')}</dt><dd>{formatBytes(storage?.totalBytes,t)}</dd></div><div><dt>{t('记录 / 版本','Records / versions')}</dt><dd>{storage?`${storage.recordCount} / ${storage.versionCount}`:t('读取中','Loading')}</dd></div><div><dt>{t('过期分享缓存','Expired share cache')}</dt><dd>{formatBytes(storage?.expiredShareBytes,t)}</dd></div></dl>
      <button className="chip" disabled={!ready||busy||!storage?.expiredShareBytes} onClick={clearTemporary}>{t('清理超过 24 小时的分享缓存','Clear share cache older than 24 hours')}</button>
    </section>}
    {settingsPage==='transfer'&&<LibraryTransferPanel ready={ready} libraryId={libraryId} onPageStateChange={reportChildState} onLibrariesRefresh={refreshAfterRestore}/>}
    {settingsPage==='inbox'&&<ShareInboxPanel ready={ready} libraryId={libraryId} libraries={libraries} onPageStateChange={reportChildState}/>}
    {settingsPage==='about'&&<section className="settings-card"><h2>拾文</h2><p>Android · 0.1.0-dev.1</p></section>}
    {feedback && <p className={feedback.kind==='success'?'success-note':'error'} role={feedback.kind==='success'?'status':'alert'}>{message}</p>}
  </section>;
}
