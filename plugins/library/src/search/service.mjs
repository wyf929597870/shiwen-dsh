import {hostname} from 'node:os';
import {renameSync,rmSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {createModel,MODEL_VERSION,QUERY_INSTRUCTION} from './model.mjs';
import {createSearchIndex,searchExact} from './index.mjs';
const scopes=new Set(['materials','articles','reading','writingSources','ideaCanvas','records','collections','global']);
const kinds=new Set(['journal','freewrite','idea','web','reference','ai','reading_note']);
const stages=new Set(['idea','draft','revision','final']);
const invalid=()=>{throw Object.assign(new Error('搜索参数无效'),{code:'INVALID_REQUEST'});};
function normalize(args={}){
 if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(x=>!['query','mode','scope','filters','offset','limit'].includes(x)))invalid();
 const {query='',mode='exact',scope='materials',offset=0,limit=20}=args, f=args.filters??{};
 if(typeof query!=='string'||query.length>1000||!['exact','semantic'].includes(mode)||!scopes.has(scope)||!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>30||!f||typeof f!=='object'||Array.isArray(f)||Object.keys(f).some(x=>!['kind','start','end','stage','book','chapter','noteType','sourceScope','selectedIds'].includes(x)))invalid();
 const filters={kind:null,start:null,end:null,stage:null,book:null,chapter:null,noteType:null,sourceScope:'all',selectedIds:[],...f};
 if(scope==='ideaCanvas'&&mode!=='semantic')invalid();
 if(filters.kind!==null&&(!kinds.has(filters.kind)||!['materials','writingSources','records','collections'].includes(scope))||filters.stage!==null&&(!stages.has(filters.stage)||scope!=='articles')||filters.noteType!==null&&!['excerpt','reflection','question'].includes(filters.noteType))invalid();
 for(const key of ['book','chapter','noteType'])if(filters[key]!==null&&(typeof filters[key]!=='string'||!filters[key]||filters[key].length>200||!['reading','writingSources'].includes(scope)))invalid();
 for(const key of ['start','end'])if(filters[key]!==null&&(typeof filters[key]!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(filters[key])||Number.isNaN(Date.parse(filters[key]))||new Date(filters[key]).toISOString().slice(0,10)!==filters[key]))invalid();
 if(filters.start&&filters.end&&filters.start>filters.end||!['all','linked'].includes(filters.sourceScope)||!Array.isArray(filters.selectedIds)||filters.selectedIds.length>10000||filters.selectedIds.some(id=>typeof id!=='string'||!id||id.length>100)||scope!=='writingSources'&&(filters.sourceScope!=='all'||filters.selectedIds.length)||filters.sourceScope==='all'&&filters.selectedIds.length)invalid();
 filters.selectedIds=[...new Set(filters.selectedIds)];return {query,mode,scope,offset,limit,filters};
}
export function createContentSearch({library,modelFactory=createModel,indexFactory=createSearchIndex}){
 const model=modelFactory({directory:join(library.paths.root,'search-model')});
 const directory=join(library.paths.library,'search');
 const options={library,directory,embed:(texts,options={})=>model.embed(options.priority==='query'?texts.map(text=>QUERY_INSTRUCTION+text):texts,options),countTokens:(text,options)=>model.countTokens(text,options),modelVersion:MODEL_VERSION};
 let index=null,indexError=null,starting=null,rebuilding=null,closed=false,pendingClose=Promise.resolve();const libraryScope=library.readingNoteList().scope;
 const markIndexFailed=()=>{const previous=index;index=null;try{pendingClose=Promise.all([pendingClose,Promise.resolve(previous?.close())]).then(()=>{}).catch(()=>{});}catch{}indexError={code:'INDEX_FAILED',message:'搜索索引不可用，请重建索引；原文搜索仍可使用。',retryable:true};};
 try{index=indexFactory(options);}catch{markIndexFailed();}
 const status=()=>{const m=model.status();let i;try{i=index?.status();}catch{markIndexFailed();}i??={state:'failed',completed:0,total:null,error:indexError,canSearchSemantic:false};let state=m.state==='failed'||i.state==='failed'?'failed':m.state==='downloading'?'downloading':m.state!=='ready'?'disabled':i.state==='indexing'||i.state==='missing'?'indexing':i.state;return {libraryScope,serviceLocation:hostname(),state,model:{state:m.state,revision:m.revision,downloadedBytes:m.downloadedBytes,totalBytes:m.totalBytes},index:{state:i.state,completed:i.completed,total:i.total},error:m.error??i.error??indexError??null,canSearchSemantic:m.state==='ready'&&i.state!=='failed'&&i.canSearchSemantic};};
 const enable=()=>{if(starting)return starting;starting=(async()=>{await model.enable();if(!closed&&index)try{index.start();}catch{markIndexFailed();}return status();})().finally(()=>{starting=null;});return starting;};
 void model.available().then(ok=>{if(ok&&!closed)return enable();}).catch(()=>{});
 async function performRepair(){
  if(index){try{index.rebuild();return status();}catch{markIndexFailed();}}
  await pendingClose;
  const backup=directory+'.damaged-'+randomUUID();let moved=false;
  try{try{renameSync(directory,backup);moved=true;}catch(e){if(e.code!=='ENOENT')throw e;}index=indexFactory(options);indexError=null;if(model.status().state==='ready')index.start();if(moved)rmSync(backup,{recursive:true,force:true});}catch{markIndexFailed();if(moved&&!index){try{renameSync(backup,directory);}catch{}}}
  return status();
 }
 const repair=()=>{if(!rebuilding)rebuilding=performRepair().finally(()=>{rebuilding=null;});return rebuilding;};
 return {status,enable,rebuild:repair,async search(args){const request=normalize(args);if(request.mode==='semantic'&&request.query.trim()&&!status().canSearchSemantic){const e=Error('语义搜索尚未准备好');e.code='SEMANTIC_NOT_READY';throw e;}let result;
  if(request.mode==='exact'&&(!index||status().index.state==='failed'))result=searchExact({library},request);
  else try{result=await index.search(request);}catch(e){if(request.mode!=='exact'){if(typeof e.code==='string'&&/^(?:ERR_)?SQLITE/.test(e.code))markIndexFailed();throw e;}markIndexFailed();result=searchExact({library},request);}
  return {libraryScope,mode:request.mode,scope:request.scope,...result,status:status()};},notifyChange(){try{index?.notifyChange();}catch{markIndexFailed();}},async close(){closed=true;const closing=index?.close();await model.close();await Promise.all([pendingClose,closing]);}};
}
