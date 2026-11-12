import React from '../../android/node_modules/react/index.js';
import {createRoot} from '../../android/node_modules/react-dom/client.js';
import {LibraryReplicaPanel} from '../../android/web/LibraryReplicaPanel.jsx';
import '../../android/web/style.css';
export const isNative=true;
let synced=false,conflictReads=0;
export async function call(method){
 if(method==='libraryList')return {items:[{libraryId:'lib',name:'测试库'}]};
 if(method==='syncStatus')return {role:'coordinated',state:synced?'conflicted':'idle',conflictCount:synced?1:0,pendingCount:0};
 if(method==='librarySettingsGet')return {autoSync:false};
 if(method==='syncConflicts'){conflictReads++;return {items:synced?[{id:'c1',recordId:'r1',title:'示例资料',kind:'idea'}]:[],nextCursor:null};}
 if(method==='syncNow'){synced=true;return {operationId:'op-1',state:'queued'};}
 if(method==='syncProgress')return {state:'completed'};
 throw Error('Unexpected '+method);
}
const until=async f=>{for(let i=0;i<150;i++){if(f())return;await new Promise(r=>setTimeout(r,10));}throw Error('Timeout');};
const button=label=>[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===label);
createRoot(document.getElementById('root')).render(<LibraryReplicaPanel ready libraryId="lib" libraryContext={{role:'coordinated'}} nodes={[]}/>);
(async()=>{
 await until(()=>button('手动同步')&&!button('手动同步').disabled&&conflictReads>0);
 if(document.querySelector('.conflict-list'))throw Error('No conflicts should be shown before sync');
 button('手动同步').click();await until(()=>document.querySelector('.library-conflict-row'));
 if(conflictReads<2||!document.querySelector('.conflict-list').textContent.includes('示例资料'))throw Error('Sync result must automatically load conflicts');
 if(button('查看冲突')||button('刷新列表'))throw Error('Conflict list must not require opening or refreshing');
 document.getElementById('result').textContent=JSON.stringify({passed:true});
})().catch(e=>document.getElementById('result').textContent=JSON.stringify({error:e.stack}));
