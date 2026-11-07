import {markdownSource,updateMarkdownDoc} from '../../library/legacy/markdown.mjs';
import {plainDoc} from '../../library/legacy/content.mjs';
import {readSessionMessages} from '../../library/src/session-messages.mjs';
import {createHash} from 'node:crypto';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {existsSync} from 'node:fs';
import {inspectLegacy,importLegacyToStore} from '../../library/src/migrate.mjs';
import {browserAccess} from './browser-access.mjs';
import {createProfileSnapshot} from '../../mobile/src/profile-adapter.mjs';
import {createManagementAdapter} from '../../mobile/src/management-adapter.mjs';
import {createRemoteSessionsAdapter} from '../../mobile/src/remote-sessions-adapter.mjs';
import {createMobileSyncAdapter} from '../../mobile/src/sync-adapter.mjs';
export const inject=['connection','shiwenLibrary','sessionQuery','shiwenExternal'];
const ownerMethods=new Set(['mobileAgentProfile','agentState','agentDocumentSave','memorySave','memoryDelete','memoryDecide',
  'externalStatus','externalClientCreate','externalClientRevoke','mobileManagement','mobileSync','mobileSessions']);
export function apply(ctx){
  const management=createManagementAdapter(ctx);
  const mobileSessions=createRemoteSessionsAdapter({ctx,library:ctx.shiwenLibrary});
  const mobileSync=createMobileSyncAdapter({ctx,library:ctx.shiwenLibrary});
  ctx.effect(()=>()=>mobileSessions.close());
  ctx.effect(()=>()=>mobileSync.close());
  ctx.effect(()=>ctx.connection.fetch.register({path:'/api/shiwen',methods:['POST'],requestBody:'buffered',async fetch(request){
    let method,args;
    try{
      ({method,args}=await request.json());
      if(ownerMethods.has(method)){
        const admission=ctx.connection.admit(request);
        if('rejection' in admission||admission.peer!==ctx.connection.browserPeer){
          return Response.json({error:'Authenticated owner session required'},
            {status:'rejection' in admission?admission.rejection:403,headers:{'Cache-Control':'no-store'}});
        }
      }
      const library=ctx.shiwenLibrary;
      let result;
      if(method==='mobileManagement'){
        if(typeof args?.action!=='string')throw Object.assign(new Error('Management action is required'),{code:'INVALID_REQUEST'});
        result=await management.execute(args.action,args.args??{},request.signal);
      }else if(method==='mobileSync'){
        if(typeof args?.action!=='string'||!args.request||typeof args.request!=='object')throw Object.assign(new Error('Sync action and request are required'),{code:'VALIDATION_ERROR'});
        result={action:args.action,data:await mobileSync.execute(args.action,args.request,request.signal)};
      }else if(method==='mobileSessions'){
        if(typeof args?.action!=='string')throw Object.assign(new Error('Session action is required'),{code:'INVALID_REQUEST'});
        result=await mobileSessions.execute(args.action,args.args??{},request.signal);
      }else if(method==='mobileAgentProfile'){
        result=createProfileSnapshot(library.agentState(),{agentId:'shiwen'});
      }else if(method==='browserStatus'||method==='browserLogin'){
        if(method==='browserLogin'){
          // DSH exact Fetch routes do not pass their admitted Peer to the handler.
          // Resolve it from the original request through DSH, never from JSON fields.
          const admission=ctx.connection.admit(request);
          if('rejection' in admission||admission.peer!==ctx.connection.browserPeer){
            return Response.json({error:'仅浏览器会话可以获取登录地址 / Browser session required'},
              {status:'rejection' in admission?admission.rejection:403,headers:{'Cache-Control':'no-store'}});
          }
        }
        result=browserAccess(ctx,{login:method==='browserLogin'});
      }else if(method==='externalStatus'){
        result={...ctx.shiwenExternal.status(),clients:library.externalClients()};
      }else if(method==='externalClientCreate'){
        result=library.externalClientCreate(args);
      }else if(method==='externalClientRevoke'){
        result=library.externalClientRevoke(args);
      }else if(method==='legacyDefault'){
        const path=join(homedir(),'.config','shiwen','library','library.sqlite');result=existsSync(path)?path:'';
      }else if(method==='previewLegacy'){
        if(typeof args?.path!=='string'||args.path.length>4096)throw new Error('资料库路径无效');
        result=inspectLegacy(args.path);
      }else if(method==='importLegacy'){
        if(typeof args?.path!=='string'||args.path.length>4096)throw new Error('资料库路径无效');
        result=await importLegacyToStore({source:args.path,store:library,scratch:library.paths?.library??process.env.SHIWEN_DATA_DIR});
      }else if(method==='saveAssistantMessage'){
        const {sessionId,messageId}=args??{};
        const source=(await readSessionMessages(ctx,sessionId,request.signal)).find(m=>m.id===messageId&&m.role==='assistant');
        if(!source)throw new Error('消息不存在或尚未完成');
        request.signal.throwIfAborted();
        const operationId='message:'+createHash('sha256').update(sessionId+'\0'+messageId).digest('hex');
        const row=library.saveDsh({kind:'ai',body:source.body,origin:'ai',day:null,sessionId,messageId,role:'assistant',operationId});
        result={id:row.id,title:row.title};
      }else if(method==='readMarkdown'){
        const row=library.get(args.id);if(!row||row.deleted)throw new Error('记录不存在');
        result={...row,markdown:markdownSource(row.doc),dshSources:library.dshSources({id:row.id})};
      }else if(method==='saveMarkdown'){
        const row=args.id?library.get(args.id):null;
        if(args.id&&(!row||row.deleted))throw new Error('记录不存在');
        if(typeof args.body!=='string'||args.body.length>1000000)throw new Error('正文无效或过长');
        const doc=row?updateMarkdownDoc(row.doc,args.body,'personal',row.origin):plainDoc(args.body,'personal');
        result=library.save({id:args.id,revision:args.revision,kind:args.kind,title:args.title,stage:args.stage,sourceIds:args.sourceIds,doc});
      }else{
        if(!['snapshot','review','draft','editingDraft','versions','restoreVersion','remove','restoreRemoved','updateRecord','importDate','recordDate','searchRecords','agentState','agentDocumentSave','memorySave','memoryDelete','memoryDecide'].includes(method))throw new Error('未知操作');
        result=library[method](args);
      }
      return Response.json({result},{headers:{'Cache-Control':'no-store'}});
    }catch(error){
      if(method==='mobileSync'&&args?.action==='setupCommit'&&process.env.SHIWEN_SYNC_DIAGNOSTICS==='1'){
        // Opt-in synthetic-host diagnostics: stack frames only, never request,
        // response, SQL bindings, credentials, or exception message.
        const frames=String(error?.stack??'').split('\n').slice(1,9).map(frame=>frame.trim());
        const code=typeof error?.code==='string'&&/^SQLITE_[A-Z_]+$/.test(error.code)?error.code:undefined;
        console.error('[shiwen-sync-diagnostic]',JSON.stringify({action:'setupCommit',errorName:String(error?.name??'Error'),...(code?{code}:{}),frames}));
      }
      return Response.json({error:String(error.message??error),...(typeof error.code==='string'?{code:error.code}:{}),...(error.name==='ProtocolError'&&error.details&&typeof error.details==='object'?{details:error.details}:{})},{status:400,headers:{'Cache-Control':'no-store'}});
    }
  }}));
}
