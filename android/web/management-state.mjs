// DSH value conversion shared by the mobile forms and their regression tests.
// Reading a schedule must not turn a daily/cron/one-shot rule into an interval.
export function scheduleTiming(record) {
  switch (record?.kind) {
    case 'after': return {kind:'after',after_seconds:record.afterSeconds};
    case 'at': return {kind:'at',at:record.scheduledAt};
    case 'every': return {kind:'every',every_seconds:record.everySeconds};
    case 'daily': return {kind:'daily',daily:{time:record.time,time_zone:record.timeZone}};
    case 'weekly': return {kind:'weekly',weekly:{time:record.time,time_zone:record.timeZone,weekdays:[...record.weekdays]}};
    case 'cron': return {kind:'cron',cron:{expression:record.expression,time_zone:record.timeZone}};
    case 'rrule': return {kind:'rrule',rrule:record.rrule};
    default: throw new Error('此任务的时间规则不受当前客户端支持，请更新客户端。');
  }
}

/** An omitted timing is intentional: a text-only edit preserves the Host rule,
 * its anchor and destination, including legacy/future types this client cannot edit. */
export function schedulePatch(form, selected, timing) {
  const title=typeof form.title==='string'?form.title.trim():'';
  const prompt=typeof form.prompt==='string'?form.prompt.trim():'';
  if(!title||title.length>120||!prompt)throw new Error('请填写任务名称（最多 120 字）和执行内容。');
  const patch={};
  if(title!==selected?.title)patch.title=title;
  if(prompt!==selected?.prompt)patch.prompt=prompt;
  if(timing!==undefined)patch.timing=timing;
  return patch;
}

export function validateScheduleTiming(timing){
  if(!timing||typeof timing!=='object')throw new Error('请选择执行时间规则。');
  const clock=value=>{
    if(!value||!/^\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/.test(value.time||''))throw new Error('请填写完整执行时间。');
    if(typeof value.time_zone!=='string'||!value.time_zone.trim())throw new Error('请填写执行时区，例如 Asia/Shanghai。');
  };
  switch(timing.kind){
    case 'after':if(!Number.isSafeInteger(timing.after_seconds)||timing.after_seconds<1)throw new Error('延时须为大于零的整数秒。');break;
    case 'every':if(!Number.isSafeInteger(timing.every_seconds)||timing.every_seconds<60)throw new Error('执行间隔须为至少 60 的整数秒。');break;
    case 'at':
      if(typeof timing.at==='string'){
        if(!Number.isFinite(Date.parse(timing.at))||!/(Z|[+-]\d{2}:\d{2})$/.test(timing.at))throw new Error('执行日期须包含时区。');
      }else{clock(timing.at);if(!/^\d{4}-\d{2}-\d{2}$/.test(timing.at.date||''))throw new Error('请选择执行日期。');}
      break;
    case 'daily':clock(timing.daily);break;
    case 'weekly':
      clock(timing.weekly);
      if(!Array.isArray(timing.weekly.weekdays)||!timing.weekly.weekdays.length||timing.weekly.weekdays.some(day=>!Number.isInteger(day)||day<1||day>7))throw new Error('请至少选择一个执行星期。');
      break;
    case 'cron':
      if(typeof timing.cron?.expression!=='string'||timing.cron.expression.trim().split(/\s+/).length!==5)throw new Error('Cron 表达式需要五个字段。');
      if(!timing.cron.time_zone?.trim())throw new Error('请填写 Cron 时区。');
      break;
    case 'rrule':if(typeof timing.rrule!=='string'||!/^DTSTART[;:]/m.test(timing.rrule)||!/^RRULE:/m.test(timing.rrule))throw new Error('请填写 DTSTART 和 RRULE 两行规则。');break;
    default:throw new Error('此时间规则不受当前客户端支持。');
  }
  return timing;
}

/** HTTP success does not mean the Host applied a mutation. Keep rejected,
 * deferred and unknown outcomes distinct so callers never discard edits early. */
export function managementOutcome(value) {
  const result=(kind,message)=>({kind,ok:kind==='success'||kind==='restart-required',message});
  if(!value||typeof value!=='object')return result('unknown','服务没有返回可核对的结果，请先读取当前状态。');
  if(value.result&&value.from&&value.to){const next=managementOutcome(value.result);return {...next,message:`${value.from} → ${value.to}：${next.message}${value.restore?` 原版本恢复：${managementOutcome(value.restore).message}`:''}`};}
  if(value.code){
    const messages={schedule_conflict:'任务已在其他位置变更。当前编辑仍保留，请重新读取并核对。',
      schedule_not_found:'任务已不存在，请刷新列表。',
      schedule_execution_pending:'已有一次执行正在进行，不会再次启动。',
      delivery_cursor_not_found:'执行历史游标已失效，请重新读取历史。'};
    return result('rejected',messages[value.code]||`服务拒绝此操作：${value.code}`);
  }
  if(value.error||value.application==='failed'||value.application==='cancelled'){
    return result('rejected',`操作未完成：${value.error?.code||value.application||'服务拒绝了更改'}${value.error?.diagnostic?` · ${value.error.diagnostic}`:''}`);
  }
  if(value.application==='overridden')return result('overridden','配置已记录，但当前生效值被其他配置覆盖。请核对插件状态。');
  if(value.application==='restart-required')return result('restart-required',`更改已记录，需要重启服务器才生效${value.restartReason?`（${value.restartReason}）`:''}。`);
  if(value.application==='applied')return result('success','操作已完成。');
  if(value.status==='cancelled')return result('success','安装已取消，服务器已恢复安装前的文件。');
  if(value.status==='too-late')return result('rejected','安装已超过可取消阶段，请查询最终结果。');
  if(value.status==='not-running')return result('success','此安装已不在运行，请查询最终结果。');
  if(value.deleted===true||(Number.isSafeInteger(value.deleted)&&value.deleted>=0))return result('success',typeof value.deleted==='number'?`已清理 ${value.deleted} 个已结束任务。`:'任务已删除。');
  if(value.id&&['active','paused','ended'].includes(value.status))return result('success','任务已更新。');
  if(value.ok===true)return result('success','操作已完成。');
  return result('unknown','服务已返回结果，请先读取并核对当前状态。');
}
