import React from '../../android/node_modules/react/index.js';
import {createRoot} from '../../android/node_modules/react-dom/client.js';
import {LibraryReplicaPanel} from '../../android/web/LibraryReplicaPanel.jsx';
import '../../android/web/style.css';

const requestId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const conflict={id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',recordId:'record-1',remoteRevision:2,state:'open',local:{title:'示例',markdown:'手机'},remote:{title:'示例',markdown:'服务'}};
const missing={...conflict,id:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',remoteRevision:null,title:'示例',kind:'journal'};
conflict.title='示例';conflict.kind='journal';let attempts=[];
window.confirm=()=>true;
sessionStorage.setItem('shiwen-conflict-pending',JSON.stringify({key:conflict.id+':keep-remote',requestId}));
export const isNative=true;
export async function call(method,args={}){
  switch(method){
    case 'libraryList':return {items:[{libraryId:'lib',name:'测试库'}]};
    case 'syncStatus':return {role:'coordinated',conflictCount:1,pendingCount:0};
    case 'librarySettingsGet':return {autoSync:false};
    case 'syncConflicts':return {items:[conflict,missing].filter(x=>x.state==='open'),nextCursor:null};
    case 'syncConflictRead':return {conflict:{...(args.conflictId===missing.id?missing:conflict)}};
    case 'receipt':return {status:'unknown'};
    case 'syncConflictResolve':attempts.push(args);conflict.state='resolved-local';return {record:{id:'record-1',title:'示例'}};
    default:throw Error('Unexpected: '+method);
  }
}
const button=label=>[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===label);
const until=async predicate=>{for(let i=0;i<150;i++){if(predicate())return;await new Promise(r=>setTimeout(r,10));}throw Error('Timeout');};
createRoot(document.getElementById('root')).render(<LibraryReplicaPanel ready libraryId="lib" libraryContext={{role:'coordinated'}} nodes={[]}/>);
(async()=>{
  await until(()=>document.querySelector('.library-conflict-row'));
  if(button('查看冲突')||button('刷新列表'))throw Error('Conflicts should load automatically without a refresh button');
  if(document.querySelectorAll('.conflict-group').length!==1||document.querySelectorAll('.library-conflict-row').length!==2)throw Error('Conflicts for one record must be grouped without hiding entries');
  if(document.querySelector('.conflict-group summary').textContent.includes('record-1'))throw Error('Record UUID should not be the title');
  document.querySelector('.conflict-group').open=true;document.querySelector('.library-conflict-row').click();await until(()=>button('保留手机版本'));
  if(!document.querySelector('[role=alertdialog] .conflict-version'))throw Error('Conflict comparison must open in a dialog');
  if(sessionStorage.getItem('shiwen-conflict-pending'))throw Error('Previous failed request was not reconciled');
  button('保留手机版本').click();await until(()=>attempts.length===1);
  if(attempts[0].resolution.kind!=='keep-local'||attempts[0].requestId===requestId)throw Error('Wrong resolution request');
  await until(()=>document.querySelector('[role=alertdialog]')?.textContent.includes('冲突已处理'));
  button('知道了').click();await until(()=>document.querySelector('.library-conflict-row'));document.querySelector('.library-conflict-row').click();await until(()=>button('保留服务端版本'));
  button('保留服务端版本').click();await until(()=>[...document.querySelectorAll('[role=alertdialog]')].some(x=>x.textContent.includes('缺少可核验的服务端版本')));
  if(attempts.length!==1)throw Error('Missing remote revision must never be submitted or guessed');
  document.getElementById('result').textContent=JSON.stringify({passed:true});
})().catch(e=>{document.getElementById('result').textContent=JSON.stringify({error:e.stack});});
