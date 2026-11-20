import React from '../../android/node_modules/react/index.js';
import {createRoot} from '../../android/node_modules/react-dom/client.js';
import {SettingsPanel} from '../../android/web/SettingsPanel.jsx';
import '../../android/web/style.css';
export const isNative=true;
let refreshed=0;
const snapshot=()=>({items:[{id:'n',name:'示例服务',baseUrl:'https://example.test',authenticated:true,profileSyncStatus:refreshed?'synced':'cached',profileUpdatedAt:'2026-11-12T07:00:00Z',profileMemoryCount:3}],activeId:'n'});
export async function call(method){if(method==='nodeList')return snapshot();if(method==='nodeProfileRefresh'){refreshed++;return snapshot();}if(method==='modelConfig')return {};if(method==='settingsGet')return {theme:'light',language:'zh-CN'};throw Error('Unexpected '+method);}
const until=async f=>{for(let i=0;i<150;i++){if(f())return;await new Promise(r=>setTimeout(r,10));}throw Error('Timeout');};
const button=label=>[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===label);
createRoot(document.getElementById('root')).render(<SettingsPanel ready libraryId="lib" initialPage="services"/>);
(async()=>{await until(()=>button('同步人格与记忆'));if(!document.body.textContent.includes('上次成功同步')||!document.body.textContent.includes('仅有上次缓存'))throw Error('Cached status and sync time should be visible');button('同步人格与记忆').click();await until(()=>document.body.textContent.includes('人格和已确认记忆同步成功'));if(refreshed!==1||!document.body.textContent.includes('最近同步成功'))throw Error('Sync result was not shown');document.getElementById('result').textContent=JSON.stringify({passed:true});})().catch(e=>document.getElementById('result').textContent=JSON.stringify({error:e.stack}));
