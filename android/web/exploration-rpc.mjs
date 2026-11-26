import {mobileRecommendationRpc} from './phone-recommendations.mjs';
// Pool operations always enter the scoped Room transaction. The paired host owns
// its discovery settings, jobs and the selection of automatic home cards.
export function explorationRpc(call,workspace){
 const {libraryId,role}=workspace;
 const history=mobileRecommendationRpc(call,libraryId,role,{serverId:workspace.serverId,epoch:workspace.epoch,state:workspace.connectionState});
 const local=async(method,args)=>(await call('explorationCall',{libraryId,method,args})).result;
 const remote=async(method,args)=>(await call('workspaceRemote',{libraryId,method,args})).result;
 return async(method,args={})=>{
  if(args.expectedLibraryId&&args.expectedLibraryId!==libraryId)throw Error('资料库已切换，请重新打开');
  if(role!=='standalone'&&['login-required','identity-mismatch'].includes(workspace.connectionState))throw Error('请先重新验证这台电脑，再打开探索池。');
  if(method==='shiwen_recommendation_feedback_list'||method==='shiwen_recommendation_feedback'||
   ['shiwen_assist_add_to_theme','shiwen_assist_create_draft','shiwen_assist_save_decision'].includes(method)||
   method==='shiwen_recommendation_list'&&['later','today'].includes(args.view))return history(method,args);
  if(method==='shiwen_recommendation_read'){
   try{return await local(method,args);}catch(e){if(!/QUESTION_MISSING/.test(e.message))throw e;return history(method,args);}
  }
  if(role!=='standalone'){
   if(method==='shiwen_recommendation_settings'&&!Object.hasOwn(args,'enabled')){
    const c=await local(method,args);
    return {...c,offline:!workspace.online,coordinated:true};
   }
   if(method==='shiwen_recommendation_refresh'){
    const state=await local('explorationSyncStatus',{});
    if(!workspace.online||state.status?.state!=='online')return local(method,args);
    const response=await remote(method,args);
    await call('syncNow',{libraryId,mode:'auto'}).catch(()=>{});
    return response;
   }
   if(method==='shiwen_exploration_import'||method==='shiwen_exploration_settings'||method==='shiwen_recommendation_settings'||
    method==='shiwen_assist_result'&&!args.jobId?.startsWith('arrange-')){
    if(!workspace.online)throw Error('连接电脑后可以查看或更改后台整理。');
    return remote(method,args);
   }
  }
  const result=await local(method,args);
  if(method==='shiwen_recommendation_list'&&['week','daily'].includes(args.view)){
   if(role==='standalone'){
    const legacy=await history(method,{view:'today'});result.todayCount=legacy.todayCount??0;
   }else{
    result.offline=!workspace.online;
    const state=await local('explorationSyncStatus',{});
    result.lastSync=state.status?.lastSync;
   }
  }
  return result;
 };
}
