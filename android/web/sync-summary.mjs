export function syncCompletionMessage(status,t){
  if(!status||status.integrity!=='complete')
    return t('本轮同步操作结束，但资料库完整性尚未确认。请返回设置核对同步状态。','This sync operation ended, but library completeness is not confirmed. Check the sync status in Settings.');
  const pending=status.pendingCount,rejected=status.rejectedCount,conflicts=status.conflictCount;
  if(!Number.isInteger(pending)||!Number.isInteger(rejected)||!Number.isInteger(conflicts))
    return t('本轮同步操作结束，部分状态尚不可读取。请返回设置核对同步状态。','This sync operation ended, but some status counts are unavailable. Check the sync status in Settings.');
  if(conflicts>0)return t(`本轮操作结束；有 ${conflicts} 项冲突待处理。请到设置查看冲突。`,`This operation ended with ${conflicts} conflict(s) to review. Open Sync conflicts in Settings.`);
  if(rejected>0)return t(`本轮操作结束；有 ${rejected} 项写入被服务端拒绝。请到设置检查拒绝原因。`,`This operation ended with ${rejected} rejected write(s). Check the rejection details in Settings.`);
  if(pending>0)return t(`本轮操作结束；仍有 ${pending} 项修改待同步。`,`This operation ended with ${pending} change(s) still waiting to sync.`);
  return t('资料库完整，当前没有待同步修改、拒绝写入或冲突。','The library is complete, with no pending changes, rejected writes, or conflicts.');
}
