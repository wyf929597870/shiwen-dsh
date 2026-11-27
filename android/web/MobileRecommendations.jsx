import {MoreRows} from '../../plugins/workbench/src/ListInteractions.jsx';
import React,{useMemo,useState,useEffect} from 'react';
import {Recommendations} from '../../plugins/workbench/src/Recommendations.jsx';
import {WorkspaceSource} from './MobileWorkspace.jsx';
import {call} from '../bridge/library.mjs';
import {explorationRpc} from './exploration-rpc.mjs';
import {ExplorationEntry} from '../../plugins/workbench/src/Exploration.jsx';
export function MobileRecommendations({workspace,onTheme,opening}){
  const {libraryId,role}=workspace;
  const [source,setSource]=useState(null);
  const rpc=useMemo(()=>explorationRpc(call,workspace),[libraryId,role,workspace.online,workspace.serverId,workspace.epoch,workspace.connectionState]);
  const [sync,setSync]=useState(null),[syncError,setSyncError]=useState('');
  useEffect(()=>{
    setSync(null);setSyncError('');setTargets(null);setSource(null);
    if(role==='standalone')return;
    let live=true,prior;
    const load=async()=>{try{const next=await rpc('explorationSyncStatus');if(!live)return;
      setSyncError('');const signature=JSON.stringify(next);if(signature!==prior){prior=signature;setSync(next);window.dispatchEvent(new Event('shiwen-library-updated'));}}
      catch(e){if(live)setSyncError(e.message);}};
    void load();const timer=setInterval(load,2000);return()=>{live=false;clearInterval(timer);};
  },[rpc,role]);
  const [targets,setTargets]=useState(null);
  async function choose(intent){
   try{const res=await rpc('shiwen_exploration_list',{expectedLibraryId:libraryId,view:'all',cursor:targets?.id===intent.id?targets.cursor??0:0});
    setTargets({id:intent.id,items:[...(targets?.id===intent.id?targets.items:[]),...res.items],cursor:res.nextCursor});
   }catch(e){setSyncError(e.message);}
  }
  async function resolve(intent,choice,target){
   try{const receipt=intent.receipt;
    await rpc('explorationConflictResolve',{expectedLibraryId:libraryId,operationId:intent.id,conflictId:receipt.conflictId,choice,questionId:target?.questionId,expectedTargetRevision:target?.revision??receipt.targetRevision});
    setSync(await rpc('explorationSyncStatus'));setTargets(null);setSyncError('');
   }catch(e){setSyncError(e.message);}
  }
  const sourceWorkspace=useMemo(()=>({...workspace,rpc:role==='standalone'?workspace.rpc:async(method,args={})=>{
    if(method.startsWith('theme'))return workspace.rpc(method,args);
    if(method==='readMarkdown'){
      try{return await workspace.rpc(method,args);}catch(e){if(!workspace.online)throw Error('这篇原文尚未同步到手机，请先连接电脑。');}
    }
    return (await call('workspaceRemote',{libraryId,method,args})).result;
  }}),[workspace.rpc,role,libraryId,workspace.source,workspace.explore,workspace.online]);
  function openSource(id,match){setSource({id,match});}
  async function openTarget(id,section,edit){
    if(edit&&section==='articles'){
      try{const row=await call('recordRead',{libraryId,id});if(!row.deleted)return workspace.onArticle(id);}catch{/* A server draft may still be syncing. */}
    }
    openSource(id);
  }
  return <section className="phone-recommendations"><div className="phone-pool"><p className="secondary">{role==='standalone'?'当前手机资料库':'已绑定电脑的资料库 · 与电脑共用推荐'}</p>
    <ExplorationEntry compact rpc={rpc} layout={{openSource}}/></div>
    {sync?.status?.state==='upgrade_required'&&<p role="status">探索同步需升级电脑</p>}
    {sync?.status?.state==='offline'&&<p role="status">暂时无法连接电脑，正在显示手机已有的内容。</p>}
    {sync?.items?.map(intent=><div key={intent.id}>{intent.state==='conflict'?<><p>本机操作「{intent.operation.args.action}」对应的问题已经变化。{intent.originalText} → {intent.receipt.targetText||intent.receipt.target}</p>
      <button onClick={()=>resolve(intent,'abandon')}>{intent.receipt.code==='question_missing'?'保留正文，放弃关联':'保留当前问题'}</button>
      {intent.receipt.code==='question_missing'&&intent.dependency&&<><button onClick={()=>choose(intent)}>选择其他问题</button>
      {targets?.id===intent.id&&targets.items.map(q=><button key={q.questionId} onClick={()=>resolve(intent,'replace',q)}>关联到「{q.text}」</button>)}
      {targets?.id===intent.id&&targets.cursor!=null&&<MoreRows cursor={targets.cursor} onClick={()=>choose(intent)}>加载更多</MoreRows>}</>}
      {intent.receipt.targetRevision&&intent.receipt.code!=='placement_full'&&<button onClick={()=>resolve(intent,'replace')}>{intent.operation.args.action==='skip'?'也略过当前问题':'在当前问题上重新应用'}</button>}</>:
      <small>{intent.state==='sent'?'等待提交回执':intent.state==='resolving'?'正在确认处理结果':intent.dependency?'正文已保存，关联待同步':'待同步'}</small>}</div>)}
    {syncError&&<p role="alert">{syncError}</p>}
    <Recommendations key={[libraryId,role,workspace.serverId,workspace.epoch,workspace.connectionState].join('/')} rpc={rpc} showAssist={false} opening={opening} layout={{openSource,openTarget,openTheme:onTheme}}/>
    {sync?.status?.lastSync&&<small className="phone-last-sync">上次同步 · {new Date(sync.status.lastSync).toLocaleString()}</small>}
    {source&&<WorkspaceSource workspace={sourceWorkspace} id={source.id} match={source.match} onClose={()=>setSource(null)}/>}
  </section>;
}

export function MobileExplorationEntry({workspace,record}){
 const [source,setSource]=useState(null);
 const rpc=useMemo(()=>explorationRpc(call,workspace),[workspace.libraryId,workspace.role,workspace.online,workspace.serverId,workspace.epoch,workspace.connectionState]);
 return <><ExplorationEntry compact rpc={rpc} layout={{openSource:(id,match)=>setSource({id,match})}}
   recordId={record?.id} revision={record?.syncState==='synced'?record.serverRevision??record.revision:record?.revision} sourceLibraryId={workspace.libraryId}/>
 {source&&<WorkspaceSource workspace={workspace} id={source.id} match={source.match} onClose={()=>setSource(null)}/>}</>;
}
