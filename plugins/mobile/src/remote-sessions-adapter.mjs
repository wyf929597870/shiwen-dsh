import {createHash, randomUUID} from 'node:crypto';
import {mkdirSync} from 'node:fs';
import {dirname, join} from 'node:path';
import Database from '../../library/legacy/sqlite.mjs';
import {createMobileSessionAdapter} from './session-adapter.mjs';

const fail=(code,message)=>Object.assign(new Error(message),{code});
const text=(v,name,max=256)=>{if(typeof v!=='string'||!v.trim()||v.length>max)throw fail('INVALID_REQUEST',`${name} is required`);return v;};
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const digest=v=>createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
const optional=(ctx,key)=>{try{return ctx.get(key);}catch{return undefined;}};
const signalOr=signal=>signal??new AbortController().signal;

/** Node-local ledger: never part of library replication or a restored device identity. */
export class SqliteSessionLedger {
  constructor(path){
    mkdirSync(dirname(path),{recursive:true});this.db=new Database(path);
    this.db.pragma('journal_mode = WAL');this.db.pragma('busy_timeout = 5000');
    this.db.exec('CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY,body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS cursors(id TEXT PRIMARY KEY,value INTEGER NOT NULL)');
  }
  getRequest(id){const row=this.db.prepare('SELECT body FROM requests WHERE id=?').get(id);return row?JSON.parse(row.body):undefined;}
  putRequest(row){this.db.prepare('INSERT INTO requests VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(row.requestId,JSON.stringify(row));}
  getCursor(id){return this.db.prepare('SELECT value FROM cursors WHERE id=?').get(id)?.value??-1;}
  putCursor(id,value){this.db.prepare('INSERT INTO cursors VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(id,value);}
  close(){this.db.close();}
}

/** Uses the pinned DSH public event carrier, including its cancellation and owner-peer checks. */
export function createInteractionRelay(ctx){
  let lifetime,clientId,pending=new Map(),starting,lastTouch=0,streamError;
  const stop=()=>{lifetime?.abort();lifetime=undefined;clientId=undefined;pending.clear();};
  const timer=setInterval(()=>{if(lifetime&&Date.now()-lastTouch>60_000)stop();},10_000);timer.unref?.();
  async function touch(){
    lastTouch=Date.now();
    if(clientId)return;
    if(starting)return starting;
    const gateway=optional(ctx,'typertGateway');
    if(!gateway?.wireStream)throw fail('SESSIONS_UNAVAILABLE','Interaction service unavailable');
    const owner=new AbortController();lifetime=owner;streamError=undefined;
    starting=(async()=>{
      const stream=await gateway.wireStream.open('$events',{args:{}},(async function*(){})(),ctx.connection.browserPeer,owner.signal);
      const iterator=stream[Symbol.asyncIterator]();
      const first=await iterator.next();
      if(first.value?.type!=='ready')throw fail('SESSIONS_UNAVAILABLE','Interaction stream did not become ready');
      clientId=first.value.clientId;
      (async()=>{try{while(!owner.signal.aborted){const item=await iterator.next();if(item.done)break;const frame=item.value;
        if(frame.type==='waterfall')pending.set(frame.eventId,frame);
        else if(frame.type==='cancel')pending.delete(frame.eventId);
      }}catch{if(!owner.signal.aborted)streamError='Interaction stream disconnected';}
      finally{if(lifetime===owner){clientId=undefined;pending.clear();lifetime=undefined;}await iterator.return?.();}})().catch(()=>{});
    })().catch(error=>{if(lifetime===owner)stop();throw error;}).finally(()=>{starting=undefined;});
    return starting;
  }
  async function snapshot(){await touch();return {clientId,items:[...pending.values()],error:streamError??null};}
  async function respond(args){
    await touch();const eventId=text(args.eventId,'eventId');
    if(args.clientId!==clientId||!pending.has(eventId))throw fail('INTERACTION_EXPIRED','Interaction is no longer pending; refresh first');
    const event=pending.get(eventId);let value;
    if(event.event==='approval/request'){
      if(!['allowed-once','rejected'].includes(args.value))throw fail('INVALID_REQUEST','Explicit one-shot approval or rejection required');
      value=args.value;
    }else if(event.event==='user-questions/request'){
      const questions=event.request.questions;
      if(!Array.isArray(questions)||!Array.isArray(args.value?.answers)||args.value.answers.length!==questions.length)throw fail('INVALID_REQUEST','Answer every question explicitly');
      value={answers:questions.map(question=>{
        const answer=args.value.answers.find(item=>item.id===question.id);
        if(!answer||!Array.isArray(answer.selected)||answer.selected.some(label=>!question.options?.some(option=>option.label===label)))throw fail('INVALID_REQUEST','Invalid question answer');
        if(question.multiSelect!==true&&answer.selected.length>1)throw fail('INVALID_REQUEST','Only one option is allowed');
        if(answer.custom!==undefined&&(typeof answer.custom!=='string'||answer.custom.length>10000))throw fail('INVALID_REQUEST','Invalid answer text');
        return {id:question.id,selected:answer.selected,...(answer.custom?{custom:answer.custom}:{})};
      })};
    }else throw fail('INTERACTION_UNSUPPORTED','Open the DSH web client for this interaction');
    const request=new Request('http://localhost/api/$events/result',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({type:'client-request',rpcId:randomUUID(),method:'$events/result',payload:{args:{clientId,eventId,outcome:{kind:'result',value}}}})});
    const response=await ctx.connection.createSharedFetchHandler('/api').fetch(request,ctx.connection.browserPeer);
    const envelope=await response.json();if(!envelope.result?.ok)throw fail('INTERACTION_EXPIRED','Interaction was not accepted; refresh before another decision');
    pending.delete(eventId);return {accepted:true};
  }
  return {snapshot,respond,close(){clearInterval(timer);stop();}};
}

export function createRemoteSessionsAdapter({ctx,library,ledger:providedLedger,relay:providedRelay}){
  let ledger=providedLedger,sessionAdapter;const relay=providedRelay??createInteractionRelay(ctx);
  const controller=()=>{const value=optional(ctx,'sessionController');if(!value)throw fail('SESSIONS_UNAVAILABLE','DSH sessions are unavailable');return value;};
  const getLedger=()=>ledger??=new SqliteSessionLedger(join(library.paths.library,'mobile-session-requests.sqlite'));
  const adapter=()=>sessionAdapter??=createMobileSessionAdapter({ledger:{
    getRequest:id=>{const row=getLedger().getRequest(`send:${id}`);return row?{...row,requestId:id}:undefined;},
    putRequest:row=>getLedger().putRequest({...row,requestId:`send:${row.requestId}`,publicRequestId:row.requestId}),
    getCursor:id=>getLedger().getCursor(id),putCursor:(id,cursor)=>getLedger().putCursor(id,cursor)
  },controller:{
    prompt:(request,signal)=>controller().prompt(request,signal),
    state:request=>controller().state(request,signalOr()),
    events:request=>controller().events(request,signalOr()),cancel:request=>controller().cancel(request)
  }});
  async function create(args){
    const requestId=text(args.requestId,'requestId');const request={sessionId:text(args.sessionId,'sessionId'),
      ...(args.workspaceId?{workspaceId:text(args.workspaceId,'workspaceId')}:{ }),...(args.agentPreset?{agentPreset:text(args.agentPreset,'agentPreset')}:{})};
    const key=`create:${requestId}`,hash=digest(request),old=getLedger().getRequest(key);
    if(old){if(old.hash!==hash)throw fail('REQUEST_ID_REUSED','Creation id identifies different input');return old.result??{status:'unknown',requestId};}
    getLedger().putRequest({requestId:key,hash,status:'prepared'});
    try{const result={...await controller().create(request),status:'accepted',requestId};getLedger().putRequest({requestId:key,hash,status:'accepted',result});return result;}
    catch{getLedger().putRequest({requestId:key,hash,status:'unknown'});return {status:'unknown',requestId};}
  }
  async function execute(action,args={},signal){
    if(!args||typeof args!=='object'||Array.isArray(args)||JSON.stringify(args).length>120000)throw fail('INVALID_REQUEST','Invalid session request');
    const c=controller();let data;
    switch(action){
      case 'capabilities':data={supportedActions:['list','catalog','models','create','state','events','send','status','cancel','selectModel','rename','respond',...(optional(ctx,'workspaceRegistry')?['archive','unarchive']:[]),...(optional(ctx,'sessionSkillCatalog')?['skills']:[])]};break;
      case 'skills':{
        const service=optional(ctx,'sessionSkillCatalog');if(!service)throw fail('SESSIONS_UNAVAILABLE','Skill catalog is unavailable');
        const result=await service.list({sessionId:text(args.sessionId,'sessionId')},signalOr(signal));
        data={skills:result.skills.map(({name,description,whenToUse,modelInvocable})=>({name,description,whenToUse,modelInvocable}))};break;
      }
      case 'list':{
        const registry=optional(ctx,'workspaceRegistry');
        data={...await c.list({},signalOr(signal)),archivedSessionIds:[...(registry?.archivedSessionIds??[])]};break;
      }
      case 'models':data=await c.modelCatalog();break;
      case 'catalog':data={presets:await optional(ctx,'agentPresets')?.list()??[],workspaces:(optional(ctx,'workspaceRegistry')?.list()??[]).map(w=>({id:w.id,title:w.title,path:w.path}))};break;
      case 'create':data=await create(args);break;
      case 'state':{
        data=await c.state({sessionId:text(args.sessionId,'sessionId')},signalOr(signal));
        try{data={...data,interactions:await relay.snapshot()};}catch{data={...data,interactionUnavailable:true};}break;
      }
      case 'events':{
        const request={address:{kind:'session',sessionId:text(args.sessionId,'sessionId')},maxMessages:30};
        for(const key of ['throughSeq','beforeSeq'])if(args[key]!==undefined){if(!Number.isSafeInteger(args[key])||args[key]<0)throw fail('INVALID_REQUEST','Invalid event cursor');request[key]=args[key];}
        data=await c.events(request,signalOr(signal));break;
      }
      case 'send':{
        text(args.requestId,'requestId');text(args.sessionId,'sessionId');
        if(!Array.isArray(args.content)||args.content.length!==1||args.content[0]?.type!=='text')throw fail('INVALID_REQUEST','One text message is required');
        text(args.content[0].text,'content',100000);
        if(!['queue','steer'].includes(args.mode))throw fail('INVALID_REQUEST','Invalid delivery mode');
        await relay.snapshot();
        data=await adapter().send({requestId:args.requestId,sessionId:args.sessionId,mode:args.mode,content:args.content,
          ...(args.clientTimeZone?{clientTimeZone:text(args.clientTimeZone,'clientTimeZone',100)}:{})});break;
      }
      case 'status':data=await adapter().reconcile(text(args.requestId,'requestId'));break;
      case 'cancel':data=await adapter().cancel(text(args.sessionId,'sessionId'));break;
      case 'rename':data=await c.rename({sessionId:text(args.sessionId,'sessionId'),title:text(args.title,'title',300)});break;
      case 'archive':{
        const registry=optional(ctx,'workspaceRegistry');
        if(!registry)throw fail('SESSIONS_UNAVAILABLE','Workspace archive is unavailable');
        const sessionId=text(args.sessionId,'sessionId');
        try{await registry.archiveSession(sessionId,{stopActivity:args.stopActivity===true});}
        catch(error){throw fail('SESSION_CONFLICT',error instanceof Error?error.message:'The session could not be archived');}
        data={archivedSessionIds:[...registry.archivedSessionIds]};break;
      }
      case 'unarchive':{
        const registry=optional(ctx,'workspaceRegistry');
        if(!registry)throw fail('SESSIONS_UNAVAILABLE','Workspace archive is unavailable');
        const sessionId=text(args.sessionId,'sessionId');
        try{await registry.unarchiveSession(sessionId);}
        catch(error){throw fail('SESSION_CONFLICT',error instanceof Error?error.message:'The session could not be restored');}
        data={archivedSessionIds:[...registry.archivedSessionIds]};break;
      }
      case 'selectModel':data=await c.selectModel({sessionId:text(args.sessionId,'sessionId'),provider:text(args.provider,'provider'),model:text(args.model,'model'),...(args.reasoningEffort?{reasoningEffort:text(args.reasoningEffort,'reasoningEffort')}:{})});break;
      case 'respond':data=await relay.respond(args);break;
      default:throw fail('INVALID_REQUEST','Unsupported session action');
    }
    return {action,data};
  }
  return {execute,close(){relay.close();ledger?.close?.();}};
}
