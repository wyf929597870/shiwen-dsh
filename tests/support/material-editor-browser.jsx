import React from 'react';
import {createRoot} from 'react-dom/client';
import {apply} from '../../plugins/workbench/src/client.jsx';
const assert=(ok,message)=>{if(!ok)throw Error(message);};
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check){for(let i=0;i<100;i++){if(check())return;await pause(20);}throw Error('Timed out: '+check);}
const passed=[],writes=[];let Page,remote=null,saved=null;
const records=Array.from({length:2000},(_,i)=>({id:String(i),title:'素材 '+i,body:'测试正文',kind:'freewrite',revision:1}));
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
 await until(()=>button('＋ 新建'));button('＋ 新建').click();await until(body);await pause(20);writes.length=0;
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
}
run().then(()=>{const out=document.createElement('pre');out.id='result';out.textContent=JSON.stringify({passed});document.body.append(out);}).catch(error=>{const out=document.createElement('pre');out.id='result';out.textContent=JSON.stringify({error:error.message,passed});document.body.append(out);});
