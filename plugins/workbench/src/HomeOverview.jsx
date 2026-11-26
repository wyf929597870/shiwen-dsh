import {Recommendations} from './Recommendations.jsx';
import {createPortal} from 'react-dom';
import {requestRecord} from './RelatedArticles.jsx';
import React,{useEffect,useLayoutEffect,useRef,useState,useSyncExternalStore} from 'react';
import {recordSection} from '../../library/legacy/record-sections.mjs';
function RecentIndex({rpc,locale,layout}){
 const lang=useSyncExternalStore(fn=>locale.subscribe(fn),()=>locale.getSnapshot().active),zh=String(lang).startsWith('zh'),t=(a,b)=>zh?a:b;
 const [data,setData]=useState(null),[error,setError]=useState('');
 useEffect(()=>{let live=true;const load=()=>rpc('snapshot').then(r=>{if(live){setData(r);setError('');}}).catch(()=>{if(live)setError(t('暂时无法读取资料库','Library unavailable'));});load();window.addEventListener('shiwen-library-updated',load);return()=>{live=false;window.removeEventListener('shiwen-library-updated',load);};},[]);
 const rows=(data?.records??[]).filter(row=>recordSection(row.kind)).slice(0,40);
 return <aside className="sw-home-index" aria-label={t('最近内容','Recent items')}>
    <header><strong>{t('最近内容','Recent items')}</strong><button onClick={()=>layout.selectPanel('shiwen-library')}>{t('全部记录','All records')} ›</button></header>
    {error&&<p role="status">{error}</p>}
    {rows.map(row=><button className="sw-index-row" key={row.id} onClick={()=>requestRecord(row.id,layout,recordSection(row.kind))}>
      <strong>{row.title||t('未命名','Untitled')}</strong><small>{row.contentDay||t('日期待确认','Date unconfirmed')}</small><span className="sw-row-preview">{row.body?.slice(0,180)}</span>
    </button>)}
    {data&&!error&&!rows.length&&<p>{t('写下的第一条记录会出现在这里。','Your first entry will appear here.')}</p>}
  </aside>;
}
export function HomeOverview({rpc,locale,layout,composer}){
 const root=useRef(null),[host,setHost]=useState(null);
 useLayoutEffect(()=>{
  const wide=window.matchMedia('(min-width: 1150px)');
  const sync=()=>setHost(wide.matches?root.current?.closest('[data-phase] [data-conversation-content]'):null);
  sync();wide.addEventListener('change',sync);
  return()=>wide.removeEventListener('change',sync);
 },[]);
 return <div className="sw-home-overview" ref={root}>
  {host&&createPortal(<RecentIndex rpc={rpc} locale={locale} layout={layout}/>,host)}
  <Recommendations rpc={rpc} layout={layout} composer={composer}/>
 </div>;
}
