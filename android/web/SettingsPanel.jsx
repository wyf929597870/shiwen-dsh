import {MessageDialog} from './MessageDialog.jsx';
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {call} from '../bridge/library.mjs';
import {LibraryReplicaPanel} from './LibraryReplicaPanel.jsx';
import {ShareInboxPanel} from './ShareInboxPanel.jsx';
import {applyAppearance,setLanguage,useI18n} from './i18n.js';
import {syncCompletionMessage} from './sync-summary.mjs';
import './settings-translations.mjs';
import './settings-redesign.css';

const syncText = (value,t) => ({synced:t('人设已同步','Persona synced'), cached:t('仅有上次缓存','Last verified snapshot cached'), 'not-synced':t('尚未同步','Not synced')}[value] || value || t('尚无同步记录','No sync record yet'));
const syncProgressText = (value,t) => ({queued:t('排队中','Queued'),running:t('同步中','Syncing'),completed:t('已完成','Completed'),failed:t('失败','Failed'),cancelled:t('已取消','Cancelled'),paused:t('已暂停','Paused'),error:t('出错','Error'),initializing:t('初始化中','Initializing'),idle:t('空闲','Idle')}[value]||value||t('状态未知','Unknown status'));
const displayDate = value => { if (!value || value === 'null') return ''; const date = new Date(value); return Number.isNaN(date.getTime()) ? value : date.toLocaleString(); };
const syncPhaseText = (value,t) => ({identity:t('核对服务身份','Checking server identity'),bootstrap:t('读取资料库','Reading library'),push:t('上传本机更改','Uploading local changes'),receipts:t('核对写入回执','Checking write receipts'),pull:t('接收更新','Receiving updates'),attachments:t('传输附件','Transferring attachments'),ack:t('确认同步进度','Confirming sync progress'),finalize:t('完成收尾','Finalizing')}[value]||value||'');
const nodeStatus=(node,t)=>({online:t('在线','Online'),'login-required':t('在线 · 需要登录','Online · sign in required'),offline:t('服务节点离线','Server offline'),'no-network':t('手机网络不可用','No network'),'identity-mismatch':t('服务身份不匹配','Server identity mismatch'),'service-error':t('服务响应异常','Service error'),checking:t('正在检查连接','Checking connection')}[node.connectionState]||t('尚未检查','Not checked'));
const serviceErrorText = (error,t) => ({NODE_MANAGEMENT_API_UNSUPPORTED:t('此服务器的拾文插件版本较旧，请更新服务器端拾文插件后重试。','This server has an older Shiwen plugin. Update it and try again.'),NODE_AUTH_REQUIRED:t('登录状态已失效，请返回设置重新登录。','Sign-in expired. Sign in again in Settings.')}[error?.code] || error?.message || t('请求失败，请检查服务连接后重试。','Request failed. Check the server connection and try again.'));


