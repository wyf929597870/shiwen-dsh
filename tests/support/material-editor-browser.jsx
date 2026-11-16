import React from 'react';
import {createRoot} from 'react-dom/client';
import {apply} from '../../plugins/workbench/src/client.jsx';
const assert=(ok,message)=>{if(!ok)throw Error(message);};
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check){for(let i=0;i<100;i++){if(check())return;await pause(20);}throw Error('Timed out: '+check);}
const passed=[],writes=[];let Page,remote=null,saved=null;
const records=Array.from({length:4400},(_,i)=>({id:String(i),title:'素材 '+i,body:'测试正文',kind:'freewrite',revision:1}));
window.confirm=()=>true;
window.fetch=async(_url,options)=>{
 const {method,args}=JSON.parse(options.body);let result;
 if(method==='snapshot')result={records};
 else if(method==='workbenchDraft'){if('value' in args){writes.push(args);remote=args.value;}result={value:remote,revision:0};}
 else if(method==='saveMarkdown'){saved=args;result={id:'0'};}
 else if(method==='readMarkdown')result={...records[0],markdown:saved?.body||'测试正文'};
 else throw Error('Unexpected RPC '+method);
 return {ok:true,json:async()=>({result})};
};
apply({locale:{subscribe:()=>()=>{},getSnapshot:()=>({active:'zh'})},uiWorkspace:{},layout:{},effect:fn=>fn(),slots:{inject:(_name,fn)=>fn(),register:(config,component)=>{if(config.key==='shiwen-library')Page=component;}}});
let root=createRoot(document.getElementById('root'));root.render(<Page/>);
const button=text=>[...document.querySelectorAll('button')].find(el=>el.textContent.trim()===text);
const body=()=>document.querySelector('textarea[aria-label="正文"]');
function type(value){const input=body();Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));assert(input.value===value,'typing appears immediately');}
async function run(){
 await until(()=>document.querySelectorAll('.sw-row').length>0);
 assert(document.querySelectorAll('.sw-row').length<40,'large library has bounded DOM');
 const list=document.querySelector('.sw-list-items');list.scrollTop=list.scrollHeight;list.dispatchEvent(new Event('scroll',{bubbles:true}));
 await until(()=>document.querySelector('[data-material-index="4399"]'));assert(document.querySelectorAll('.sw-row').length<40,'scrolling keeps bounded DOM');
 document.querySelector('[data-material-index="4399"]').focus();document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true}));
 await until(()=>document.activeElement.dataset.materialIndex==='0');
 const search=document.querySelector('input[type="search"]');
 const searchFor=value=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(search,value);search.dispatchEvent(new Event('input',{bubbles:true}));};
 searchFor('素材 4399');await until(()=>document.querySelectorAll('.sw-row').length===1);assert(document.querySelector('.sw-row').textContent.includes('4399'),'search covers unmounted records');
 searchFor('');await until(()=>document.querySelector('.sw-count').textContent.startsWith('4400'));assert(list.scrollTop===0,'filter resets virtual scroll');
 passed.push('4400 records: bounded DOM, last row and keyboard navigation');
 button('＋ 新建').click();await until(body);await pause(20);writes.length=0;
 // More than one idle interval in total, but never idle for a full second.
 for(let i=1;i<=8;i++){type('连续输入'.repeat(i));await pause(200);}
 assert(writes.length===0,'continuous input must not sync');assert(!localStorage.getItem('shiwen-editor-draft:library'),'continuous input must not serialize');
 await pause(1100);assert(writes.length===1&&remote.body==='连续输入'.repeat(8),'idle writes latest text once');passed.push('continuous input + idle save');
 type('关闭前的最后一个字');window.dispatchEvent(new Event('pagehide'));
 assert(JSON.parse(localStorage.getItem('shiwen-editor-draft:library')).body==='关闭前的最后一个字','pagehide stores last character synchronously');await pause(20);passed.push('pagehide flush');
 type('切换页前');root.unmount();assert(JSON.parse(localStorage.getItem('shiwen-editor-draft:library')).body==='切换页前','unmount flushes');
 root=createRoot(document.getElementById('root'));root.render(<Page/>);await until(()=>body()?.value==='切换页前');passed.push('navigation + restore');
 type('立即手动保存');await pause(20);button('保存').click();await until(()=>saved?.body==='立即手动保存');await pause(1200);
 assert(remote===null&&!localStorage.getItem('shiwen-editor-draft:library'),'explicit save cancels delayed draft');passed.push('save cannot resurrect draft');
 button('编辑').click();await until(body);type('取消修改');await pause(20);button('取消').click();await pause(1200);
 assert(remote===null&&!localStorage.getItem('shiwen-editor-draft:library'),'cancel cannot resurrect draft');passed.push('cancel clears delayed draft');
 const pane=document.querySelector('.sw-detail'),header=pane.querySelector('.sw-detail-head');
 const longContent=document.createElement('div');longContent.style.height='2000px';pane.append(longContent);
 pane.scrollTop=700;await pause(40);
 assert(Math.abs(header.getBoundingClientRect().top-pane.getBoundingClientRect().top)<3,'reading actions stay visible while scrolling');
 longContent.remove();pane.scrollTop=0;button('编辑').click();await until(body);await pause(40);
 if(innerWidth>760){
  const editorBox=body().getBoundingClientRect(),paneBox=pane.getBoundingClientRect();
  assert(editorBox.width>paneBox.width*.9,'editor uses available width');
  assert(editorBox.height>=paneBox.height*.55,'editor uses most available height');
 }
 const filler=document.createElement('div');filler.style.height='1000px';filler.style.flexShrink='0';pane.append(filler);pane.scrollTop=500;await pause(40);
 const saveButton=button('保存'),saveBox=saveButton.getBoundingClientRect();
 assert(saveBox.top>=pane.getBoundingClientRect().top&&saveBox.bottom<=pane.getBoundingClientRect().bottom,'save action stays visible while scrolling');
 filler.remove();passed.push('large editor and sticky read/edit actions');

}
run().then(()=>{const out=document.createElement('pre');out.id='result';out.textContent=JSON.stringify({passed});document.body.append(out);}).catch(error=>{const out=document.createElement('pre');out.id='result';out.textContent=JSON.stringify({error:error.message,passed});document.body.append(out);});
