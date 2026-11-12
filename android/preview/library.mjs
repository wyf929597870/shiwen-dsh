import {library,records as initial} from './fixtures.mjs';
export const isNative=true;
export const leaveApp=async()=>{};
let records=[...initial],appearance={theme:'light',language:'zh-CN'},draft=null,previewConflictRefreshed=false;
const scenario=new URLSearchParams(location.search).get('scenario')||'normal';
let conversations=[{id:'preview-chat',title:'新会话',updatedAt:'2026-11-01T08:00:00Z'}];
export async function bootstrap(){return {...library};}
export async function call(method,args={}){
  if(scenario==='error'&&['recordList','review'].includes(method))throw Error('模拟读取失败');
  switch(method){
    case 'libraryList':return {items:[library],activeId:library.libraryId};
    case 'recordDraftRead':return {draft,nextGeneration:0};
    case 'recordDraftSave':draft={requestId:args.requestId,localGeneration:args.localGeneration,content:args.content};return {};
    case 'recordDraftAcknowledge':draft=null;return {cleared:true};
    case 'readDraft':return {draft:null};
    case 'modelConfig':return scenario==='chat'?{configured:true,revision:1}:{configured:false};
    case 'settingsGet':return appearance;
    case 'settingsUpdate':appearance={...appearance,...args};return appearance;
    case 'nodeList':return scenario==='service'?{items:[{id:'preview-node',name:'示例电脑',baseUrl:'https://example.local:3081/',connectionState:'online',authenticated:true,profileSyncStatus:'synced',profileMemoryCount:3,fingerprint:'preview',endpoints:['https://example.local:3081/']}],activeId:'preview-node'}:{items:[],activeId:null};
    case 'agentConversations':return {items:conversations,activeId:'preview-chat'};
    case 'agentReadDraft':return {draft:null};
    case 'agentRecent':return {items:scenario==='chat'?[{id:'sample-turn-2',input:'看安排什么时候改一下',output:'好的，排好计划，我再跟你说。',status:'succeeded'},{id:'sample-turn-1',input:'这个想法帮我记一下',output:'好的，已记录。',status:'succeeded'}]:[],nextOffset:null};
    case 'agentRecordProposals':return {items:[]};
    case 'agentSaveDraft':return {};
    case 'recordList':{
      let rows=scenario==='empty'?[]:records.filter(r=>(!args.kind||r.kind===args.kind)&&(!args.excludeKind||r.kind!==args.excludeKind)&&(!args.query||r.title.includes(args.query)||r.markdown.includes(args.query)));
      const offset=Number(args.cursor||0),limit=args.limit||30;return {items:rows.slice(offset,offset+limit),nextCursor:offset+limit<rows.length?String(offset+limit):null};
    }
    case 'recordCreate':{const row={...args.record,id:crypto.randomUUID(),revision:1};records.unshift(row);return {record:row,syncState:'local-only'};}
    case 'recordRead':{const row=records.find(r=>r.id===args.id);if(!row)throw Error('预览记录不存在');return {...row};}
    case 'recordAttachments':return {items:[]};
    case 'recordVersions':return {items:[],nextCursor:null};
    case 'review':return {totals:{added:124,personalRecords:3,collected:2,articles:1},daily:[],isComplete:true};
    case 'localProfileRead':return {revision:1,identity:'拾文助手',soul:'温和而诚实',user:'',memories:[]};
    case 'storageInfo':return {};
    case 'shareInboxList':return {items:[]};
    case 'syncStatus':return scenario==='conflicts'?{role:'coordinated',state:'conflicted',conflictCount:3,pendingCount:0}:{};
    case 'syncConflicts':return {items:scenario==='conflicts'?[{id:'fixture-1',recordId:'sample',title:'示例日记',kind:'journal',contentDay:'2026-11-11',createdAt:'2026-11-12T04:05:00Z'},{id:'fixture-2',recordId:'sample',title:'示例日记',kind:'journal',contentDay:'2026-11-11',createdAt:'2026-11-12T04:04:00Z'},{id:'fixture-3',recordId:'sample2',title:'另一条素材',kind:'idea',createdAt:'2026-11-12T03:00:00Z'}]:[],nextCursor:null};
    case 'syncConflictRefresh':previewConflictRefreshed=true;return {conflictId:args.conflictId};
    case 'syncConflictRead':return {conflict:{id:args.conflictId,recordId:'sample',state:'open',remoteRevision:previewConflictRefreshed?2:1,headChanged:!previewConflictRefreshed,latestHead:{revision:2,versionId:'preview-version',changeId:'preview-change',localRevision:1},local:{title:'示例日记',markdown:'手机上的示例内容。\n\n另一段示例文字。'},remote:{title:'示例日记',markdown:'服务端上的示例内容。\n\n另一段示例文字。'}}};
    case 'receipt':return {status:'unknown'};
    case 'librarySettingsGet':return {};
    default:throw Error(`预览尚未模拟 ${method}`);
  }
}
