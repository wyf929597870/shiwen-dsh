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
 await until(()=>[...document.querySelectorAll('dialog summary')].some(p=>p.textContent.includes('已有回应')));
 await click('关闭 ×');await click('关闭 ×');
 const daily=await until(()=>document.querySelector('.sw-daily .sw-rec-card'));
 if(!daily.textContent.includes('我把书留在刚才那一页。')||!daily.textContent.includes('可能有关的后续'))throw Error('卡片缺少上次回应或新段落');
 daily.click();await click('接着写');
 await until(()=>document.querySelector('dialog textarea')?.parentElement.parentElement.textContent.includes('我把书留在刚才那一页。'));
 await click('取消');await click('这篇无关');
 await until(()=>buttons().filter(b=>b.textContent==='关联为回应').length===1);
 await click('关联为回应');await until(()=>buttons().every(b=>b.textContent!=='关联为回应'));
 const writeField=async(selector,value)=>{
  const el=await until(()=>document.querySelector('.sw-step-form '+selector));
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el),'value').set.call(el,value);
  el.dispatchEvent(new Event('input',{bubbles:true}));
 };
 const confirmStep=async label=>{await click(label);await until(()=>!document.querySelector('.sw-step-form'));};
 const fromLast=await until(()=>[...document.querySelectorAll('dialog article')].find(el=>el.querySelector('small')?.textContent.startsWith('上次回应')));
 [...fromLast.querySelectorAll('button')].find(b=>b.textContent==='追问一句').click();
 await writeField('textarea','为什么这次能继续？');await confirmStep('保存追问');await click('关闭 ×');
 (await until(()=>[...document.querySelectorAll('.sw-daily .sw-rec-card')].find(b=>b.textContent.includes('为什么这次能继续？')))).click();
 await writeField('textarea','我还记得停在了哪一页。');await confirmStep('保存判断');
 const active=()=>document.querySelector('.sw-steps article');
 [...active().querySelectorAll('button')].find(b=>b.textContent==='试一次').click();
 await writeField('textarea','下次离开前留张书签');await writeField('input:not([type])','回来能读几页？');
 await confirmStep('保存尝试');await click('关闭 ×');
 (await until(()=>[...document.querySelectorAll('.sw-daily .sw-rec-card')].find(b=>b.textContent.includes('回来能读几页？')))).click();
 await writeField('textarea','今天回来读了两页。');await confirmStep('保存结果');
 if(!active().textContent.includes('今天回来读了两页。'))throw Error('结果没有回到当前探索');
 await click('略过');await until(()=>buttons().some(b=>b.textContent==='撤销略过'));
 await click('关闭 ×');await until(()=>!document.querySelector('.sw-daily .sw-rec-card'));
 document.querySelector('#result').textContent='passed';
})().catch(e=>document.querySelector('#result').textContent=e.message);
