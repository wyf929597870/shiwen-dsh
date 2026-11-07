// Non-secret intent markers survive leaving a page or restarting the WebView.
// They are not server receipts and must never cause an automatic write retry.
function key(nodeId,section){
  if(typeof nodeId!=='string'||!nodeId||nodeId.length>200||!['plugins','schedules','external'].includes(section))throw Error('无效的服务操作范围。');
  return `shiwen-management-pending-v1:${encodeURIComponent(nodeId)}:${section}`;
}
export function readPending(nodeId,section,storage=globalThis.localStorage){
  let raw;
  try{raw=storage.getItem(key(nodeId,section));}catch{throw Error('无法读取本机操作记录，暂时不能修改服务设置。');}
  if(raw===null)return null;
  try{
    const value=JSON.parse(raw);
    if(typeof value.action!=='string'||typeof value.startedAt!=='string')throw Error();
    return {action:value.action,startedAt:value.startedAt,...(typeof value.installId==='string'?{installId:value.installId}:{})};
  }catch{return {action:'unknown',startedAt:null};}
}
export function markPending(nodeId,section,{action,installId},storage=globalThis.localStorage){
  const allowed={plugins:['settings.secretSet','settings.mutate','plugins.update','plugins.install','plugins.enableBundle','plugins.enablePlugin','plugins.removeBundle','plugins.cancelInstall'],
    schedules:['schedules.create','schedules.edit','schedules.run','schedules.deleteInactive'],
    external:['externalClientCreate','externalClientRevoke']};
  if(!allowed[section]?.includes(action))throw Error('无效的服务修改操作。');
  if(readPending(nodeId,section,storage))throw Error('该服务仍有一项结果待核对的操作，请先核对当前状态。');
  const value={action,startedAt:new Date().toISOString()};
  if(installId!==undefined){
    if(typeof installId!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(installId))throw Error('无效的安装请求编号。');
    value.installId=installId;
  }
  try{storage.setItem(key(nodeId,section),JSON.stringify(value));}catch{throw Error('无法保存本机操作记录，本次请求尚未发送。');}
  return value;
}
export function clearPending(nodeId,section,storage=globalThis.localStorage){
  try{storage.removeItem(key(nodeId,section));}catch{throw Error('无法清理本机操作记录，请核对服务状态后重试。');}
}
