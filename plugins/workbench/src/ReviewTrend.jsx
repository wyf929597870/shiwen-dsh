import React,{useEffect,useMemo,useRef,useState} from 'react';
import {goalDefinitions,reviewGoalDays,goalSummary} from './review-goals.mjs';

export function ReviewTrend({preview,daily=[],t=(a)=>a,onOpen,metric='original',onMetricChange}){
 const [selected,setSelected]=useState(''),scroll=useRef(null);
 useEffect(()=>{if(scroll.current)scroll.current.scrollLeft=scroll.current.scrollWidth;},[preview]);
 const days=useMemo(()=>reviewGoalDays(preview),[preview]);
 const goal=goalDefinitions.find(g=>g.id===metric),summary=goal?goalSummary(days,metric):null;
 const fmt=n=>Number(n).toLocaleString(undefined,{maximumFractionDigits:1});
 const unit=goal?t(goal.unit,goal.unitEn):metric==='original'?t('字','chars'):t('条','records');
 const point=d=>goal?(d.goals[metric]||{value:null,completed:false,recorded:false}):{value:metric==='original'?preview.daily.find(x=>x.day===d.day)?.personalOriginalCharacters??0:daily.find(x=>x.day===d.day)?.collected??0,recorded:true};
 const display=v=>v.value!=null?`${fmt(v.value)} ${unit}`:v.completed?(goal?.unit==='天'?t('已完成','Done'):t('已完成 · 数值未记录','Done · quantity not recorded')):v.recorded?t('未勾选','Unchecked'):t('未记录','Not recorded');
 const max=Math.max(1,...days.map(d=>point(d).value??0));
 const selectedDay=days.find(d=>d.day===selected)||(days.length===1?days[0]:null);
 const total=days.reduce((n,d)=>n+(point(d).value??0),0);
 const hasReadingNotes=days.some(d=>d.records.some(r=>r.kind==='reading_note'));
 const hasPublication=days.some(d=>d.goals.publication?.recorded);
 return <section className="sw-goals" aria-label={t('每日趋势与日目标','Daily trends and goals')}>
  <header className="sw-goals-head"><h2>{days.length===1?t('日目标','Daily goals'):t('每日趋势','Daily trends')}</h2>{days.length>1&&<select aria-label={t('统计项目','Metric')} value={metric} onChange={e=>onMetricChange(e.target.value)}>
   <option value="original">{t('个人原文','Personal originals')}</option>
   {goalDefinitions.filter(g=>g.id!=='publication'||hasPublication||metric==='publication').map(g=><option value={g.id} key={g.id}>{t(g.label,g.en)}</option>)}
   <option value="collected">{t('收集素材','Collection')}</option>
  </select>}</header>
  {days.length>1&&<>
  <div className="sw-goals-summary" aria-live="polite">{goal?<>
   <strong>{goal.unit==='天'?`${summary.completedDays} ${t('天完成','days completed')}`:summary.total==null?t('暂无数值记录','No quantities recorded'):`${fmt(summary.total)} ${unit}`}</strong>
   <span>{goal.unit!=='天'&&`${t('完成','Completed')} ${summary.completedDays} ${t('天','days')} · `}{t('已记录','Recorded')} {summary.recordedDays}/{days.length} {t('天','days')}</span>
   {summary.average!=null&&<span>{t('数值日均','Average on quantified days')} {fmt(summary.average)} {unit} · {summary.numericDays} {t('天有数值','quantified days')}</span>}
  </>:<><strong>{t('日均','Daily average')} {fmt(days.length?total/days.length:0)} {unit}</strong><span>{t('按内容日期 · 点击日期查看当天','By content date · select a day for details')}</span></>}</div>
  {goal&&<p className="sw-goals-caption">{goal.unit==='天'?t('勾选表示完成；空白与缺失分别显示。','Check marks indicate completion; blanks and missing records are distinct.'):summary.checkOnlyDays?`${summary.checkOnlyDays} ${t('天仅记录完成，未计入数值及日均。','days have completion only, excluded from quantities and averages.')}`:t('勾选计完成天数；时长取打卡数值，字数取对应文件或明确记录。','Durations use checklist quantities; character counts use matching files or explicit entries.')}</p>}
  <div className="sw-goals-scroll" ref={scroll}><div className="sw-goals-bars">{days.map(d=>{const v=point(d),check=v.completed&&v.value==null;return <button type="button" key={d.day} className="sw-goals-day" aria-pressed={selectedDay?.day===d.day} aria-label={`${d.day} · ${display(v)}`} onClick={()=>setSelected(d.day)}>
   <span className="sw-goals-value">{v.value!=null?fmt(v.value):check?'\u00a0':v.recorded?'○':'—'}</span>
   <span className="sw-goals-track">{v.value!=null&&<i style={{height:`${v.value/max*100}%`}}/>}{check&&<span className="sw-goals-check">✓</span>}</span>
   <time dateTime={d.day}>{d.day.slice(5).replace('-','/')}</time>
  </button>;})}</div></div>
  <div className="sw-goals-footer"><span>{goal?t('✓ 仅完成　○ 未勾选　— 未记录','✓ Done only　○ Unchecked　— Not recorded'):t('选择日期查看日目标','Select a date to view daily goals')}</span><label>{t('查看某天','View day')} <input type="date" aria-label={t('查看某天','View day')} min={days[0]?.day} max={days.at(-1)?.day} value={selectedDay?.day||''} onInput={e=>setSelected(e.currentTarget.value)} onChange={e=>setSelected(e.target.value)}/></label></div>
  </>}
  {selectedDay&&<div className="sw-goals-detail"><header><h3>{selectedDay.day}</h3>{days.length>1&&<button onClick={()=>setSelected('')}>{t('收起','Collapse')}</button>}</header><dl>{goalDefinitions.filter(g=>g.id!=='publication'||selectedDay.goals.publication).map(g=>{const v=selectedDay.goals[g.id];return <div key={g.id}><dt>{t(g.label,g.en)}</dt><dd>{v?.value!=null?`${fmt(v.value)} ${t(g.unit,g.unitEn)}`:v?.completed?(g.unit==='天'?t('已完成','Done'):t('已完成 · 数值未记录','Done · no quantity')):v?.recorded?t('未勾选','Unchecked'):t('未记录','Not recorded')}</dd></div>;})}</dl>
   <div className="sw-goals-records">{selectedDay.records.map(r=><button key={r.id} onClick={()=>onOpen(r.id)}>{t('查看','Read')} · {r.title||t('未命名','Untitled')}</button>)}{!selectedDay.records.length&&<p>{t('当天没有个人记录。','No personal records for this day.')}</p>}</div>
  </div>}
  {(metric==='notes'||days.length===1)&&!hasReadingNotes&&<p className="sw-goals-caption">{t('在「读书笔记」记录感想后，这里会显示字数；原文摘录和历史混合资料不计入此项。','Save reflections in Reading notes to see character counts here; excerpts and mixed historical materials are excluded.')}</p>}
  <details className="sw-goals-help"><summary>{t('记录与统计说明','Recording and counting')}</summary><p>{t('沿用日记中的「项目 / 状态」表格：看书、运动可填 30 分钟或 1 小时；旧的 ✓、√、✅ 继续计入完成天数。空白是未勾选，缺少项目是未记录。','Use the journal’s 项目 / 状态 table. Enter 30 分钟 or 1 小时 for reading/exercise; legacy check marks still count completed days. Blank cells are unchecked; missing rows are unrecorded.')}</p><p>{t('日记与自由书写按各自独立文件的内容日期和现有字数统计；同一天多份自由书写合计。日记里的打卡和同名段落不增加或覆盖自由书写字数；只有勾选、没有对应文件时保留完成状态，字数不推算。读书笔记只接收独立分类的个人原文；同一天有对应文件时，使用文件字数，不叠加打卡字数。没有对应文件时保留打卡中明确填写的字数或完成状态。历史混合资料不自动归类。各项数值不与上方个人原文字数再次相加。','Journal and freewriting use their respective saved files, existing character counts and content dates. Multiple freewriting files on one day are summed. Journal checklist entries and similarly named sections never add to or override freewriting counts. Checks without matching files retain completion without inventing quantities. Reading notes use personal originals in their dedicated category. On days with matching files, their counts replace checklist quantities. Otherwise, explicit checklist quantities or completion are retained. Mixed historical materials are not automatically classified. Do not add these metrics to the personal-original total above.')}</p></details>
 </section>;
}
