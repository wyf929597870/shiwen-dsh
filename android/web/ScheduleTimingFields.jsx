import React from 'react';
import {useI18n} from './i18n.js';

const zone=()=>Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC';
function initial(kind){
  const time_zone=zone();
  switch(kind){
    case 'after':return {kind,after_seconds:3600};
    case 'at':return {kind,at:{date:'',time:'09:00',time_zone}};
    case 'every':return {kind,every_seconds:3600};
    case 'daily':return {kind,daily:{time:'09:00',time_zone}};
    case 'weekly':return {kind,weekly:{time:'09:00',time_zone,weekdays:[1,2,3,4,5]}};
    case 'cron':return {kind,cron:{expression:'0 9 * * *',time_zone}};
    case 'rrule':return {kind,rrule:''};
    default:return {kind:'every',every_seconds:3600};
  }
}

/** Edits the exact DSH ScheduleTiming structure. The caller decides whether the
 * user explicitly opted into changing an existing rule; mounting never writes. */
export function ScheduleTimingFields({value,onChange,disabled=false}){
  const {t}=useI18n();
  const names={after:t('延时执行一次','Run once after a delay'),at:t('指定日期执行一次','Run once at a date and time'),every:t('固定间隔','Fixed interval'),daily:t('每天','Daily'),weekly:t('每周','Weekly'),cron:t('Cron 规则','Cron rule'),rrule:t('RRULE 规则','RRULE rule')};
  const timing=value||initial('every'),kind=timing.kind;
  const nested=key=>patch=>onChange({...timing,[key]:{...timing[key],...patch}});
  const clock=(key,detail,patch)=><>
    <label>{t('执行时间','Execution time')}<input aria-label={`${names[kind]} · ${t('执行时间','Execution time')}`} type="time" step={/:[0-9]{2}(?:\.|$)/.test((detail.time||'').slice(3)) ? "0.001" : "60"} value={detail.time||''} disabled={disabled} onChange={e=>patch({time:e.target.value})}/></label>
    <label>{t('时区','Time zone')}<input aria-label={`${names[kind]} · ${t('时区','Time zone')}`} value={detail.time_zone||''} disabled={disabled} placeholder="Asia/Shanghai" maxLength={100} onChange={e=>patch({time_zone:e.target.value})}/></label>
  </>;
  const absolute=typeof timing.at==='string'?{date:timing.at.slice(0,10),time:timing.at.slice(11,-1),time_zone:'UTC'}:timing.at||{};
  return <fieldset className="timing-fields" disabled={disabled}>
    <legend>{t('执行时间规则','Schedule')}</legend>
    <label>{t('重复方式','Repeat')}<select aria-label={t('重复方式','Repeat')} value={kind} onChange={e=>onChange(initial(e.target.value))}>
      {Object.entries(names).map(([key,label])=><option key={key} value={key}>{label}</option>)}
    </select></label>
    {kind==='after'&&<label>{t('多久后执行（秒）','Delay (seconds)')}<input aria-label={t('多久后执行（秒）','Delay (seconds)')} type="number" min="1" step="1" value={timing.after_seconds??''} onChange={e=>onChange({...timing,after_seconds:e.target.value===''?'':Number(e.target.value)})}/></label>}
    {kind==='every'&&<label>{t('执行间隔（秒，至少 60）','Interval (seconds, minimum 60)')}<input aria-label={t('执行间隔（秒）','Interval (seconds)')} type="number" min="60" step="1" value={timing.every_seconds??''} onChange={e=>onChange({...timing,every_seconds:e.target.value===''?'':Number(e.target.value)})}/></label>}
    {kind==='at'&&<>
      <label>{t('日期','Date')}<input aria-label={t('执行日期','Run date')} type="date" value={absolute.date||''} onChange={e=>onChange({...timing,at:{...absolute,date:e.target.value}})}/></label>
      {clock('at',absolute,patch=>onChange({...timing,at:{...absolute,...patch}}))}
    </>}
    {kind==='daily'&&clock('daily',timing.daily||{},nested('daily'))}
    {kind==='weekly'&&<>
      {clock('weekly',timing.weekly||{},nested('weekly'))}
      <div role="group" aria-label={t('执行星期','Run on days of the week')} className="node-actions">
        {[t('周一','Mon'),t('周二','Tue'),t('周三','Wed'),t('周四','Thu'),t('周五','Fri'),t('周六','Sat'),t('周日','Sun')].map((label,index)=>{
          const day=index+1,days=timing.weekly?.weekdays||[],checked=days.includes(day);
          return <button key={day} type="button" className={`chip ${checked?'active':''}`} aria-pressed={checked}
            onClick={()=>nested('weekly')({weekdays:(checked?days.filter(d=>d!==day):[...days,day]).sort((a,b)=>a-b)})}>{label}</button>;
        })}
      </div>
    </>}
    {kind==='cron'&&<>
      <label>{t('Cron 表达式','Cron expression')}<input aria-label={t('Cron 表达式','Cron expression')} value={timing.cron?.expression||''} maxLength={200} placeholder="0 9 * * *" onChange={e=>nested('cron')({expression:e.target.value})}/></label>
      <p className="secondary">{t('五个字段依次为：分钟、小时、日期、月份、星期。','The five fields are minute, hour, day of month, month, and day of week.')}</p>
      <label>{t('时区','Time zone')}<input aria-label={t('Cron 时区','Cron time zone')} value={timing.cron?.time_zone||''} maxLength={100} placeholder="Asia/Shanghai" onChange={e=>nested('cron')({time_zone:e.target.value})}/></label>
    </>}
    {kind==='rrule'&&<label>{t('DTSTART 与 RRULE','DTSTART and RRULE')}<textarea aria-label={t('RRULE 规则','RRULE rule')} value={timing.rrule||''} rows="4" maxLength={4000} placeholder={'DTSTART;TZID=Asia/Shanghai:20270101T090000\nRRULE:FREQ=DAILY'} onChange={e=>onChange({...timing,rrule:e.target.value})}/><span className="secondary">{t('需要包含带时区的开始时间。服务端会校验规则与下一次执行时间。','Include a timezone-aware start time. The server validates the rule and next execution time.')}</span></label>}
  </fieldset>;
}
