import React from 'react';
import {createRoot} from 'react-dom/client';
import {apply} from '../../plugins/workbench/src/client.jsx';
const assert=(ok,message)=>{if(!ok)throw Error(message);};
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check){for(let i=0;i<100;i++){if(check())return;await pause(20);}throw Error('Timed out: '+check);}
const passed=[],writes=[],saveCalls=[],receiptQueries=[],receipts=new Map();let Page,remote=null,saved=null;
let missingSource=true;
let releaseRestore,releaseSave,releaseRead,failNextRead=false,failNextClear=false,failNextSave=false,failNextRestore=true;let restoreGate=new Promise(resolve=>releaseRestore=resolve),saveGate=null,readGate=null;
const records=Array.from({length:4400},(_,i)=>({id:String(i),title:'素材 '+i,body:'测试正文',kind:'freewrite',revision:1}));
window.confirm=()=>true;
window.fetch=async(_url,options)=>{
 const {method,args}=JSON.parse(options.body);let result;
 if(method==='snapshot')result={records};
 else if(method==='contentSearchStatus')result={libraryScope:'material-editor-fixture',state:'disabled',canSearchSemantic:false};
 else if(method==='contentSearch'){
  const matches=records.filter(row=>row.title.toLowerCase().includes(args.query.trim().toLowerCase()));
  result={total:matches.length,nextOffset:null,items:matches.slice(args.offset,args.offset+args.limit).map(row=>({recordId:row.id,revision:row.revision,kind:row.kind,title:row.title,origin:'personal',match:{field:'title',text:row.title,anchor:{start:0,end:row.title.length}}}))};
 }
 else if(method==='workbenchDraft'&&args.slot!=='library')result=null;
 else if(method==='workbenchDraft'){if('value' in args&&args.value===null&&failNextClear){failNextClear=false;return {ok:false,status:500,json:async()=>({error:'clear failed'})};}if(!('value' in args)&&restoreGate){await restoreGate;restoreGate=null;}if(!('value' in args)&&failNextRestore){failNextRestore=false;return {ok:false,status:500,json:async()=>({error:'restore failed'})};}if('value' in args){writes.push(args);remote=args.value;}result={value:remote,revision:remote?.draftRevision??0};}
 else if(method==='workbenchSaveReceipt'){
  receiptQueries.push(args);
  const prior=receipts.get(args.requestId);
  if(prior)assert(JSON.stringify(prior)===JSON.stringify(args),'receipt lookup matches submitted payload');
  result=prior?{id:'0'}:null;
 }
 else if(method==='saveMarkdown'){
  saveCalls.push(args);
  if(failNextSave){failNextSave=false;return {ok:false,status:500,json:async()=>({error:'save failed'})};}
  if(args.requestId&&receipts.has(args.requestId)){
   const prior=receipts.get(args.requestId);
   assert(JSON.stringify(prior)===JSON.stringify(args),'replay must keep the original payload');
  }else{
   saved=args;
   if(args.requestId)receipts.set(args.requestId,args);
   if(saveGate)await saveGate;
  }
  result={id:'0'};
 }
 else if(method==='readMarkdown'){if(args.id==='deleted'&&missingSource)return {ok:false,status:400,json:async()=>({code:'RECORD_NOT_FOUND',error:'记录不存在'})};if(failNextRead){failNextRead=false;return {ok:false,status:500,json:async()=>({error:'read failed'})};}if(readGate)await readGate;result={...records[0],markdown:saved?.body||'测试正文'};}
 else throw Error('Unexpected RPC '+method);
 return {ok:true,json:async()=>({result})};
};
apply({locale:{subscribe:()=>()=>{},getSnapshot:()=>({active:'zh'})},uiWorkspace:{},layout:{},effect:fn=>fn(),slots:{inject:(_name,fn)=>fn(),register:(config,component)=>{if(config.key==='shiwen-library')Page=component;}}});
let root=createRoot(document.getElementById('root'));root.render(<Page/>);
const button=text=>[...document.querySelectorAll('button')].find(el=>el.textContent.trim()===text);
const createButton=()=>button(innerWidth>760?'＋ 新建记录':'＋ 新建');
const body=()=>document.querySelector('textarea[aria-label="正文"]');
function type(value){const input=body();Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));assert(input.value===value,'typing appears immediately');}
function remount(){
 root.unmount();root=createRoot(document.getElementById('root'));root.render(<Page/>);
}
async function checkMissingSource(){
 const key='shiwen-editor-draft:library';
 const orphan={id:'deleted',revision:7,title:'已删除记录的标题',body:'保留最后一行',kind:'reference',stage:'draft',sources:[]};
 function loadOrphan(){
  remote={...orphan,draftRevision:Date.now()*1000};
  localStorage.setItem(key,JSON.stringify(remote));remount();
 }
 missingSource=false;failNextRead=true;loadOrphan();
 await until(()=>button('重试读取草稿'));
 assert(!button('转为新草稿')&&!button('放弃草稿'),'a temporary read failure must not detach the source');
 missingSource=true;button('重试读取草稿').click();await until(()=>button('转为新草稿'));
 assert(!button('重试读取草稿')&&createButton().disabled,'missing source has explicit recovery choices');
 button('转为新草稿').click();await until(()=>body()?.value===orphan.body);
 assert(remote.id===null&&remote.revision===null&&remote.title===orphan.title&&remote.kind===orphan.kind,'recovered draft retains content and detaches from deleted source');
 remount();await until(()=>body()?.value===orphan.body);
 button('保存').click();await until(()=>!body()&&!createButton().disabled);
 assert(!saved.id&&saved.body===orphan.body,'recovered text is saved as a new record');
 loadOrphan();await until(()=>button('放弃草稿'));
 window.confirm=()=>false;button('放弃草稿').click();assert(remote.id==='deleted','cancelling discard keeps draft');
 window.confirm=()=>true;button('放弃草稿').click();await until(()=>!createButton().disabled);
 remount();await until(()=>createButton()&&!createButton().disabled);
 assert(!body()&&remote===null&&!button('放弃草稿'),'discard releases navigation across remount');
 passed.push('recover or discard draft after its source is deleted');
}
async function checkDelayedCreateReceipt(){
 const key='shiwen-editor-draft:library',start=saveCalls.length,priorCount=receipts.size;
 createButton().click();await until(body);type('只创建一次');await pause(20);
 saveGate=new Promise(resolve=>releaseSave=resolve);button('保存').click();
 await until(()=>saveCalls.length===start+1);
 const requestId=saveCalls[start].requestId;
 assert(requestId&&JSON.parse(localStorage.getItem(key)).createRequestId===requestId,'new text save durably records its operation before sending');
 remount();await until(()=>receiptQueries.at(-1)?.requestId===requestId&&!body()&&!createButton().disabled);
 assert(saveCalls.length===start+1&&receipts.size===priorCount+1,'remount resolves the committed creation without a second write');
 assert(remote===null&&JSON.parse(localStorage.getItem(key)).deleted,'reconciled create clears the pending draft');
 createButton().click();await until(body);type('回执到达前的新草稿');window.dispatchEvent(new Event('pagehide'));
 releaseSave();saveGate=null;await pause(40);
 assert(remote?.body==='回执到达前的新草稿'&&body().value===remote.body,'late original receipt cannot clear a newer draft');
 // Simulate a gateway failure for a creation and retry the same operation.
 failNextSave=true;button('保存').click();await until(()=>button('保存')&&!button('保存').disabled&&body()?.disabled);
 const failed=saveCalls.at(-1),beforeRemount=saveCalls.length;
 remount();await until(()=>body()?.disabled&&!button('保存').disabled);
 assert(receiptQueries.at(-1).requestId===failed.requestId&&saveCalls.length===beforeRemount,'missing receipt retains pending draft without automatic submission');
 button('保存').click();await until(()=>!body()&&!createButton().disabled);
 assert(failed.requestId&&saveCalls.at(-1).requestId===failed.requestId&&failed.requestId!==requestId,'ambiguous failures retain the operation and independent creations use new ids');
 passed.push('lost create receipt, replay, late response and a separate creation');
}
async function run(){
 await until(()=>document.querySelectorAll('.sw-row').length>0);
 assert(createButton().disabled,'creation blocked while restoring draft');createButton().click();assert(!body()&&writes.length===0,'restore cannot be cleared by creation');releaseRestore();await until(()=>button('重试读取草稿'));assert(createButton().disabled,'failed restore keeps navigation blocked');window.dispatchEvent(new Event('shiwen-library-updated'));await pause(40);assert(button('重试读取草稿'),'retry remains available after refresh');remote={id:null,title:'恢复标题',body:'恢复草稿',kind:'freewrite',stage:'draft',sources:[],draftRevision:10};button('重试读取草稿').click();await until(()=>body()?.value==='恢复草稿');assert(!createButton().disabled,'retry restores draft before enabling navigation');button('取消').click();await until(()=>!body());passed.push('restore blocks navigation and retries safely');
 await checkMissingSource();
 assert(document.querySelectorAll('.sw-row').length<40,'large library has bounded DOM');
 const list=document.querySelector('.sw-list-items');list.scrollTop=list.scrollHeight;list.dispatchEvent(new Event('scroll',{bubbles:true}));
 await until(()=>document.querySelector('[data-material-index="4399"]'));assert(document.querySelectorAll('.sw-row').length<40,'scrolling keeps bounded DOM');
 document.querySelector('[data-material-index="4399"]').focus();document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true}));
 await until(()=>document.activeElement.dataset.materialIndex==='0');
 const search=document.querySelector('input[type="search"]');
 const searchFor=value=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(search,value);search.dispatchEvent(new Event('input',{bubbles:true}));};
 searchFor('素材 4399');await until(()=>document.querySelectorAll('.sw-search-result').length===1);assert(document.querySelector('.sw-search-result').textContent.includes('4399'),'search covers unmounted records');
 searchFor('');await until(()=>document.querySelector('.sw-count').textContent.startsWith('4400'));assert(list.scrollTop===0,'filter resets virtual scroll');
 passed.push('4400 records: bounded DOM, last row and keyboard navigation');
 readGate=new Promise(resolve=>releaseRead=resolve);document.querySelector('[data-material-index="0"]').click();await pause(30);createButton().click();await until(body);releaseRead();readGate=null;await pause(40);assert(body(),'late record read cannot replace a new draft');passed.push('new draft wins over delayed read');await pause(20);writes.length=0;
 // More than one idle interval in total, but never idle for a full second.
 for(let i=1;i<=8;i++){type('连续输入'.repeat(i));await pause(200);}
 assert(writes.length===0,'continuous input must not sync');assert(JSON.parse(localStorage.getItem('shiwen-editor-draft:library')||'null')?.deleted,'continuous input must not serialize a new draft');
 await pause(1100);assert(writes.length===1&&remote.body==='连续输入'.repeat(8),'idle writes latest text once');passed.push('continuous input + idle save');
 type('关闭前的最后一个字');window.dispatchEvent(new Event('pagehide'));
 assert(JSON.parse(localStorage.getItem('shiwen-editor-draft:library')).body==='关闭前的最后一个字','pagehide stores last character synchronously');await pause(20);passed.push('pagehide flush');
 type('切换页前');root.unmount();assert(JSON.parse(localStorage.getItem('shiwen-editor-draft:library')).body==='切换页前','unmount flushes');
 root=createRoot(document.getElementById('root'));root.render(<Page/>);await until(()=>body()?.value==='切换页前');passed.push('navigation + restore');
 type('立即手动保存');await pause(20);saveGate=new Promise(resolve=>releaseSave=resolve);button('保存').click();await until(()=>saved?.body==='立即手动保存');assert(createButton().disabled,'creation blocked during save');createButton().click();document.querySelector('[data-material-index="0"]')?.click();assert(body()?.value==='立即手动保存','record selection cannot replace saving draft');releaseSave();saveGate=null;await pause(1200);
 assert(remote===null&&JSON.parse(localStorage.getItem('shiwen-editor-draft:library')||'null')?.deleted,'explicit save cancels delayed draft');passed.push('save cannot resurrect draft');
 button('编辑').click();await until(body);type('取消修改');await pause(20);button('取消').click();await pause(1200);
 assert(remote===null&&JSON.parse(localStorage.getItem('shiwen-editor-draft:library')||'null')?.deleted,'cancel cannot resurrect draft');passed.push('cancel clears delayed draft');
 const pane=document.querySelector('.sw-detail'),header=pane.querySelector('.sw-detail-head');const readingLeft=pane.getBoundingClientRect().left,readingTitle=pane.querySelector('h2').getBoundingClientRect().left;
 const longContent=document.createElement('div');longContent.style.height='2000px';pane.append(longContent);
 pane.scrollTop=700;await pause(40);
 assert(Math.abs(header.getBoundingClientRect().top-pane.getBoundingClientRect().top)<3,'reading actions stay visible while scrolling');
 longContent.remove();pane.scrollTop=0;button('编辑').click();await until(body);await pause(40);
 if(innerWidth>760){
  assert(getComputedStyle(document.querySelector('.sw-record-workspace')).padding==='0px','desktop workspace has no editing padding');
  assert(Math.abs(pane.getBoundingClientRect().left-readingLeft)<1,'list boundary remains stable while editing');
  assert(Math.abs(document.querySelector('.sw-editor-title input').getBoundingClientRect().left-readingTitle)<3,'title stays aligned while editing');
  const editorBox=body().getBoundingClientRect(),paneBox=pane.getBoundingClientRect();
  assert(editorBox.width>=Math.min(650,paneBox.width-90)&&editorBox.width<=Math.min(820,paneBox.width),`editor follows readable canvas width (${editorBox.width}/${paneBox.width})`);
  assert(editorBox.height>=Math.min(300,paneBox.height*.4),`editor retains a usable writing area (${editorBox.height}/${paneBox.height})`);
 }
 const filler=document.createElement('div');filler.style.height='1000px';filler.style.flexShrink='0';pane.append(filler);pane.scrollTop=500;await pause(40);
 const saveButton=button('保存'),saveBox=saveButton.getBoundingClientRect();
 assert(saveBox.top>=pane.getBoundingClientRect().top&&saveBox.bottom<=pane.getBoundingClientRect().bottom,'save action stays visible while scrolling');
 filler.remove();passed.push('large editor and sticky read/edit actions');
 // A successful write followed by a failed read must never leave a new draft
 // in a state where another save creates a duplicate record.
 type('成功后重读失败');await pause(20);failNextSave=true;button('保存').click();await until(()=>document.querySelector('[role=alert]')?.textContent.includes('save failed'));assert(body()?.value==='成功后重读失败','failed save retains editor and text');passed.push('failed save retains draft');failNextRead=true;button('保存').click();await until(()=>button('重新读取'));
 assert(!body()&&button('编辑').disabled,'failed read leaves saved record protected');assert(saved.body==='成功后重读失败','write succeeded before read failed');
 button('重新读取').click();await until(()=>button('编辑')&&!button('编辑').disabled);passed.push('saved identity survives failed read');
 button('编辑').click();await until(body);type('清理远端失败');await pause(1100);failNextClear=true;
 if(innerWidth>760)body().dispatchEvent(new KeyboardEvent('keydown',{key:'s',ctrlKey:true,bubbles:true,cancelable:true}));else button('保存').click();
 await until(()=>!body());await until(()=>document.querySelector('[role=alert]')?.textContent.includes('草稿清理失败'));
 assert(remote?.body==='清理远端失败'&&JSON.parse(localStorage.getItem('shiwen-editor-draft:library')).deleted,'local tombstone wins over failed remote clear');
 root.unmount();root=createRoot(document.getElementById('root'));root.render(<Page/>);await until(()=>createButton()&&!createButton().disabled);assert(!body(),'old remote draft is not restored after failed clear');passed.push('failed remote clear retains tombstone and shortcut saves');
 await checkDelayedCreateReceipt();

}
run().then(()=>{const out=document.createElement('pre');out.id='result';out.textContent=JSON.stringify({passed});document.body.append(out);}).catch(error=>{const out=document.createElement('pre');out.id='result';out.textContent=JSON.stringify({error:error.message,passed});document.body.append(out);});
