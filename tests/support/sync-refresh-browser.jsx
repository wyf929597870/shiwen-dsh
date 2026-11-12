import React from '../../android/node_modules/react/index.js';
import {createRoot} from '../../android/node_modules/react-dom/client.js';
import {LibraryReplicaPanel} from '../../android/web/LibraryReplicaPanel.jsx';
import '../../android/web/style.css';
export const isNative=true;
let refreshed=false;const calls=[];
const head={revision:7,versionId:'server-version',changeId:'server-change',localRevision:3};
const conflict=()=>({id:'conflict-1',recordId:'record-1',state:'open',remoteRevision:refreshed?7:2,headChanged:!refreshed,latestHead:head,local:{title:'示例',markdown:'手机版本'},remote:{title:'示例',markdown:refreshed?'最新服务端':'旧服务端'}});
window.confirm=()=>true;
export async function call(method,args={}){
  if(method==='libraryList')return {items:[{libraryId:'lib',name:'测试库'}]};
  if(method==='syncStatus')return {role:'coordinated',conflictCount:1,pendingCount:0};
  if(method==='librarySettingsGet')return {autoSync:false};
  if(method==='syncConflicts')return {items:[{id:'conflict-1',recordId:'record-1',title:'示例'}]};
  if(method==='syncConflictRead')return {conflict:conflict()};
  if(method==='syncConflictRefresh'){calls.push({method,args});refreshed=true;return {conflictId:args.conflictId};}
  if(method==='syncConflictResolve'){calls.push({method,args});return {record:{id:'record-1',title:'示例'}};}
  if(method==='receipt')return {status:'unknown'};
  throw Error('Unexpected method '+method);
}
const until=async f=>{for(let i=0;i<150;i++){if(f())return;await new Promise(r=>setTimeout(r,10));}throw Error('Timeout');};
const button=label=>[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===label);
createRoot(document.getElementById('root')).render(<LibraryReplicaPanel ready libraryId="lib" libraryContext={{role:'coordinated'}} nodes={[]}/>);
(async()=>{
 await until(()=>document.querySelector('.library-conflict-row'));document.querySelector('.library-conflict-row').click();
 await until(()=>refreshed&&button('保留服务端版本')&&!button('保留服务端版本').disabled);
 if(button('读取最新版本'))throw Error('Latest version should be loaded automatically');
 if(calls[0].args.expectedRemoteRevision!==7||calls[0].args.expectedVersionId!=='server-version'||calls[0].args.expectedLocalRevision!==3)throw Error('Refresh must verify both exact heads');
 if(!document.querySelector('.conflict-detail').textContent.includes('最新'))throw Error('Latest differences were not displayed for review');
 if(!document.querySelector('.conflict-diff-text mark'))throw Error('Differences should be highlighted');
 button('查看全文').click();await until(()=>button('只看差异'));if(!document.querySelector('.conflict-detail').textContent.includes('最新服务端'))throw Error('Full content must remain available');button('只看差异').click();
 button('保留服务端版本').click();await until(()=>calls.length===2);
 if(calls[1].args.expectedLocalRevision!==3||calls[1].args.expectedRemoteRevision!==7)throw Error('Resolution did not retain reviewed revisions');
 document.getElementById('result').textContent=JSON.stringify({passed:true});
})().catch(e=>document.getElementById('result').textContent=JSON.stringify({error:e.stack}));
