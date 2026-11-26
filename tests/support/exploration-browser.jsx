import React from 'react';
import {createRoot} from 'react-dom/client';
import {Recommendations,WeeklyOpen} from '../../plugins/workbench/src/Recommendations.jsx';

async function rpc(method,args={}){
 const response=await fetch('/api',{method:'POST',body:JSON.stringify({method,args})});
 const data=await response.json();
 if(!response.ok)throw Error(data.error);
 return data.result;
}
createRoot(document.querySelector('#root')).render(<><WeeklyOpen rpc={rpc}/><Recommendations rpc={rpc} layout={{}}/></>);
const delay=()=>new Promise(r=>setTimeout(r,25));
async function until(fn){
 for(let n=0;n<300;n++){const result=fn();if(result)return result;await delay();}
 throw Error('页面未出现预期内容 · '+document.body.innerText);
}
const buttons=()=>[...document.querySelectorAll('dialog[open] button, #root button')];
const click=async label=>(await until(()=>buttons().filter(b=>!b.disabled&&b.textContent.trim()===label).at(-1))).click();
(async()=>{
 await click('去筛选');await click('我真的要换职业吗？');await click('略过');
 await until(()=>buttons().some(b=>b.textContent==='撤销略过'));await click('关闭 ×');
 await click('朋友看过我的草稿了吗？');await click('关联已有回应');await click('查找');
 const row=await until(()=>[...document.querySelectorAll('dialog article')].find(el=>el.innerText.includes('周六的后续')));
 if(!row.innerText.includes('把草稿交给了朋友'))throw Error('选择前没有显示可核对的原文');
 row.querySelector('button').click();await until(()=>document.querySelector('dialog')&&document.body.innerText.includes('已有回应'));
 await click('关闭 ×');await click('阅读被打断后怎么办？');await click('收下并放到今天');
 await until(()=>buttons().some(b=>b.textContent==='撤下今天'));
 await click('接着写');
 const box=await until(()=>document.querySelector('dialog textarea'));
 if(box.value!=='')throw Error('回应编辑器预填了正文');
 Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(box,'我把书留在刚才那一页。');
 box.dispatchEvent(new Event('input',{bubbles:true}));await click('保存');
 await until(()=>[...document.querySelectorAll('dialog p')].some(p=>p.textContent.includes('已有回应')));
 await click('关闭 ×');await click('关闭 ×');
 (await until(()=>document.querySelector('.sw-daily .sw-rec-card'))).click();
 await click('略过');await until(()=>buttons().some(b=>b.textContent==='撤销略过'));
 await click('关闭 ×');await until(()=>!document.querySelector('.sw-daily .sw-rec-card'));
 document.querySelector('#result').textContent='passed';
})().catch(e=>document.querySelector('#result').textContent=e.message);