export function SettingsPanel({ready, libraryId, libraries=[], libraryContext, config, onConfig, onPageStateChange, pageState, onNavigation, onNavigate, onLibraryChange, onLibrariesRefresh, initialPage='home'}) {
  const {language,t}=useI18n();
  const [nodes, setNodes] = useState([]), [activeId, setActiveId] = useState(null);
  const [discovered,setDiscovered]=useState([]);
  const [settingsPage, setSettingsPage] = useState(initialPage);
  const [pendingShares,setPendingShares]=useState(null);
  useEffect(()=>{if(!ready||settingsPage!=='home')return;let active=true;call('shareInboxList').then(result=>{if(active)setPendingShares((result.items||[]).length);}).catch(()=>{if(active)setPendingShares(null);});return()=>{active=false;};},[ready,settingsPage]);
  const [registryGeneration,setRegistryGeneration]=useState(0);
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
      setNodes(snapshot.items || []); setDiscovered(snapshot.discovered||[]); setActiveId(snapshot.activeId ?? null); setNativeAvailable(true);
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
  useEffect(()=>{
    if(!ready)return;
    const timer=setInterval(()=>{if(document.visibilityState==='visible')refreshNodes();},5000);
    return ()=>clearInterval(timer);
  },[ready,refreshNodes]);
  const scanNode=id=>run(async()=>{await call('nodeScan',id?{id}:{});await refreshNodes();});
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
    setNodes(snapshot.items || []); setDiscovered(snapshot.discovered||[]); setActiveId(snapshot.activeId ?? null);
  });
  const checkNode = id => run(async () => {
    try {
      const snapshot = await call('nodeCheck', {id});
      setNodes(snapshot.items || []); setDiscovered(snapshot.discovered||[]); setActiveId(snapshot.activeId ?? null);
      if(snapshot.syncError)setMessage(`${t('连接已核验，但资料库同步未能启动：','Connection verified, but library sync could not start: ')}${snapshot.syncError}`);
      else if(snapshot.sync?.operationId)await pollNodeSync(id,snapshot.sync.libraryId,snapshot.sync.operationId,snapshot.sync.state);
    } catch (error) {
      await refreshNodes();
      throw error;
    }
  });
  const removeNode = id => {
    if (!window.confirm(t('从此手机移除此服务节点？服务端资料不会被删除。','Remove this server from the phone? Its server data will not be deleted.'))) return;
    run(async () => {
      const snapshot = await call('nodeRemove', {id});
      setNodes(snapshot.items || []); setDiscovered(snapshot.discovered||[]); setActiveId(snapshot.activeId ?? null);
    });
  };
  const modelIsConfigured = Boolean(config?.configured);
  const saveAppearance=(patch)=>run(async()=>{const value=await call('settingsUpdate',patch);setTheme(value.theme||theme);setLanguage(value.language||language);applyAppearance(value.theme||theme,value.systemDark);});

  const childOwner=`page:${settingsPage}`;
  const activeOwner=useRef(childOwner);activeOwner.current=childOwner;
  const reportChildState = useCallback(state => {if(activeOwner.current===childOwner)onPageStateChange?.(state);}, [onPageStateChange,childOwner]);
  const goSettingsHome=()=>{if(busy||pageState?.busy){setMessage(t('当前操作尚未完成，请稍候。','Wait for the current operation to finish.'));return;}if(pageState?.dirty&&!window.confirm(t('放弃尚未保存的修改？','Discard unsaved changes?')))return;if(initialPage!=='home'&&settingsPage===initialPage)onNavigate?.('chat');else setSettingsPage('home');};
  useEffect(()=>{onNavigation?.({depth:settingsPage!=='home'&&settingsPage!==initialPage,back:goSettingsHome});});
  const pageRow=(label,summary,page,action)=> <button className="management-row" key={page} onClick={()=>action? action():setSettingsPage(page)}><strong>{label}</strong><span>{summary}　›</span></button>;
  if(settingsPage==='home') return <section className="settings-page" aria-label={t('设置','Settings')}>
    <h2 className="settings-group-title">{t('服务工具','Service tools')}</h2><div className="settings-menu">
      {pageRow(t('资料库同步','Library sync'),t('同步状态与冲突处理','Sync status and conflicts'),'replica')}
      {pageRow(t('服务节点','Server nodes'),`${nodes.length} ${t('个服务','services')}`,'services')}
    </div>
    <h2 className="settings-group-title">{t('应用','App')}</h2><div className="settings-menu">
      {pageRow(t('外观与语言','Appearance and language'),t('主题、显示语言','Theme and language'),'appearance')}
      {pendingShares!==0&&pageRow(t('处理旧分享','Review old shares'),pendingShares==null?t('查看待处理内容','Check pending items'):`${pendingShares} ${t('项待处理','pending')}`,'inbox')}
    </div>
    {feedback&&<MessageDialog message={message} onClose={()=>setFeedback(null)}/>}
  </section>;

  return <section className="settings-page" aria-label={t('设置','Settings')}>
    {!(settingsPage===initialPage&&initialPage!=='home')&&<button className="text settings-back" onClick={goSettingsHome}>‹ {t('返回设置','Back to Settings')}</button>}
    {settingsPage==='appearance'&&<section className="settings-card"><div className="settings-heading"><div><p className="secondary">{t('应用到拾文的所有页面。','Applies across Shiwen.')}</p></div></div><div className="appearance-grid"><label>{t('主题','Theme')}<select value={theme} disabled={!ready||busy||!appearanceReady} onChange={e=>saveAppearance({theme:e.target.value})}><option value="system">{t('系统','System')}</option><option value="light">{t('浅色','Light')}</option><option value="dark">{t('深色','Dark')}</option></select></label><label>{t('语言','Language')}<select value={language} disabled={!ready||busy||!appearanceReady} onChange={e=>saveAppearance({language:e.target.value})}><option value="zh-CN">{t('中文','Chinese')}</option><option value="en">{t('英文','English')}</option></select></label></div></section>}
    {settingsPage==='model'&&<><p className="secondary">{t('模型凭据由 Android 原生对话框管理，不会进入网页脚本。','Model credentials are managed in native Android dialogs and never enter the web page.')}</p>
    <section className="settings-card" aria-labelledby="model-settings-title">
      <div className="settings-heading"><div><h2 id="model-settings-title">{t('模型','Model')}</h2><p className="secondary">{t('用于手机上的 AI 对话，独立于电脑端配置。','Used for AI chat on this phone; separate from desktop settings.')}</p></div><span className={`state-pill ${modelIsConfigured ? 'is-ready' : ''}`}>{modelIsConfigured ? t('已配置','Configured') : t('未配置','Not configured')}</span></div>
      {modelIsConfigured && <dl className="settings-details"><div><dt>{t('服务商','Provider')}</dt><dd>{config.name}</dd></div><div><dt>{t('模型','Model')}</dt><dd>{config.model}</dd></div><div><dt>{t('接口地址','API endpoint')}</dt><dd>{config.baseUrl}</dd></div></dl>}
      <button className="primary" disabled={!ready || busy} onClick={configureModel}>{modelIsConfigured ? t('修改模型配置','Edit model settings') : t('配置模型','Configure model')}</button>
    </section></>}
    {settingsPage==='services'&&<section className="server-settings" aria-label={t('服务节点','Server nodes')}>
      {nodes.length > 0 ? <div className="node-list">{nodes.map(node => <article className="node-card" key={node.id}>
        <div className="settings-heading"><div><h3>{node.name}</h3><p className="secondary node-url">{node.baseUrl}</p></div>{node.refreshing && <span className="state-pill is-refreshing">{t('人设同步中','Syncing profile')}</span>}{!node.refreshing && activeId === node.id && <span className="state-pill is-ready">{t('当前节点','Active node')}</span>}</div>
        <dl className="settings-details server-status"><div><dt>{t('连接状态','Connection')}</dt><dd>{nodeStatus(node,t)}</dd></div><div><dt>{t('认证状态','Authentication')}</dt><dd>{node.authenticated ? t('上次核验已通过','Last check passed') : t('尚未核验通过','Not verified')}</dd></div><div><dt>{t('人设同步','Profile sync')}</dt><dd>{node.refreshing ? t('正在更新助手配置','Updating agent profile') : syncText(node.profileSyncStatus,t)}</dd></div>{Number.isInteger(node.profileMemoryCount) && <div><dt>{t('记忆条目','Memory items')}</dt><dd>{node.profileMemoryCount} {t('条','items')}</dd></div>}</dl>
        {!node.fingerprint&&<p className="secondary">{t('此节点使用旧连接。扫描服务电脑的配对码后，可自动发现与切换地址。','Pair with the server to enable discovery and address switching.')}</p>}
        {node.endpoints?.length>1&&<details><summary>{t('备用地址','Backup addresses')} · {node.endpoints.length-1}</summary>{node.endpoints.filter(url=>url!==node.baseUrl).map(url=><p className="node-url" key={url}>{url}</p>)}</details>}
        <div className="node-actions server-actions"><button className="chip" disabled={!ready||busy} onClick={()=>scanNode(node.id)}>{t(node.fingerprint?'重新配对':'扫码升级连接',node.fingerprint?'Pair again':'Pair secure connection')}</button>
        <button className="chip" disabled={!ready || busy} onClick={() => checkNode(node.id)}>{t('检查连接','Check connection')}</button><button className="chip" disabled={!ready || busy} onClick={() => configureNode(node.id)}>{t('编辑登录','Edit sign-in')}</button>{activeId !== node.id && <button className="chip" disabled={!ready || busy} onClick={() => selectNode(node.id)}>{t('设为当前','Set active')}</button>}<button className="chip danger" disabled={!ready || busy} onClick={() => removeNode(node.id)}>{t('移除此节点','Remove this server')}</button></div>
        {nodeSync?.nodeId===node.id && <div className="sync-progress" role="status"><strong>{t('资料库同步','Library sync')} · {syncProgressText(nodeSync.state,t)}</strong>{nodeSync.phase&&<span>{syncPhaseText(nodeSync.phase,t)}</span>}{nodeSync.completed!=null&&<span>{nodeSync.total!=null?`${nodeSync.completed} / ${nodeSync.total}`:nodeSync.completed}</span>}{nodeSync.error&&<p>{nodeSync.error}</p>}{nodeSync.message&&<p>{nodeSync.message}</p>}</div>}
      </article>)}</div> : <p className="empty-state">{t('还没有服务节点。添加并连接节点后，才能管理该节点的拾文助手与全局记忆。','No server is connected. Add one to manage its Shiwen agent and global memory.')}</p>}
      {discovered.length>0&&<p className="secondary">{t('发现局域网拾文入口','Discovered Shiwen endpoints')} · {discovered.length} {t('个，请扫描服务电脑的配对码确认身份。','— scan the server pairing code to verify its identity.')}</p>}
      <div className="node-actions server-add"><button className="primary" disabled={!ready||busy||!nativeAvailable} onClick={()=>scanNode(null)}>{t('扫码连接服务','Scan to connect')}</button>
      <button className="chip" disabled={!ready || busy || !nativeAvailable} onClick={() => configureNode(null)}>{t('添加服务节点','Add server')}</button></div>
    </section>}
    {settingsPage==='replica'&&<LibraryReplicaPanel key={`${libraryId}:${registryGeneration}`} ready={ready} libraryId={libraryId} libraryContext={libraryContext} nodes={nodes} onLibraryChange={onLibraryChange} onPageStateChange={reportChildState}/>}
    {settingsPage==='inbox'&&<ShareInboxPanel ready={ready} libraryId={libraryId} libraries={libraries} onPageStateChange={reportChildState}/>}
    {feedback&&<MessageDialog message={message} onClose={()=>setFeedback(null)}/>}
  </section>;
}
