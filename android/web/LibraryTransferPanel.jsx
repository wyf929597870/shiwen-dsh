import React,{useEffect,useState} from 'react';
import {call} from '../bridge/library.mjs';
import {useI18n} from './i18n.js';

export function LibraryTransferPanel({ready,libraryId,onPageStateChange,onLibrariesRefresh}){
  const {t}=useI18n();
  const [busy,setBusy]=useState(false),[message,setMessage]=useState(''),[error,setError]=useState('');
  const [includeConversations,setIncludeConversations]=useState(true);
  const [pendingRestore,setPendingRestore]=useState(null);
  const restoreError=error=>{
    const code=String(error?.message||error);
    const known={
      RESTORE_LIBRARY_ALREADY_EXISTS:t('本机已存在该资料库，恢复不会覆盖它。若要创建独立副本，请选择“导入为新资料库”。','This library already exists on this phone, and restore will not overwrite it. Choose “Import as a new library” to create a separate copy.'),
      REQUEST_REUSED:t('此请求编号已绑定另一份备份。请重新选择原备份，或明确清除待核对请求后再开始新恢复。','This request ID is already bound to another backup. Select the original backup again, or explicitly clear the pending request before starting a new restore.'),
      RESTORE_REQUEST_REUSED:t('此请求编号已绑定另一份备份。请重新选择原备份，或明确清除待核对请求后再开始新恢复。','This request ID is already bound to another backup. Select the original backup again, or explicitly clear the pending request before starting a new restore.'),
      BACKUP_PASSWORD_INVALID:t('密码不正确或备份已损坏；资料库未更改。请核对密码后，用同一请求编号重试。','The password is incorrect or the backup is damaged; no library was changed. Check the password and retry with the same request ID.'),
      RESTORE_REQUEST_IN_PROGRESS:t('恢复仍在处理中。原请求编号已保留，请稍后重新选择同一备份查询结果。','Restore is still in progress. The original request ID is preserved; select the same backup again later to check the result.'),
      RESTORE_ALREADY_RUNNING:t('已有恢复任务正在执行。请稍后使用同一请求编号和同一备份重试核对。','A restore is already running. Wait, then retry verification with the same request ID and backup.'),
      RESTORE_TARGET_RESERVED:t('目标资料库已被此恢复请求占用。请用原请求编号和同一备份重试，不要另建请求。','The target library is reserved by this restore request. Retry with the same request ID and backup; do not start a new request.'),
      RESTORE_COMMIT_RECEIPT_INVALID:t('恢复提交回执暂不可确认。请稍后使用同一请求编号和同一备份重试核对。','The restore commit receipt could not be verified. Retry later with the same request ID and backup.'),
      RESTORE_COMMIT_MARKER_MISSING:t('恢复结果暂不可确认。请稍后使用同一请求编号和同一备份重试核对。','The restore result could not be verified. Retry later with the same request ID and backup.'),
      RESTORE_COMMIT_MARKER_MISMATCH:t('恢复目标校验未通过。原请求编号已保留，请用同一备份重试核对。','The restore target did not pass verification. The original request ID is preserved; retry with the same backup.'),
      RESTORE_TARGET_PATH_OCCUPIED:t('目标位置已有资料。为避免覆盖，恢复已停止；请检查资料库列表后再操作。','The target location already contains data. Restore stopped to avoid overwriting it; check the library list before continuing.'),
      RESTORE_LIBRARY_INVALID:t('备份中的资料库身份无效。没有写入资料，请检查备份文件。','The library identity in this backup is invalid. No data was written; check the backup file.'),
      ARCHIVE_ATTACHMENT_UNAVAILABLE:t('备份引用的附件当前未下载到本机。请先同步完整附件后重新导出备份。','An attachment referenced by this backup is not available locally. Sync all attachments and export the backup again.'),
      ARCHIVE_PASSWORD_INVALID:t('密码不正确或备份已损坏；资料库未更改。请核对密码后，用同一请求编号重试。','The password is incorrect or the backup is damaged; no library was changed. Check the password and retry with the same request ID.')
    };
    return known[code]||code;
  };
  const restoreKey=(targetLibraryId,asNew)=>`shiwen:restore:${targetLibraryId}:${asNew?'new':'original'}`;
  const restoreName=asNew=>t(asNew?'导入的资料库':'恢复的资料库',asNew?'Imported library':'Restored library');
  useEffect(()=>{
    try{
      const original=localStorage.getItem(restoreKey(libraryId,false));
      const asNew=localStorage.getItem(restoreKey(libraryId,true));
      const decode=(raw,isNew)=>{
        if(!raw)return null;
        try {const value=JSON.parse(raw);if(value?.requestId)return {asNew:isNew,requestId:value.requestId,name:value.name||restoreName(isNew)};}
        catch {if(raw.includes('-'))return {asNew:isNew,requestId:raw,name:restoreName(isNew)};}
        return null;
      };
      setPendingRestore(decode(original,false)||decode(asNew,true));
    }catch(e){setError(`${t('读取恢复任务状态失败：','Could not read restore status: ')}${String(e?.message||e)}`);}
  },[libraryId]);
  useEffect(()=>{onPageStateChange?.({dirty:false,busy});},[busy,onPageStateChange]);
  const run=async(action)=>{
    if(busy||!ready||!libraryId)return;
    setBusy(true);setError('');setMessage('');
    try{await action();}catch(e){setError(restoreError(e));}finally{setBusy(false);}
  };
  const importMarkdown=()=>run(async()=>{
    const result=await call('markdownImport',{libraryId});
    if(result?.cancelled)return;
    setMessage(`${t('导入完成','Import complete')} · ${t('成功处理','Processed successfully')} ${Number(result.imported||0)} · ${t('失败','Failed')} ${Number(result.skipped||0)}`);
  });
  const exportBackup=()=>run(async()=>{
    const result=await call('libraryBackupExport',{libraryId,includeConversations});
    if(result?.exported===false)return;
    setMessage(result?.encrypted===false?t('明文备份已导出。请妥善保管文件。','Unencrypted backup exported. Store the file safely.'):
      t('完整资料库备份已导出。','Full library backup exported.'));
  });
  const cancelPendingRestore=()=>{
    if(!pendingRestore)return;
    if(!window.confirm(t('清除本机保存的恢复请求编号？如果本机已完成恢复，资料库仍会保留；再次选择同一备份会被识别为新请求。','Clear the restore request ID saved on this phone? If this phone already completed the restore, the library remains. Choosing the same backup again will start a new request.')))return;
    try{localStorage.removeItem(restoreKey(libraryId,pendingRestore.asNew));setPendingRestore(null);setMessage(t('已清除待核对的恢复请求编号。','The pending restore request ID was cleared.'));}
    catch(e){setError(String(e?.message||e));}
  };
  const restoreBackup=asNewLibrary=>run(async()=>{
    const prompt=asNewLibrary
      ?t('导入为新资料库会生成新的资料库编号；原备份资料库与新副本以后独立修改、独立同步。继续选择备份文件？','Importing as a new library creates a new library ID. The original and this copy will have independent edits and sync from now on. Choose a backup file?')
      :t('恢复原资料库会保留备份中的资料库编号。只有本机尚不存在该资料库时才能恢复，不会覆盖已有资料。继续选择备份文件？','Restore keeps the library ID from the backup. It works only when that library is not already on this phone and never overwrites existing data. Choose a backup file?');
    if(!window.confirm(prompt))return;
    const key=restoreKey(libraryId,asNewLibrary);
    let requestId,restoreTitle;
    try{
      const saved=localStorage.getItem(key);
      let savedRequest=null;
      if(saved){try{savedRequest=JSON.parse(saved);}catch{if(saved.includes('-'))savedRequest={requestId:saved};}}
      requestId=savedRequest?.requestId||crypto.randomUUID();
      restoreTitle=savedRequest?.name||restoreName(asNewLibrary);
      localStorage.setItem(key,JSON.stringify({requestId,name:restoreTitle,asNewLibrary}));
      setPendingRestore({asNew:asNewLibrary,requestId,name:restoreTitle});
    }catch(e){throw Error(`${t('无法安全保存恢复请求编号，已取消操作：','Could not persist the restore request ID. Operation cancelled: ')}${String(e?.message||e)}`);}
    const result=await call('libraryBackupRestore',{libraryId,asNewLibrary,requestId,name:restoreTitle});
    if(result?.cancelled){localStorage.removeItem(key);setPendingRestore(null);return;}
    if(result?.restored===false)return;
    if(result?.requestId&&result.requestId!==requestId)throw Error(t('恢复回执编号不匹配。原请求编号已保留，请勿新建请求。','The restore receipt ID does not match. The original request ID is preserved; do not start a new request.'));
    localStorage.removeItem(key);setPendingRestore(null);
    await onLibrariesRefresh?.();
    setMessage(`${asNewLibrary?t('备份已作为新资料库导入','Backup imported as a new library'):t('原资料库已恢复','Original library restored')} · ${result?.name||result?.libraryId||''}`);
  });
  return <section className="settings-card transfer-card">
    <p className="secondary">{t('导入 Markdown，或备份和恢复资料库。备份包含版本、来源与附件。','Import Markdown, or back up and restore your library. Backups include versions, sources, and attachments.')}</p>
    <div className="node-actions">
      <button className="chip" disabled={!ready||busy} onClick={importMarkdown}>{t('导入 Markdown','Import Markdown')}</button>
      <button className="chip" disabled={!ready||busy} onClick={exportBackup}>{t('备份当前资料库','Back up this library')}</button>
      <details className="transfer-restore"><summary>{t('从备份恢复','Restore from backup')}</summary><p className="secondary">{t('恢复原资料库不会覆盖已有资料库；导入为新资料库会建立独立副本。','Restoring does not overwrite an existing library; importing creates a separate copy.')}</p><div className="node-actions"><button className="chip" disabled={!ready||busy||(pendingRestore!=null&&pendingRestore.asNew)} onClick={()=>restoreBackup(false)}>{t('恢复原资料库','Restore original library')}</button>
      <button className="chip" disabled={!ready||busy||(pendingRestore!=null&&!pendingRestore.asNew)} onClick={()=>restoreBackup(true)}>{t('导入为新资料库','Import as a new library')}</button></div></details>
    </div>
    <label className="transfer-option"><input type="checkbox" checked={includeConversations} disabled={busy} onChange={e=>setIncludeConversations(e.target.checked)}/>{t('备份本机对话、草稿与手机人设','Include phone chats, drafts, and local persona')}</label>
    <p className="secondary">{t('备份不包含模型密钥、登录凭据或待重发的 AI 请求。导入采用请求幂等；恢复原库不会替换已有资料库，导入为新库会创建独立副本。恢复结果未确认时会保留同一请求编号，重试时请重新选择同一备份。','Backups exclude model keys, sign-in credentials, and pending AI requests. Imports are idempotent. Restoring never replaces an existing library; importing as new creates an independent copy. If a restore result is unconfirmed, its request ID is retained. Select the same backup when retrying.')}</p>
    {pendingRestore&&<div className="pending-actions"><p role="status">{t('存在待核对的恢复请求。重试必须选择同一备份文件，以复用本机保存的请求编号。','A restore request needs verification. Retry by selecting the same backup so this phone can reuse its saved request ID.')}</p><button className="text" disabled={busy} onClick={cancelPendingRestore}>{t('明确清除恢复请求编号','Explicitly clear restore request ID')}</button></div>}
    {busy&&<p className="secondary" role="status">{t('等待 Android 文件操作…','Waiting for the Android file operation…')}</p>}
    {message&&<p className="success-note" role="status">{message}</p>}
    {error&&<p className="error" role="alert">{error}</p>}
  </section>;
}
