import React,{useEffect,useState,useSyncExternalStore} from 'react';
export function HomeOverview({rpc,locale,layout}){
 const lang=useSyncExternalStore(fn=>locale.subscribe(fn),()=>locale.getSnapshot().active),zh=String(lang).startsWith('zh'),t=(a,b)=>zh?a:b;
 const [data,setData]=useState(null),[error,setError]=useState('');
 useEffect(()=>{let live=true;const load=()=>rpc('snapshot').then(r=>{if(live){setData(r);setError('');}}).catch(()=>{if(live)setError(t('暂时无法读取资料库','Library unavailable'));});load();window.addEventListener('shiwen-library-updated',load);return()=>{live=false;window.removeEventListener('shiwen-library-updated',load);};},[]);
 if(error)return <div className="sw-home-overview"><p className="sw-muted">{error}</p></div>;
 if(!data)return null;
 const today=data.today.totals,articles=data.records.filter(r=>r.kind==='article').slice(0,2),recent=data.records.filter(r=>r.kind!=='article').slice(0,3);
 return <div className="sw-home-overview">
  <section className="sw-home-today"><header><h2>{t('今日积累','Today')}</h2><button onClick={()=>layout.selectPanel('shiwen-review')}>{t('查看回顾','Open review')}</button></header><div>{[[t('个人净增','Personal net'),today.net,t('字','chars')],[t('新增记录','New notes'),today.personalRecords,t('条','notes')],[t('收集素材','Collected'),today.collected,t('条','items')],[t('更新文章','Articles updated'),today.articles,t('篇','articles')]].map(([label,value,unit])=><div key={label}><span>{label}</span><p><strong>{value.toLocaleString()}</strong> <small>{unit}</small></p></div>)}</div></section>
  <div className="sw-home-panels"><section><header><h2>{t('继续创作','Keep writing')}</h2><button onClick={()=>layout.selectPanel('shiwen-articles')}>{t('进入创作','Open writing')}</button></header>{articles.length?articles.map(r=><div className="sw-home-row" key={r.id}><strong>{r.title}</strong><small>{r.stage==='final'?t('已定稿','Final'):t('创作中','In progress')} · {r.contentDay||t('日期待确认','Date unconfirmed')}</small></div>):<p className="sw-muted">{t('从一个想法开始，慢慢写成一篇文章。','Start with an idea and develop it into an article.')}</p>}</section><section><header><h2>{t('最近记录','Recent notes')}</h2><button onClick={()=>layout.selectPanel('shiwen-library')}>{t('查看素材','Open materials')}</button></header>{recent.length?recent.map(r=><div className="sw-home-row" key={r.id}><strong>{r.title}</strong><small>{r.contentDay||t('日期待确认','Date unconfirmed')}</small></div>):<p className="sw-muted">{t('在上方和助手聊聊，让它帮你记下今天。','Talk to your assistant above to capture your day.')}</p>}</section></div>
 </div>;
}
