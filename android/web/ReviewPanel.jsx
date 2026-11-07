import React, {useCallback, useEffect, useState} from 'react';
import {call} from '../bridge/library.mjs';
import {useI18n} from './i18n.js';
import './record.css';

const emptyReport={totals:{},daily:[],isComplete:false,completeThrough:null,localPending:0};
const metric=(value,suffix='')=>`${Number(value||0).toLocaleString()}${suffix}`;
const localMonth=()=>{const date=new Date();return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}`;};
export function ReviewPanel({libraryId,onOpenRecord}) {
  const {t}=useI18n();
  const [period,setPeriod]=useState('7'),[month,setMonth]=useState(localMonth),[report,setReport]=useState(null),[loading,setLoading]=useState(true),[error,setError]=useState('');
  const load=useCallback(async()=>{
    if(!libraryId)return;setLoading(true);setError('');
    try{const result=await call('review',{libraryId,period,month:period==='month'?month:undefined});setReport(result);}
    catch(e){setError(String(e.message||e));}
    finally{setLoading(false);}
  },[libraryId,period,month]);
  useEffect(()=>{load();},[load]);
  const totals=report?.totals||{},days=report?.daily||[],maxChars=Math.max(1,...days.map(item=>Number(item.added||0)));
  return <section className="review-page">
    <div className="review-period"><select aria-label={t('回顾范围')} value={period} onChange={e=>setPeriod(e.target.value)}>{[['1','今日'],['7','近 7 天'],['14','近 14 天'],['30','近 30 天'],['month','自然月']].map(([value,label])=><option key={value} value={value}>{t(label)}</option>)}</select>{period==='month'&&<input type="month" value={month} onChange={e=>setMonth(e.target.value)} aria-label={t('选择自然月')}/>}<button className="chip" onClick={load} disabled={loading}>{loading?t('更新中…'):t('刷新')}</button></div>
    {!report&&loading&&<p className="empty-state">{t('正在读取回顾…')}</p>}
    {report&&<>
    {!report.isComplete&&<div className="review-incomplete" role="status">{t('统计还未覆盖完整历史')}{report.completeThrough?`，${t('已完整至')} ${report.completeThrough}`:'。'}{report.localPending?` · ${report.localPending} ${t('条本机待同步修改也已纳入。')}`:''}</div>}
    <div className="review-metrics">
      <article><span>{t('个人新增字数')}</span><strong>{metric(totals.added,t('字'))}</strong><small>{t('移除')} {metric(totals.removed,t('字'))} · {t('净新增')} {metric(totals.net,t('字'))}</small></article>
      <article><span>{t('个人记录')}</span><strong>{metric(totals.personalRecords,t('条'))}</strong><small>{t('日记、想法与自由书写')}</small></article>
      <article><span>{t('收集素材')}</span><strong>{metric(totals.collected,t('条'))}</strong><small>{t('网页')} {metric(totals.web)} · {t('AI 讨论')} {metric(totals.ai)}</small></article>
      <article><span>{t('文章')}</span><strong>{metric(totals.articles,t('篇'))}</strong><small>{t('已定稿')} {metric(totals.finalized,t('篇'))}</small></article>
    </div>
    <section className="review-chart"><header><h2>{t(period==='1'?'今日':period==='month'?'自然月':`近 ${period} 天`)}{' '}{t('写作与收集')}</h2><span className="secondary">{t('个人新增字数按编辑活动日统计')}</span></header>{days.length?<div className="review-bars">{days.map(item=><div className="review-day" key={item.day} title={`${item.day} · ${t('新增')} ${item.added||0} ${t('字')} · ${t('收集')} ${item.collected||0} ${t('条')}`}><div className="review-bar-area"><div className="review-bar" style={{height:`${Math.max(2,Number(item.added||0)/maxChars*100)}%`}}/><div className="review-collect-mark" style={{height:`${Math.min(60,Number(item.collected||0)*7)}%`}}/></div><time>{String(item.day||'').slice(5)}</time><small>{metric(item.added)}</small></div>)}</div>:<p className="empty-state">{loading?t('正在读取回顾…'):t('这段时间还没有记录活动。')}</p>}</section>
    <section className="review-details"><header><h2>{t('本期记录')}</h2><span className="secondary">{t('历史导入按内容日期归档')}</span></header>{days.map(item=><div className="review-day-detail" key={`detail-${item.day}`}><time>{item.day}</time><span>{t('新增')} {metric(item.added,t('字'))}</span><span>{t('收集')} {metric(item.collected,t('条'))}</span>{Number(item.historical)>0&&<span>{t('历史内容')} {metric(item.historical,t('字'))}</span>}</div>)}{!days.length&&<p className="empty-state">{t('没有可显示的逐日数据。')}</p>}</section>
    <div className="review-footnote">{t('个人新增不包含 AI 内容、外部资料和历史导入。同步到达的历史修改按原编辑日期计入，不按同步日期重复统计。')}</div>
    </>}
    {error&&<p className="error" role="alert">{error}</p>}
  </section>;
}
