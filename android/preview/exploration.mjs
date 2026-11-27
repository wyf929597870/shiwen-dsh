// Isolated in-memory data for the static phone preview.
import {library,records} from './fixtures.mjs';
const byId=new Map(),receipts=new Map(),jobs=new Map();
let config={libraryId:library.libraryId,enabled:false,revision:1,poolBased:true},discovery={enabled:true,model:false,revision:1};
const day=new Date().toISOString().slice(0,10);
const weekDate=new Date(day+'T12:00:00Z');weekDate.setUTCDate(weekDate.getUTCDate()-(weekDate.getUTCDay()+6)%7);
const week=weekDate.toISOString().slice(0,10);
function add(id,text,r,type='explore'){
 const q={libraryId:library.libraryId,questionId:id,revision:1,type,text,originalText:text,status:'pending',possibleDuplicates:[],mergedQuestions:[],responses:[],steps:[],nextStep:null,
  sources:[{recordId:r.id,revision:r.revision,kind:r.kind,title:r.title,scope:'record',label:'来自这篇记录',personal:true,hasPersonal:true}],
  placements:{day:{key:day,revision:0,pinned:false},week:{key:week,revision:0,pinned:false}}};
 byId.set(id,q);return q;
}
add('preview-exploration','下一次读到这里，想接着写些什么？',records[0]);
function dispatch(method,a){
 const q=byId.get(a.questionId??a.cardId);
 const list=[...byId.values()];
 const card=q=>({...q,cardId:q.questionId,question:q.text,scene:q.type,quotes:[],quoteCount:q.sources.length});
 switch(method){
  case 'themeContext':return {libraryId:library.libraryId};
  case 'explorationSyncStatus':return {role:'standalone',items:[]};
  case 'shiwen_exploration_list':return {items:list.filter(q=>(!a.recordId||q.sources.some(s=>s.recordId===a.recordId))&&(!a.type||q.type===a.type)&&
   ({raw:q.status==='pending',accepted:['accepted','observing','answered'].includes(q.status),skipped:q.status==='skipped',all:true}[a.view??'raw'])),nextCursor:null};
  case 'shiwen_exploration_read':return q;
  case 'shiwen_exploration_suggest':return {items:a.suggestions.map(s=>{const r=records.find(r=>r.id===s.sources[0].recordId);
   return {status:'created',questionId:add(s.externalItemId,s.text,r,s.type).questionId};})};
  case 'shiwen_exploration_review':
   if(a.text)q.text=a.text;
   q.status={accept:'accepted',continue:'accepted',rewrite:'accepted',observe:'observing',skip:'skipped',restore:'pending',answered:'answered'}[a.action]??q.status;
   q.revision++;return q;
  case 'shiwen_exploration_place':
   q.placements[a.period].pinned=a.action!=='unpin';q.placements[a.period].revision++;if(a.accept){q.status='accepted';q.revision++;}return q;
  case 'shiwen_exploration_respond':q.responses.unshift({recordId:a.responseRecordId,revision:a.sourceRevision??1,title:'示例回应',preview:a.body??a.passage?.quote,contentDay:day});q.revision++;return q;
  case 'shiwen_exploration_step':{
   if(q.revision!==a.expectedRevision)throw Error('问题已更新');
   if(a.accept&&q.status==='pending')q.status='accepted';
   if(q.status!=='accepted')throw Error('请先收下这个问题');
   let step=q.steps.find(s=>s.id===a.stepId);
   if(a.action==='add'){
    step={id:a.stepId,kind:a.kind,text:a.text,created:Date.now()};
    for(const k of ['parentId','responseId','quote','observation','reviewDay','takeaway'])if(a[k])step[k]=a[k];
    q.steps.push(step);
   }
   if(!step)throw Error('这一步已变化');
   for(const s of q.steps)s.selected=0;
   q.nextStep=a.action==='pause'?null:step;if(q.nextStep)step.selected=Date.now();
   q.revision++;return q;
  }
  case 'explorationRecordSearch':return {items:records.slice(0,8).map(r=>({...r,excerpt:r.markdown})),nextOffset:null};
  case 'shiwen_recommendation_settings':
   if(a.enabled!==undefined)config={...config,enabled:a.enabled,revision:config.revision+1};
   return {...config,week};
  case 'shiwen_recommendation_list':{
   const inPeriod=p=>list.filter(q=>q.status==='accepted'&&(q.placements[p].pinned||(!q.nextStep?.reviewDay||q.nextStep.reviewDay<=day)&&(q.nextStep||config.enabled))).slice(0,p==='day'?2:10).map(card);
   return {items:inPeriod(a.view==='daily'?'day':'week'),daily:inPeriod('day'),libraryId:library.libraryId,day,week,todayCount:0,nextCursor:null};
  }
  case 'shiwen_recommendation_read':return card(q);
  case 'shiwen_exploration_settings':
   if(a.requestId)discovery={...discovery,...(a.model!==undefined?{model:a.model}:{}),...(a.enabled!==undefined?{enabled:a.enabled}:{}),revision:discovery.revision+1};
   return discovery;
  case 'shiwen_exploration_import':case 'shiwen_recommendation_refresh':
   jobs.set(a.requestId,{jobId:a.requestId,status:'ready',result:{changed:0},progress:{total:0,scanned:0,checked:0,created:0,needs_review:0,retry:0}});
   return {jobId:a.requestId};
  case 'shiwen_assist_result':return jobs.get(a.jobId);
  default:throw Error('预览未提供此操作');
 }
}
export function previewExploration(method,args){
 if(args.expectedLibraryId&&args.expectedLibraryId!==library.libraryId)throw Error('资料库已切换');
 if(args.requestId&&receipts.has(args.requestId))return structuredClone(receipts.get(args.requestId));
 const result=structuredClone(dispatch(method,args));
 if(args.requestId)receipts.set(args.requestId,result);
 return result;
}
