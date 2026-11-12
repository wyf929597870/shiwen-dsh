import React, {useEffect, useRef, useState} from 'react';
import {MessageDialog} from './MessageDialog.jsx';
import {call} from '../bridge/library.mjs';
import {MarkdownView} from './MarkdownView.jsx';
import {enqueueRecordDraft,flushRecordDraft} from './record-draft-queue.mjs';
import {attachmentImageIds} from './markdown-renderer.mjs';

export function AnnotationPanel({libraryId, original, attachments, t, onStateChange}) {
  const [tab,setTab]=useState('original'),[items,setItems]=useState([]),[editor,setEditor]=useState(null),[deleted,setDeleted]=useState(false);
  const [error,setError]=useState(''),[busy,setBusy]=useState(false),[uncertain,setUncertain]=useState(false),[stateAction,setStateAction]=useState(null);
  const slot=`annotation:${original.id}`,key=`${libraryId}:${slot}`,generation=useRef(0),pending=useRef(null);
  const persist=(value,mutation=null)=>{generation.current++;const n=generation.current;return enqueueRecordDraft(key,()=>call('recordDraftSave',{libraryId,slot,requestId:value.requestId,localGeneration:n,content:{editor:value},pendingMutation:mutation?{...mutation,localGeneration:n}:undefined}));};
  useEffect(()=>{let active=true;(async()=>{try{await flushRecordDraft(key);const result=await call('recordDraftRead',{libraryId,slot});if(!active)return;generation.current=result.draft?.localGeneration??result.nextGeneration??0;if(result.draft?.content?.editor){setEditor(result.draft.content.editor);pending.current=result.draft.pendingMutation;setUncertain(!!pending.current);setTab('annotations');}else if(result.draft?.content?.stateAction){setStateAction(result.draft.content.stateAction);setDeleted(result.draft.content.stateAction.action==='restore');setTab('annotations');}}catch(e){if(active)setError(String(e.message||e));}})();return()=>{active=false;};},[key]);
  useEffect(()=>{onStateChange({dirty:!!editor||!!stateAction,busy});},[editor,stateAction,busy,onStateChange]);
  useEffect(()=>()=>onStateChange({dirty:false,busy:false}),[onStateChange]);
  const refresh=async()=>{const page=await call('annotationList',{libraryId,originalId:original.id,deleted});setItems(page.items||page||[]);};
  useEffect(()=>{if(tab==='annotations'&&!original.deleted)refresh().catch(e=>setError(String(e.message||e)));},[tab,original.id,original.deleted,deleted]);
  const change=value=>{setEditor(value);persist(value).catch(e=>setError(String(e.message||e)));};
  const begin=async()=>{setError('');try{const info=await call('originalVersionInfo',{libraryId,id:original.id});const value={title:'',body:'',info,requestId:crypto.randomUUID(),staged:[],descriptors:[]};change(value);}catch(e){setError(String(e.message||e));}};
  const clear=async()=>{await flushRecordDraft(key);const ack=await call('recordDraftAcknowledge',{libraryId,slot,requestId:editor.requestId,localGeneration:generation.current});if(!ack.cleared)throw Error('RECORD_DRAFT_ACK_FAILED');pending.current=null;setEditor(null);setUncertain(false);};
  const save=async()=>{if(!editor?.body.trim()||busy)return;setBusy(true);setError('');try{
    let mutation=pending.current;
    if(!mutation){const refs=attachmentImageIds(editor.body);const staged=(editor.staged||[]).filter(x=>refs.has(x.id));const descriptors=[...(editor.descriptors||[]),...staged].map(({id,name,hash,byteLength})=>({id,name,hash,byteLength}));
      const args={libraryId,title:editor.title,body:editor.body,requestId:editor.requestId,attachmentDescriptors:descriptors,stagedAttachmentIds:staged.map(x=>x.id)};
      if(editor.id)Object.assign(args,{id:editor.id,revision:editor.revision});else Object.assign(args,{originalId:original.id,originalVersionId:editor.info.versionId,originalContentHash:editor.info.contentHash});
      mutation={action:editor.id?'update':'create',requestId:editor.requestId,args};await flushRecordDraft(key);await persist(editor,mutation);mutation={...mutation,localGeneration:generation.current};pending.current=mutation;
    }
    await call(mutation.action==='create'?'annotationCreate':'annotationUpdate',mutation.args);
    const unused=(editor.staged||[]).filter(x=>!mutation.args.stagedAttachmentIds.includes(x.id)).map(x=>x.id);
    await clear();if(unused.length)await call('attachmentStageDelete',{libraryId,ids:unused});await refresh();
  }catch(e){const message=String(e.message||e);if(pending.current&&/^(RECORD_REVISION_CONFLICT|ORIGINAL_VERSION_MISSING|ORIGINAL_VERSION_CHANGED|INVALID_ANNOTATION_PARENT|RECORD_TOO_LARGE|INVALID_ANNOTATION_FIELD|ATTACHMENT_[A-Z_]+|SOURCE_SEGMENTS_MISMATCH)$/.test(message)){
      try{await clear();const fresh={...editor,requestId:crypto.randomUUID()};setEditor(fresh);await persist(fresh);}catch(clearError){setError(String(clearError.message||clearError));return;}
    }else setUncertain(!!pending.current);setError(message);}finally{setBusy(false);}};
  const state=async item=>{if(!stateAction&&!window.confirm(deleted?t('恢复这条 AI 标注？','Restore this annotation?'):t('删除这条 AI 标注？','Delete this annotation?')))return;setBusy(true);setError('');let frozen=stateAction;try{
    if(!frozen){frozen={action:deleted?'restore':'delete',requestId:crypto.randomUUID(),args:{libraryId,id:item.id,revision:item.revision}};generation.current++;const n=generation.current;await enqueueRecordDraft(key,()=>call('recordDraftSave',{libraryId,slot,requestId:frozen.requestId,localGeneration:n,content:{stateAction:frozen},pendingMutation:{action:frozen.action,requestId:frozen.requestId,localGeneration:n,args:frozen.args}}));setStateAction(frozen);}
    await call(frozen.action==='restore'?'annotationRestore':'annotationDelete',{...frozen.args,requestId:frozen.requestId});
    const ack=await call('recordDraftAcknowledge',{libraryId,slot,requestId:frozen.requestId,localGeneration:generation.current});if(!ack.cleared)throw Error('RECORD_DRAFT_ACK_FAILED');setStateAction(null);await refresh();
  }catch(e){const message=String(e.message||e);if(frozen&&/^(RECORD_REVISION_CONFLICT|ANNOTATION_NOT_FOUND|ANNOTATION_STATE_CHANGED|INVALID_ANNOTATION_PARENT)$/.test(message)){const ack=await call('recordDraftAcknowledge',{libraryId,slot,requestId:frozen.requestId,localGeneration:generation.current});if(!ack.cleared)throw Error('RECORD_DRAFT_ACK_FAILED');setStateAction(null);await refresh();}setError(message);}finally{setBusy(false);}};
  const insert=async()=>{setBusy(true);try{const result=await call('attachmentPick',{libraryId});if(result.items?.length){const snippets=result.items.map(x=>`![${String(x.name||'image').replace(/[\\\]]/g,'_')}](attachment:${x.id})`).join('\n\n');change({...editor,body:`${editor.body}${editor.body?'\n\n':''}${snippets}`,staged:[...(editor.staged||[]),...result.items]});}}catch(e){setError(String(e.message||e));}finally{setBusy(false);}};
  const cancel=async()=>{if(uncertain)return;try{const ids=(editor.staged||[]).map(x=>x.id);await clear();if(ids.length)await call('attachmentStageDelete',{libraryId,ids});}catch(e){setError(String(e.message||e));}};
  return <section className="annotation-panel"><div className="node-actions" role="tablist"><button role="tab" aria-selected={tab==='original'} className="chip" onClick={()=>setTab('original')}>{t('原文','Original')}</button><button role="tab" aria-selected={tab==='annotations'} className="chip" onClick={()=>setTab('annotations')}>{t('AI 标注','AI annotations')}</button></div>
    {tab==='original'?<MarkdownView markdown={original.markdown} libraryId={libraryId} recordId={original.id} attachmentDescriptors={attachments}/>:<div>
      {!original.deleted&&<><button className="chip" disabled={busy||!!editor||!!stateAction||deleted} onClick={begin}>{t('新建标注','New annotation')}</button><label><input type="checkbox" checked={deleted} disabled={!!editor||!!stateAction} onChange={e=>setDeleted(e.target.checked)}/>{t('已删除标注','Deleted annotations')}</label></>}
      {stateAction&&<div className="conflict-callout">{t('操作结果尚未确认。','The operation has not been confirmed.')} <button className="chip" disabled={busy} onClick={()=>state(null)}>{t('再次核对','Retry')}</button></div>}
      {editor&&<div><label>{t('标题','Title')}<input value={editor.title} maxLength={200} disabled={busy||uncertain} onChange={e=>change({...editor,title:e.target.value})}/></label><label>{t('标注正文 · Markdown','Annotation · Markdown')}<button className="chip" disabled={busy||uncertain} onClick={insert}>{t('插入图片','Insert image')}</button><textarea className="record-editor" value={editor.body} disabled={busy||uncertain} onChange={e=>change({...editor,body:e.target.value})}/></label><div className="node-actions"><button className="primary" disabled={busy||!editor.body.trim()} onClick={save}>{uncertain?t('再次核对保存结果','Retry save'):t('保存','Save')}</button><button className="chip" disabled={busy||uncertain} onClick={cancel}>{t('取消','Cancel')}</button></div></div>}
      {items.map(item=><article key={item.id}><h3>{item.title||t('未命名标注','Untitled annotation')}</h3><p className="secondary">{item.annotationOf?.versionId!==original.versionId?t('基于较早版本','Based on an earlier version'):t('基于当前版本','Based on current version')}</p><MarkdownView markdown={item.markdown} libraryId={libraryId} recordId={item.id} attachmentDescriptors={item.attachmentDescriptors||[]}/><div className="node-actions">{!deleted&&<button className="chip" disabled={busy||!!editor||!!stateAction} onClick={()=>change({id:item.id,revision:item.revision,title:item.title||'',body:item.markdown||'',requestId:crypto.randomUUID(),staged:[],descriptors:item.attachmentDescriptors||[]})}>{t('编辑','Edit')}</button>}<button className="chip" disabled={busy||!!editor||!!stateAction} onClick={()=>state(item)}>{deleted?t('恢复','Restore'):t('删除','Delete')}</button></div></article>)}
      {!items.length&&!editor&&<p className="empty-state">{t('暂无 AI 标注。','No AI annotations yet.')}</p>}</div>}
    {error&&<MessageDialog message={error} onClose={()=>setError('')}/>}
  </section>;
}
