import React,{useState,useEffect,useRef} from 'react';

function Trend({daily,field,title,unit}){
 const max=Math.max(1,...daily.map(d=>Math.abs(d[field])));
 return <section className="sw-trend"><h2>{title} <small>{unit}</small></h2><div className="sw-trend-scroll"><div className="sw-trend-bars">{daily.map(d=><div className="sw-trend-day" key={d.day} title={`${d.day}: ${d[field]}`}><span>{d[field].toLocaleString()}</span><div className="sw-trend-track"><i className={d[field]<0?'negative':''} style={{height:`${Math.abs(d[field])/max*100}%`}}/></div><time dateTime={d.day}>{d.day.slice(5).replace('-','/')}</time></div>)}</div></div></section>;
}
function RecordPreview({id,rpc,md,t,onClose}){
 const dialog=useRef(null),[record,setRecord]=useState(null),[error,setError]=useState('');
 useEffect(()=>{dialog.current.showModal();let live=true;rpc('readMarkdown',{id}).then(r=>{if(live)setRecord(r);}).catch(e=>{if(live)setError(e.message);});return()=>{live=false;};},[id]);
 return <dialog className="sw-review-preview" ref={dialog} onCancel={onClose} aria-label={t('记录正文','Record content')}><header><h2>{record?.title||t('正在加载…','Loading…')}</h2><button autoFocus onClick={onClose}>{t('关闭','Close')}</button></header>{error&&<p role="alert">{error}</p>}{record&&<><p className="sw-meta">{record.contentDay||t('日期待确认','Date unconfirmed')}</p><div className="sw-markdown" dangerouslySetInnerHTML={{__html:md.render(record.markdown)}}/></>}</dialog>;
}
export function ReviewPage({rpc,language,md,typeName}){
 const zh=String(language).startsWith('zh'),t=(a,b)=>zh?a:b;
 const [period,setPeriod]=useState('7'),[month,setMonth]=useState(()=>{const now=new Date();return `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;}),[report,setReport]=useState(null),[error,setError]=useState(''),[reload,setReload]=useState(0),[tab,setTab]=useState('personal'),[selected,setSelected]=useState(null);
 useEffect(()=>{let live=true;setReport(null);setError('');rpc('review',{period,month}).then(r=>{if(live)setReport({...r,articles:[...r.articles].sort((a,b)=>b.updated.localeCompare(a.updated))});}).catch(e=>{if(live)setError(e.message);});return()=>{live=false;};},[period,month,reload]);
 useEffect(()=>{const refresh=()=>setReload(x=>x+1);window.addEventListener('shiwen-library-updated',refresh);return()=>window.removeEventListener('shiwen-library-updated',refresh);},[]);
 const fmt=n=>(n??0).toLocaleString(zh?'zh-CN':'en-US');
 const signed=n=>`${n>0?'+':''}${fmt(n)}`;
 function shiftMonth(delta){const [year,m]=month.split('-').map(Number);const next=new Date(year,m-1+delta,1);setMonth(`${next.getFullYear()}-${String(next.getMonth()+1).padStart(2,'0')}`);setPeriod('month');}
 const totals=report?.totals;
 const personal=report?.edits.filter(e=>e.origin==='personal'&&!e.deleted)??[];
 const rows=tab==='personal'?personal:tab==='collected'?report?.collected??[]:tab==='articles'?report?.articles??[]:report?.historical??[];
 return <main className="sw-view sw-review">
  <header className="sw-head"><div className="sw-panel-heading"><h1>{t('回顾','Review')}</h1><p className="sw-sub">{t('看看这段时间，写了什么，积累了什么。','Look back at what you wrote and collected.')}</p></div><button onClick={()=>setReload(x=>x+1)}>{t('刷新','Refresh')}</button></header>
  <div className="sw-review-controls"><div className="sw-period" aria-label={t('统计时间','Review period')}>{[['1','当日','Today'],['7','近7天','7 days'],['14','近14天','14 days'],['30','近30天','30 days'],['month','自然月','Month']].map(([id,cn,en])=><button key={id} aria-pressed={period===id} className={period===id?'active':''} onClick={()=>setPeriod(id)}>{t(cn,en)}</button>)}</div><div className={"sw-month"+(period==='month'?' is-active':'')}><button aria-label={t('上个月','Previous month')} onClick={()=>shiftMonth(-1)}>‹</button><input type="month" aria-label={t('自然月','Calendar month')} value={month} onChange={e=>{if(e.target.value){setMonth(e.target.value);setPeriod('month');}}}/><button aria-label={t('下个月','Next month')} onClick={()=>shiftMonth(1)}>›</button></div></div>
  {error&&<p className="sw-error" role="alert">{error}</p>}
  {!report&&!error&&<p className="sw-muted" role="status">{t('正在加载…','Loading…')}</p>}
  {report&&<><p className="sw-review-range">{report.start} — {report.end}</p>
   <div className="sw-metrics sw-review-metrics">{[
    [t('个人净增','Personal net additions'),totals.net,t('字','chars'),`${t('新增','Added')} ${fmt(totals.added)} · ${t('删减','Removed')} ${fmt(totals.removed)}`],
    [t('新增个人记录','New personal records'),totals.personalRecords,t('条','records'),t('日记、自由书写与想法','Journals, freewriting and ideas')],
    [t('收集素材','Materials collected'),totals.collected,t('条','records'),`${t('网页','Web')} ${totals.web} · ${t('AI 讨论','AI')} ${totals.ai} · ${t('参考','Reference')} ${totals.reference}`],
    [t('更新文章','Updated articles'),totals.articles,t('篇','articles'),`${t('其中定稿','Finalized')} ${totals.finalized}`]
   ].map(([label,value,unit,note])=><div key={label}><span>{label}</span><p><strong>{fmt(value)}</strong><small>{unit}</small></p><p className="sw-metric-note">{note}</p></div>)}</div>

   <div className="sw-review-grid"><div className="sw-review-card sw-trends"><Trend daily={report.daily} field="net" title={t('每日书写','Daily writing')} unit={t('个人净增 · 字','Net personal characters')}/><Trend daily={report.daily} field="collected" title={t('每日收集素材','Daily collection')} unit={t('条','records')}/></div>
    <div className="sw-review-aside"><section className="sw-review-card"><header><h2>{t('这段时间更新的文章','Articles in this period')}</h2>{report.articles.length>3&&<button className="sw-text-action" onClick={()=>{setTab('articles');document.getElementById('sw-review-details')?.scrollIntoView({block:'start'});}}>{t('全部','All')} · {report.articles.length}</button>}</header>{report.articles.length?report.articles.slice(0,3).map(r=><button className="sw-review-record" key={r.id} onClick={()=>setSelected(r.id)}><div><strong>{r.title||t('未命名','Untitled')}</strong><small>{new Date(r.updated).toLocaleDateString(zh?'zh-CN':'en-US')}</small></div><span className="sw-status">{r.stage==='final'?t('已定稿','Final'):t('创作中','In progress')}</span></button>):<p className="sw-muted">{t('这段时间还没有文章更新。','No articles updated in this period.')}</p>}</section>
     <section className="sw-review-card"><h2>{t('素材来源','Collection types')}</h2><div className="sw-sources">{[['web',t('网页素材','Web')],['ai',t('AI 讨论','AI discussions')],['reference',t('参考资料','References')]].map(([key,label])=><div key={key}><span>{label}</span><meter min="0" max={Math.max(1,totals.collected)} value={totals[key]} aria-label={label}/><small>{fmt(totals[key])}</small></div>)}</div></section>
     <section className="sw-review-card"><h2>{t('文章进展','Writing progress')}</h2><p className="sw-progress-summary">{totals.articles} {t('篇更新','updated')} · {totals.finalized} {t('篇定稿','finalized')} · {totals.articles-totals.finalized} {t('篇继续完善','in progress')}</p></section>
    </div></div>
   <section className="sw-review-card sw-review-details" id="sw-review-details"><header><h2>{t('积累明细','Activity details')}</h2><div className="sw-review-tabs">{[['personal','个人书写','Personal writing'],['collected','收集素材','Collected'],['articles','文章进展','Articles'],['history','历史导入','Imports']].map(([id,cn,en])=><button key={id} aria-pressed={tab===id} className={tab===id?'active':''} onClick={()=>setTab(id)}>{t(cn,en)}</button>)}</div></header>
    {!rows.length?<p className="sw-muted">{t('这段时间没有记录','No records in this period')}</p>:<div className="sw-review-table"><table><thead><tr><th>{t('标题','Title')}</th><th>{t('类型','Type')}</th><th>{t('记录时间','Date')}</th>{tab==='personal'&&<><th>{t('新增','Added')}</th><th>{t('删减','Removed')}</th><th>{t('净增','Net')}</th></>}</tr></thead><tbody>{rows.map((r,i)=><tr key={r.id??i}><td><button onClick={()=>setSelected(r.record??r.id)}>{r.title||t('未命名','Untitled')}</button></td><td data-label={t('类型','Type')}>{typeName(r.kind)}</td><td data-label={t('日期','Date')}>{tab==='personal'?new Date(r.at).toLocaleDateString(zh?'zh-CN':'en-US'):(r.importInfo?r.importInfo.day:r.dateInfo?r.dateInfo.day:new Date(tab==='articles'?r.updated:r.created).toLocaleDateString(zh?'zh-CN':'en-US'))||t('日期待确认','Date unconfirmed')}</td>{tab==='personal'&&<><td data-label={t('新增','Added')}>+{fmt(r.added)}</td><td data-label={t('删减','Removed')}>−{fmt(r.removed)}</td><td data-label={t('净增','Net')} className="sw-net">{signed(r.added-r.removed)}</td></>}</tr>)}</tbody></table></div>}
   </section>
   <p className="sw-review-note">{t('个人净增按编辑时间统计，仅计个人表达；历史导入按内容日期单独展示。','Net additions use edit dates and personal text only; imported history is shown separately by content date.')}</p>
<div className="sw-review-history">     <section className="sw-review-card"><h2>{t('历史积累','Historical records')}</h2><p className="sw-history-summary"><strong>{fmt(totals.historicalChars)}</strong> {t('字','chars')} <span>· {totals.historicalRecords} {t('条导入记录','imports')}</span></p><p className="sw-sub">{t('日期待确认','Dates unconfirmed')}：{fmt(report.undated)}</p></section></div>
  </>}{selected&&<RecordPreview id={selected} rpc={rpc} md={md} t={t} onClose={()=>setSelected(null)}/>}
 </main>;
}
