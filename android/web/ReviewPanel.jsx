import React, {useCallback, useEffect, useRef, useState} from 'react';
import {call} from '../bridge/library.mjs';
import {useI18n} from './i18n.js';
import './record.css';
import '../../plugins/workbench/src/review-goals.css';
import {ReviewTrend} from '../../plugins/workbench/src/ReviewTrend.jsx';
import {RecordPreview} from '../../plugins/workbench/src/ReviewPage.jsx';
import MarkdownIt from 'markdown-it';
const md=new MarkdownIt({html:false});

const metric=(value,suffix='')=>`${Number(value||0).toLocaleString()}${suffix}`;
const localMonth=()=>{const date=new Date();return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}`;};
export function ReviewPanel({libraryId,request=call}) {
  const {t}=useI18n();
  const [period,setPeriod]=useState('7'),[month,setMonth]=useState(localMonth),[report,setReport]=useState(null),[preview,setPreview]=useState(null),[loading,setLoading]=useState(true),[error,setError]=useState(''),[selected,setSelected]=useState(null),[trendMetric,setTrendMetric]=useState('original');
  const loadSequence=useRef(0);
  const load=useCallback(async()=>{
    if(!libraryId)return;const sequence=++loadSequence.current;setLoading(true);setError('');setReport(null);setPreview(null);setSelected(null);
    try{const args={libraryId,period,month:period==='month'?month:undefined};const [result,originals]=await Promise.all([request('review',args),request('reviewPreview',args)]);if(sequence!==loadSequence.current)return;setReport(result);setPreview(originals);}
    catch(e){if(sequence===loadSequence.current)setError(String(e.message||e));}
    finally{if(sequence===loadSequence.current)setLoading(false);}
  },[libraryId,period,month,request]);
  useEffect(()=>{load();return()=>{loadSequence.current++;};},[load]);
  const totals=report?.totals||{};
  const originals=preview?.records||[],edits=preview?.observedEdits||{};
  return <section className="review-page">
    <div className="review-period"><select aria-label={t('回顾范围')} value={period} onChange={e=>setPeriod(e.target.value)}>{[['1','今日'],['7','近 7 天'],['14','近 14 天'],['30','近 30 天'],['month','自然月']].map(([value,label])=><option key={value} value={value}>{t(label)}</option>)}</select>{period==='month'&&<input type="month" value={month} onChange={e=>setMonth(e.target.value)} aria-label={t('选择自然月')}/>}<button className="chip" onClick={load} disabled={loading}>{loading?t('更新中…'):t('刷新')}</button></div>
    {!report&&loading&&<p className="empty-state">{t('正在读取回顾…')}</p>}
    {report&&<>
    <div className="review-metrics">
      <article><span>{t('个人原文字数','Personal original characters')}</span><strong>{metric(preview.personalOriginalCharacters,t('字'))}</strong><small>{t('按内容日期统计当前保存的个人原文','Current personal originals by content date')}</small></article>
      <article><span>{t('个人原文记录','Personal original records')}</span><strong>{metric(originals.length,t('条'))}</strong><small>{t('包含通过 MCP 保存的个人原文','Includes personal originals saved through MCP')}</small></article>
      <article><span>{t('收集素材')}</span><strong>{metric(totals.collected,t('条'))}</strong><small>{t('网页')} {metric(totals.web)} · {t('AI 讨论')} {metric(totals.ai)}</small></article>
      <article><span>{t('文章')}</span><strong>{metric(totals.articles,t('篇'))}</strong><small>{t('已定稿')} {metric(totals.finalized,t('篇'))}</small></article>
    </div>
    <section className="review-chart"><ReviewTrend metric={trendMetric} onMetricChange={setTrendMetric} preview={preview} daily={report.daily} t={t} onOpen={setSelected}/></section>
    <details className="sw-goals-fold"><summary>{t('个人原文明细','Personal original details')} · {originals.length}</summary><section className="review-details"><header><h2>{t('个人原文明细','Personal original details')}</h2><span className="secondary">{t('包含个人导入资料，按内容日期归档','Includes imported personal records, by content date')}</span></header>{originals.map(item=><div className="review-day-detail" key={item.id}><time>{item.contentDay}</time><span>{item.title||t('未命名')}</span><span>{metric(item.characters,t('字'))}</span></div>)}{!originals.length&&<p className="empty-state">{t('这段时间没有个人原文。','No personal originals in this period.')}</p>}</section></details>
    <details className="sw-goals-fold"><summary>{t('编辑统计','Edit statistics')}</summary><section className="review-details"><h2>{t('已观察到的个人编辑','Observed personal edits')}</h2><p>{t('新增')} {metric(edits.added,t('字'))} · {t('删减','Removed')} {metric(edits.removed,t('字'))} · {t('净变化','Net change')} {metric(edits.net,t('字'))}</p><p className="secondary">{t('按实际编辑时间计算，导入与资料整理不算新增写作；不与原文字数相加。','Uses actual edit dates; imports and archival cleanup are not new writing. Do not add this to original character totals.')}</p></section></details>
    <div className="review-footnote">{t('按内容日期统计当前保存的个人原文，不含独立 AI 标注。按非空白字符计数，含标点及正文中的 Markdown 标记；不是当天键入量或历史快照。','Counts current personal originals by content date, excluding separate AI annotations. Includes non-whitespace characters, punctuation and Markdown in the body; this is not keystrokes or a historical snapshot.')}</div>
    </>}
    {selected&&<RecordPreview key={libraryId+selected} id={selected} rpc={(_,args)=>request('recordRead',{libraryId,...args})} md={md} t={t} onClose={()=>setSelected(null)}/>}
    {error&&<p className="error" role="alert">{error}</p>}
  </section>;
}
