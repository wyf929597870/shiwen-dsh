import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {call} from '../bridge/library.mjs';
import {MarkdownView} from './MarkdownView.jsx';
import {attachmentImageIds} from './markdown-renderer.mjs';
import {checkArticle} from '../../plugins/workbench/src/preflight.mjs';
import {useI18n} from './i18n.js';
import './record-translations.mjs';
import {enqueueRecordDraft,flushRecordDraft} from './record-draft-queue.mjs';
import './record.css';
import {AnnotationPanel} from './AnnotationPanel.jsx';

// Only editor-owned fields belong in a mutation; detail responses also contain sync/UI metadata.
const editableFields = ['title','markdown','kind','origin','processing','contentDay','dateBasis','url','annotation','stage','sourceIds','sources'];
const recordInput = form => Object.fromEntries(editableFields.filter(key=>Object.hasOwn(form,key)).map(key=>[key,form[key]]));

const kinds = ['journal','freewrite','idea','web','ai','reference'];
const kindName = (value,t) => t(({journal:'日记',freewrite:'自由书写',idea:'想法',web:'网页',ai:'AI 讨论',reference:'参考资料',article:'文章'})[value] || value || '未分类');
const originName = (value,t) => t(({personal:'自己书写',external:'外部资料',ai:'AI 内容',translation:'译文',unknown:'来源待确认'})[value] || '来源待确认');
const dateText = (value,t) => value ? String(value).slice(0,10) : t('日期待确认');
const byteText=value=>{const bytes=Number(value||0);return bytes<1024?`${bytes} B`:bytes<1024**2?`${(bytes/1024).toFixed(1)} KB`:`${(bytes/1024**2).toFixed(1)} MB`;};
const newId = () => crypto.randomUUID();
const localDay=()=>{const date=new Date();return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;};
const newMaterial = () => ({title:'',markdown:'',kind:'journal',origin:'personal',processing:'original',contentDay:localDay(),dateBasis:'用户在手机记录',url:'',annotation:'',stage:'draft',sourceIds:[],sources:[],attachmentDescriptors:[],stagedAttachments:[]});

function reconcileSources(segments, before, after, origin) {
  if (before === after) return segments;
  let prefix=0; while(prefix<before.length&&prefix<after.length&&before[prefix]===after[prefix])prefix++;
  let suffix=0; while(suffix<before.length-prefix&&suffix<after.length-prefix&&before[before.length-1-suffix]===after[after.length-1-suffix])suffix++;
  const cut=(items,start,end)=>{
    const result=[];let at=0;
    for(const segment of items||[]){const text=String(segment.text||''),lo=Math.max(0,start-at),hi=Math.min(text.length,end-at);if(hi>lo)result.push({...segment,text:text.slice(lo,hi)});at+=text.length;}
    return result;
  };
  const unchangedPrefix=cut(segments,0,prefix), inserted=after.slice(prefix,after.length-suffix), unchangedSuffix=cut(segments,before.length-suffix,before.length);
  return [...unchangedPrefix,...(inserted?[{text:inserted,origin:origin||'personal'}]:[]),...unchangedSuffix].filter(item=>item.text);
}

export function RecordPanel({libraryId, libraries=[], mode='materials', onPageStateChange=()=>{}, onNavigation, onBack, viewState={}, onViewStateChange=()=>{}}) {
  const {t}=useI18n();
  const articles = mode === 'articles';
  const slot=articles?'articles':'materials',draftKey=`${libraryId}:${slot}`;
  const [rows,setRows] = useState([]), [cursor,setCursor] = useState(null), [more,setMore] = useState(false), [total,setTotal] = useState(null);
  const cursorRef=useRef(null);
  const [query,setQuery] = useState(viewState.query||''), [kind,setKind] = useState(viewState.kind||''), [showDeleted,setShowDeleted] = useState(Boolean(viewState.showDeleted));
  const [loadedPages,setLoadedPages] = useState(1), restorePages=useRef(Math.max(1,Number(viewState.loadedPages||1))), restoreScroll=useRef(Number(viewState.scrollTop||0));
  const viewStateRef=useRef(null);
  const [selected,setSelected] = useState(null), [detailOpen,setDetailOpen] = useState(false), [form,setForm] = useState(null), [creating,setCreating] = useState(false), [editing,setEditing] = useState(false);
  const [sources,setSources] = useState([]), [sourceCursor,setSourceCursor] = useState(null), [sourceError,setSourceError] = useState(''), [sourceRetry,setSourceRetry] = useState(null), [sourceQuery,setSourceQuery] = useState(''), [sourceLoading,setSourceLoading] = useState(false), [busy,setBusy] = useState(false), [loading,setLoading] = useState(false), [error,setError] = useState(''), [hint,setHint] = useState('');
  const sourceGeneration=useRef(0);
  useEffect(()=>()=>{sourceGeneration.current++;},[]);
  const [attachments,setAttachments]=useState([]);
  const [annotationState,setAnnotationState]=useState({dirty:false,busy:false});
  const [copyTarget,setCopyTarget]=useState('');
  const [versions,setVersions] = useState([]), [versionCursor,setVersionCursor] = useState(null), [showVersions,setShowVersions] = useState(false);
  const [saveRequest,setSaveRequest] = useState(null),[pendingMutation,setPendingMutation]=useState(null),[uncertain,setUncertain]=useState(false),[pendingAction,setPendingAction]=useState(null),[draftReady,setDraftReady]=useState(false),[pendingDurable,setPendingDurable]=useState(false);
  const markdownInput=useRef(null);
  const generationRef=useRef(0),requestRef=useRef(null),formRef=useRef(form),selectedRef=useRef(selected),creatingRef=useRef(creating),editingRef=useRef(editing),pendingMutationRef=useRef(pendingMutation),pendingActionRef=useRef(pendingAction);
  formRef.current=form;selectedRef.current=selected;creatingRef.current=creating;editingRef.current=editing;pendingMutationRef.current=pendingMutation;pendingActionRef.current=pendingAction;
  const dirty = Boolean(editing && selected && form && JSON.stringify(form)!==JSON.stringify(selected) || creating && form && JSON.stringify(form)!==JSON.stringify({...newMaterial(),kind:articles?'article':'journal'}));
  // A durable pending draft can be revisited; only an in-flight operation blocks navigation.
  useEffect(()=>onPageStateChange({dirty:(dirty&&!pendingDurable)||annotationState.dirty,busy:busy||annotationState.busy||!draftReady||((uncertain||Boolean(pendingAction))&&!pendingDurable)}),[dirty,busy,uncertain,pendingAction,draftReady,pendingDurable,annotationState,onPageStateChange]);
  viewStateRef.current={query,kind,showDeleted,loadedPages};
  useEffect(()=>{
    const main=document.querySelector('.app > main');
    return()=>{if(main)onViewStateChange({...viewStateRef.current,scrollTop:main.scrollTop||0});};
  },[onViewStateChange]);
  useEffect(()=>{
    let active=true;
    if(!selected?.id){setAttachments([]);return()=>{active=false;};}
    setAttachments(selected.attachmentDescriptors||[]);
    call('recordAttachments',{libraryId,recordId:selected.id}).then(result=>{if(active)setAttachments(result.items||[]);})
      .catch(()=>{});
    return()=>{active=false;};
  },[libraryId,selected?.id]);

  const draftContent=(overrides={})=>({form:Object.hasOwn(overrides,'form')?overrides.form:formRef.current,selectedId:Object.hasOwn(overrides,'selectedId')?overrides.selectedId:selectedRef.current?.id??null,creating:Object.hasOwn(overrides,'creating')?overrides.creating:creatingRef.current,editing:Object.hasOwn(overrides,'editing')?overrides.editing:editingRef.current,pendingAction:Object.hasOwn(overrides,'pendingAction')?overrides.pendingAction:pendingActionRef.current??null});
  const persistDraft=(content,requestId=requestRef.current,generation=generationRef.current,pending=pendingMutationRef.current)=>{
    if(!requestId||!libraryId)return Promise.resolve();
    return enqueueRecordDraft(draftKey,()=>call('recordDraftSave',{libraryId,slot,requestId,localGeneration:generation,content,pendingMutation:pending||undefined}));
  };
  useEffect(()=>{
    let active=true;
    (async()=>{
      try{
        await flushRecordDraft(draftKey);
        const snapshot=await call('recordDraftRead',{libraryId,slot});
        if(!active)return;
        generationRef.current=Number(snapshot.nextGeneration||0);
        const draft=snapshot.draft;
        if(draft){
          generationRef.current=Number(draft.localGeneration||snapshot.nextGeneration||0);requestRef.current=draft.requestId;
          const content=draft.content||{};const restoredForm=content.form||null;
          formRef.current=restoredForm;setForm(restoredForm);setDetailOpen(Boolean(restoredForm));setCreating(Boolean(content.creating));setEditing(Boolean(content.editing));
          setSaveRequest(draft.requestId);const pending=draft.pendingMutation||null;pendingMutationRef.current=pending;setPendingMutation(pending);setUncertain(Boolean(pending));setPendingDurable(Boolean(pending));
          const action=content.pendingAction||null;pendingActionRef.current=action;setPendingAction(action);
          if(content.selectedId){const record=await call('recordRead',{libraryId,id:content.selectedId});if(active){selectedRef.current=record;setSelected(record);}}
          if(restoredForm&&active)setHint(t('已恢复上次未完成的编辑。','Restored the previous unfinished edit.'));
        }
      }catch(e){if(active)setError(`${t('编辑草稿读取失败：','Could not load the edit draft: ')}${String(e.message||e)}`);}
      finally{if(active)setDraftReady(true);}
    })();
    return()=>{active=false;};
  },[draftKey,libraryId,slot]);

  const load = useCallback(async (reset=true) => {
    if (!libraryId) return;
    setLoading(true); setError('');
    try {
      const page=await call('recordList',{libraryId,query:query.trim()||undefined,kind:articles?'article':kind||undefined,cursor:reset?undefined:cursorRef.current,limit:30,deleted:showDeleted||undefined});
      setRows(old=>reset?page.items:[...old,...page.items]); cursorRef.current=page.nextCursor??null;setCursor(cursorRef.current); setMore(cursorRef.current!=null); setTotal(page.total??null);setLoadedPages(reset?1:old=>old+1);
    } catch(e) {setError(String(e.message||e));}
    finally {setLoading(false);}
  },[libraryId,query,kind,articles,showDeleted]);
  useEffect(()=>{const t=setTimeout(async()=>{await load(true);const pages=restorePages.current;restorePages.current=1;for(let i=1;i<pages&&cursorRef.current;i++)await load(false);const top=restoreScroll.current;restoreScroll.current=0;if(top>0)requestAnimationFrame(()=>{const main=document.querySelector('.app > main');if(main)main.scrollTop=top;});},180);return()=>clearTimeout(t);},[load]);
  const loadSources=useCallback(async(cursor=null,query='')=>{
    const generation=++sourceGeneration.current;
    setSourceLoading(true);setSourceError('');setSourceRetry(cursor);if(!cursor){setSources([]);setSourceCursor(null);}
    try{const page=await call('recordList',{libraryId,limit:100,excludeKind:'article',cursor,query:query.trim()||undefined});if(generation!==sourceGeneration.current)return;setSources(old=>cursor?[...old,...(page.items||[])]:page.items||[]);setSourceCursor(page.nextCursor??null);}
    catch(e){if(generation===sourceGeneration.current)setSourceError(String(e.message||e));}finally{if(generation===sourceGeneration.current)setSourceLoading(false);}
  },[libraryId]);
  const runTransfer=async operation=>{
    if(busy||uncertain||pendingAction)return;
    setBusy(true);setError('');setHint('');
    try{return await operation();}catch(e){setError(String(e.message||e));}
    finally{setBusy(false);}
  };
  const importMarkdown=()=>runTransfer(async()=>{
    const result=await call('markdownImport',{libraryId});
    if(result?.cancelled)return;
    setHint(`${t('导入完成','Import complete')} · ${t('新增','Added')} ${Number(result.imported||0)} · ${t('跳过重复','Skipped duplicates')} ${Number(result.skipped||0)}`);
    await load(true);
  });
  const exportSelected=()=>runTransfer(async()=>{
    const result=await call('recordExport',{libraryId,id:selected.id});
    if(result?.cancelled)return;
    setHint(t('Markdown 已导出；此文件不包含图片。','Markdown exported; this file does not include images.'));
  });
  const exportSelectedWithImages=()=>runTransfer(async()=>{
    const result=await call('recordExportWithImages',{libraryId,id:selected.id});
    if(result?.cancelled)return;
    setHint(t('原文、标注与库内图片已打包；网络图片仍依赖原地址。','Original, annotations and library images were exported; remote images still depend on their original URLs.'));
  });
  const shareSelected=()=>runTransfer(async()=>{
    const result=await call('recordShare',{libraryId,id:selected.id});
    if(result?.shared)setHint(t('已打开系统分享面板。','Opened the system share sheet.'));
  });
  const openAttachment=file=>runTransfer(async()=>{
    await call('attachmentOpen',{recordId:selected.id,attachmentId:file.id});
    setHint(t('已打开系统文件查看器。','Opened the system file viewer.'));
  });
  const shareAttachment=file=>runTransfer(async()=>{
    await call('attachmentShare',{recordId:selected.id,attachmentId:file.id});
    setHint(t('已打开系统分享面板。','Opened the system share sheet.'));
  });
  const correctOrigin=()=>runTransfer(async()=>{
    const origin=window.prompt(t('输入正确来源：personal、external、ai、translation 或 unknown','Enter origin: personal, external, ai, translation, or unknown'),selected.origin);
    if(origin==null||origin===selected.origin)return;
    if(!['personal','external','ai','translation','unknown'].includes(origin))throw Error(t('来源无效','Invalid origin'));
    const result=await call('correctRecordOrigin',{libraryId,id:selected.id,revision:selected.revision,origin,requestId:newId()});
    setSelected(result);setForm({...result});setHint(t('来源已更正。','Origin corrected.'));await load(true);
  });
  const copySelected=()=>runTransfer(async()=>{
    if(!copyTarget||copyTarget===libraryId||!selected)return;
    if(!window.confirm(t('只复制正文与来源说明，不复制附件文件或跨库关联。继续？','Copy the body and provenance notes only; attachment files and cross-library links are not copied. Continue?')))return;
    const result=await call('recordCopy',{libraryId,id:selected.id,targetLibraryId:copyTarget,requestId:newId()});
    setHint(`${t('已复制到另一资料库','Copied to another library')} · ${result.record?.title||selected.title}`);
    setCopyTarget('');
  });
  const copySelectedWithImages=()=>runTransfer(async()=>{
    if(!copyTarget||copyTarget===libraryId||!selected)return;
    if(!window.confirm(t('复制正文和库内图片到目标资料库？跨库记录关联不会复制。','Copy this record and its library images? Cross-library record links are not copied.')))return;
    const key=`shiwen-copy-images:${libraryId}:${selected.id}:${copyTarget}`;
    const requestId=localStorage.getItem(key)||newId();localStorage.setItem(key,requestId);
    const result=await call('recordCopyWithImages',{libraryId,id:selected.id,targetLibraryId:copyTarget,requestId});
    localStorage.removeItem(key);setHint(`${t('已复制正文和图片','Copied body and images')} · ${result.record?.title||selected.title}`);setCopyTarget('');
  });
  const clearDraft=async()=>{
    const stagedIds=(formRef.current?.stagedAttachments||[]).map(item=>item.id);
    let cleared=false;
    if(requestRef.current){const ack=await enqueueRecordDraft(draftKey,()=>call('recordDraftAcknowledge',{libraryId,slot,requestId:requestRef.current,localGeneration:generationRef.current}));cleared=Boolean(ack.cleared);generationRef.current+=1;}
    if(cleared&&stagedIds.length)call('attachmentStageDelete',{libraryId,ids:stagedIds}).catch(()=>{});
    requestRef.current=null;pendingMutationRef.current=null;pendingActionRef.current=null;setSaveRequest(null);setPendingMutation(null);setPendingAction(null);setUncertain(false);setPendingDurable(false);formRef.current=null;setForm(null);
  };
  const read=async id=>{
    if((dirty||uncertain||pendingAction)&&!window.confirm(t('切换记录会丢弃或中断当前编辑。未确认的写入需留在本页核对。确定继续吗？','Switching records may discard or interrupt the current edit. Unconfirmed writes must be checked here. Continue?')))return;
    if(uncertain||pendingAction){setError(t('请先核对当前未确认的写入，再切换记录。','Check the unconfirmed write before switching records.'));return;}
    setError('');setHint('');setLoading(true);
    try{if(dirty||requestRef.current)await clearDraft();const record=await call('recordRead',{libraryId,id});selectedRef.current=record;formRef.current={...record};creatingRef.current=false;editingRef.current=false;setSelected(record);setForm({...record});setEditing(false);setCreating(false);setDetailOpen(true);setShowVersions(false);if(articles){setSourceQuery('');await loadSources();}}
    catch(e){setError(String(e.message||e));}finally{setLoading(false);}
  };
  const startNew=async()=>{
    if((dirty||uncertain||pendingAction)&&!window.confirm(t('开始新内容会放弃当前编辑。确定继续吗？','Starting a new item will discard the current edit. Continue?')))return;
    if(uncertain||pendingAction){setError(t('请先核对当前未确认的写入。','Check the unconfirmed write first.'));return;}
    try{if(dirty||requestRef.current)await clearDraft();setError('');setHint('');setUncertain(false);pendingMutationRef.current=null;pendingActionRef.current=null;setPendingMutation(null);setPendingAction(null);selectedRef.current=null;creatingRef.current=true;editingRef.current=true;setSelected(null);setDetailOpen(true);const next={...newMaterial(),kind:articles?'article':'journal',stage:'draft'};formRef.current=next;setForm(next);setCreating(true);setEditing(true);requestRef.current=newId();setSaveRequest(requestRef.current);await persistDraft({form:next,selectedId:null,creating:true,editing:true,pendingAction:null},requestRef.current,generationRef.current,null);if(articles){setSourceQuery('');await loadSources();}}
    catch(e){setError(`${t('草稿未保存：','Draft not saved: ')}${String(e.message||e)}`);}
  };
  const startEdit=record=>{
    if(uncertain||pendingAction||annotationState.dirty||annotationState.busy)return;
    const next={...record};formRef.current=next;creatingRef.current=false;editingRef.current=true;setForm(next);setCreating(false);setEditing(true);
    generationRef.current=Math.max(generationRef.current,Number(record.localGeneration||0))+1;requestRef.current=newId();setSaveRequest(requestRef.current);setPendingMutation(null);pendingMutationRef.current=null;setPendingDurable(false);
    persistDraft({form:next,selectedId:record.id,creating:false,editing:true,pendingAction:null},requestRef.current,generationRef.current,null).catch(e=>setError(`${t('草稿未保存：','Draft not saved: ')}${String(e.message||e)}`));
  };
  const cancelEdit=async()=>{
    if(uncertain||pendingAction)return;
    try{await clearDraft();creatingRef.current=false;editingRef.current=false;setCreating(false);setEditing(false);const restored=selected?{...selected}:null;formRef.current=restored;setForm(restored);if(!selected)setDetailOpen(false);}
    catch(e){setError(`${t('草稿清理失败：','Could not clear draft: ')}${String(e.message||e)}`);}
  };
  const leaveDetail=async()=>{
    if(busy||annotationState.busy||uncertain||pendingAction){setError(t('当前操作尚未确认，请先核对。','Finish or verify the current operation first.'));return;}
    if(editing){if(dirty&&!window.confirm(t('放弃尚未保存的修改？','Discard unsaved changes?')))return;await cancelEdit();return;}
    if(annotationState.dirty&&!window.confirm(t('标注草稿会保留，确定离开？','The annotation draft will be kept. Leave?')))return;
    setAnnotationState({dirty:false,busy:false});setDetailOpen(false);
  };
  useEffect(()=>{onNavigation?.({depth:detailOpen,back:leaveDetail});});
  const change=(key,value)=>{
    if(busy||uncertain)return;
    const old=formRef.current;if(!old)return;
    const next=key==='markdown'?({...old,markdown:value,sources:reconcileSources(old.sources,old.markdown||'',value,old.origin)}):({...old,[key]:value});
    formRef.current=next;setForm(next);
    if(requestRef.current){generationRef.current+=1;persistDraft(draftContent({form:next}),requestRef.current,generationRef.current,null).catch(e=>setError(`${t('编辑草稿未保存：','Edit draft not saved: ')}${String(e.message||e)}`));}
  };
  const doSave=async()=>{
    if(!form||busy||(!uncertain&&!form.markdown.trim()))return;
    if(!pendingMutationRef.current){const existing=new Set([...(selected?.attachmentDescriptors||[]),...attachments,...(form.stagedAttachments||[])].map(item=>item.id));const old=attachmentImageIds(selected?.markdown);if([...attachmentImageIds(form.markdown)].some(id=>!existing.has(id)&&!old.has(id))){setError(t('正文引用的图片不存在，请重新插入图片。','An image referenced in the text is missing. Insert it again.'));return;}}
    setBusy(true);setError('');setHint('');
    const frozen=pendingMutationRef.current||(()=>{const requestId=requestRef.current||saveRequest||newId();requestRef.current=requestId;setSaveRequest(requestId);generationRef.current+=1;const allStagedAttachments=form.stagedAttachments||[],references=attachmentImageIds(form.markdown);const staged=allStagedAttachments.filter(item=>references.has(item.id));const stagedIds=staged.map(item=>item.id);const descriptors=[...(selected?.attachmentDescriptors||[]),...staged];const record={...recordInput(form),kind:articles?'article':form.kind,sourceIds:articles?form.sourceIds||[]:[],sources:form.sources?.length?form.sources:[{text:form.markdown,origin:form.origin||'personal'}],...(staged.length?{attachmentDescriptors:descriptors.map(({id,name,hash,byteLength})=>({id,name,hash,byteLength}))}:{})};return {action:creating?'create':'update',requestId,record,stagedAttachmentIds:stagedIds,allStagedAttachments,create:creating,id:selected?.id,expectedRevision:selected?.revision,localGeneration:generationRef.current};})();
    if(!pendingMutationRef.current){pendingMutationRef.current=frozen;setPendingMutation(frozen);}
    let persisted=Boolean(uncertain);
    try{
      const draftForm=frozen.allStagedAttachments?{...frozen.record,stagedAttachments:frozen.allStagedAttachments}:frozen.record;
      await persistDraft(draftContent({form:draftForm,selectedId:frozen.id??null,creating:frozen.create,editing:true,pendingAction:null}),frozen.requestId,frozen.localGeneration,frozen);
      persisted=true;setPendingDurable(true);
      const result=frozen.create
        ? await call('recordCreate',{libraryId,requestId:frozen.requestId,localGeneration:frozen.localGeneration,record:frozen.record,stagedAttachmentIds:frozen.stagedAttachmentIds||[]})
        : await call('recordUpdate',{libraryId,id:frozen.id,expectedRevision:frozen.expectedRevision,requestId:frozen.requestId,localGeneration:frozen.localGeneration,patch:frozen.record,stagedAttachmentIds:frozen.stagedAttachmentIds||[]});
      const fresh=result.record;
      if(!fresh?.id||fresh.revision==null)throw new Error(t('保存回执缺少记录版本；内容保留，请刷新后核对。','The save receipt has no record revision. Content is preserved; refresh and check the result.'));
      const ack=await enqueueRecordDraft(draftKey,()=>call('recordDraftAcknowledge',{libraryId,slot,requestId:frozen.requestId,localGeneration:frozen.localGeneration}));
      if(!ack.cleared)throw new Error(t('保存成功但草稿回执尚未确认；保留原请求并再次核对。','Saved, but the draft receipt is not confirmed. Keep the original request and check again.'));
      const stagedIds=(frozen.allStagedAttachments||[]).map(item=>item.id);if(!stagedIds.length)stagedIds.push(...(frozen.stagedAttachmentIds||[]));if(stagedIds.length)call('attachmentStageDelete',{libraryId,ids:stagedIds}).catch(()=>{});
      requestRef.current=null;pendingMutationRef.current=null;generationRef.current=frozen.localGeneration+1;selectedRef.current=fresh;formRef.current={...fresh};creatingRef.current=false;editingRef.current=false;
      setSelected(fresh);setForm({...fresh});setCreating(false);setEditing(false);setSaveRequest(null);setPendingMutation(null);setUncertain(false);setPendingDurable(false);
      setHint(result.syncState==='local-only'?t('已保存在此设备，等待同步。','Saved on this device; waiting to sync.'):t('已保存到当前资料库。','Saved to the current library.'));
      await load(true);
    }catch(e){if(!persisted&&['RECORD_DRAFT_GENERATION_REUSED','RECORD_DRAFT_STALE','RECORD_DRAFT_TOO_LARGE'].includes(e.message)){pendingMutationRef.current=null;setPendingMutation(null);setUncertain(false);setError(`${t('编辑草稿未保存：','Edit draft not saved: ')}${String(e.message||e)}`);return;}setUncertain(true);setError(`${t('保存结果待核对，编辑内容已锁定并保留。请用同一请求再次核对：','Save result needs verification. Your edits are locked and preserved. Check again with the same request: ')}${String(e.message||e)}`);}
    finally{setBusy(false);}
  };
  const remove=async()=>{
    if(!selected||busy||!window.confirm(t(`删除「${selected.title||'未命名'}」？删除会保留在回收站中。`,`Delete “${selected.title||'Untitled'}”? It will be kept in the trash.`)))return;
    setBusy(true);setError('');setHint('');
    const generation=pendingActionRef.current?.type==='delete'?pendingActionRef.current.localGeneration:Math.max(generationRef.current,Number(selected.localGeneration||0))+1;
    const pending=pendingActionRef.current?.type==='delete'?pendingActionRef.current:{action:'delete',type:'delete',requestId:newId(),localGeneration:generation,id:selected.id,expectedRevision:selected.revision};
    pendingActionRef.current=pending;setPendingAction(pending);requestRef.current=pending.requestId;generationRef.current=pending.localGeneration;setSaveRequest(pending.requestId);
    try{
      await persistDraft(draftContent({form:selected,selectedId:selected.id,creating:false,editing:false,pendingAction:pending}),pending.requestId,pending.localGeneration,pending);
      setPendingDurable(true);
      const result=await call('recordDelete',{libraryId,id:pending.id,expectedRevision:pending.expectedRevision,requestId:pending.requestId});
      const ack=await enqueueRecordDraft(draftKey,()=>call('recordDraftAcknowledge',{libraryId,slot,requestId:pending.requestId,localGeneration:pending.localGeneration}));if(!ack.cleared)throw new Error(t('删除结果已返回，但草稿回执未确认。','Delete result returned, but the draft receipt is not confirmed.'));
      requestRef.current=null;setSaveRequest(null);pendingMutationRef.current=null;generationRef.current=pending.localGeneration+1;pendingActionRef.current=null;selectedRef.current=result.record;formRef.current={...result.record};setSelected(result.record);setForm({...result.record});setPendingAction(null);setPendingDurable(false);setHint(t('已移入回收站。','Moved to trash.'));await load(true);
    }
    catch(e){setError(`${t('删除结果待核对。保持当前页面并使用同一请求再次核对：','Delete result needs verification. Stay on this page and check again with the same request: ')}${String(e.message||e)}`);}finally{setBusy(false);}
  };
  const restore=async()=>{
    if(!selected||busy)return;setBusy(true);setError('');setHint('');
    const generation=pendingActionRef.current?.type==='restore'?pendingActionRef.current.localGeneration:Math.max(generationRef.current,Number(selected.localGeneration||0))+1;
    const pending=pendingActionRef.current?.type==='restore'?pendingActionRef.current:{action:'restore',type:'restore',requestId:newId(),localGeneration:generation,id:selected.id,expectedRevision:selected.revision};
    pendingActionRef.current=pending;setPendingAction(pending);requestRef.current=pending.requestId;generationRef.current=pending.localGeneration;setSaveRequest(pending.requestId);
    try{
      await persistDraft(draftContent({form:selected,selectedId:selected.id,creating:false,editing:false,pendingAction:pending}),pending.requestId,pending.localGeneration,pending);
      setPendingDurable(true);
      const result=await call('recordRestore',{libraryId,id:pending.id,expectedRevision:pending.expectedRevision,requestId:pending.requestId});
      const ack=await enqueueRecordDraft(draftKey,()=>call('recordDraftAcknowledge',{libraryId,slot,requestId:pending.requestId,localGeneration:pending.localGeneration}));if(!ack.cleared)throw new Error(t('恢复结果已返回，但草稿回执未确认。','Restore result returned, but the draft receipt is not confirmed.'));
      requestRef.current=null;setSaveRequest(null);pendingMutationRef.current=null;generationRef.current=pending.localGeneration+1;pendingActionRef.current=null;selectedRef.current=result.record;formRef.current={...result.record};setSelected(result.record);setForm({...result.record});setPendingAction(null);setPendingDurable(false);setHint(t('已恢复到资料库。','Restored to the library.'));await load(true);
    }
    catch(e){setError(`${t('恢复结果待核对。保持当前页面并使用同一请求再次核对：','Restore result needs verification. Stay on this page and check again with the same request: ')}${String(e.message||e)}`);}finally{setBusy(false);}
  };
  const loadVersions=async(reset=true)=>{if(!selected)return;setBusy(true);try{const page=await call('recordVersions',{libraryId,id:selected.id,cursor:reset?undefined:versionCursor});setVersions(old=>reset?page.items:[...old,...page.items]);setVersionCursor(page.nextCursor??null);}catch(e){setError(String(e.message||e));}finally{setBusy(false);}};
  const checks=useMemo(()=>checkArticle({title:form?.title,body:form?.markdown,sourceIds:form?.sourceIds}).map(item=>({label:t(({title:'有标题',body:'正文完整',structure:'文章结构',sources:'已关联来源',private:item.ok?'未发现常见敏感信息格式':'发现疑似敏感信息，请检查'})[item.id]||item.id),ok:item.ok})),[form,t]);
  const setField=(key,value)=>change(key,value);
  const insertImages=()=>runTransfer(async()=>{
    const result=await call('attachmentPick',{libraryId});
    if(result?.cancelled||!result?.items?.length)return;
    const items=result.items,input=markdownInput.current,before=formRef.current?.markdown||'';
    const start=input?.selectionStart??before.length,end=input?.selectionEnd??before.length;
    const snippets=items.map(item=>{
      const alt=String(item.name||'image').replace(/\.[^.]+$/,'').replace(/[\\\]]/g,'_');
      return `![${alt}](attachment:${item.id})`;
    });
    const insertion=`${start>0&&before[start-1]!=='\n'?'\n\n':''}${snippets.join('\n\n')}${end<before.length&&before[end]!=='\n'?'\n\n':''}`;
    setField('markdown',before.slice(0,start)+insertion+before.slice(end));
    const additions=items.map(({id,name,hash,byteLength,mimeType})=>({id,name,hash,byteLength,mimeType}));
    setField('attachmentDescriptors',[...(formRef.current?.attachmentDescriptors||[]),...additions]);
    setField('stagedAttachments',[...(formRef.current?.stagedAttachments||[]),...additions]);
    requestAnimationFrame(()=>{input?.focus();const cursor=start+insertion.length;input?.setSelectionRange(cursor,cursor);});
  });
  return <section className="record-page" aria-label={t(articles?'创作':'素材')}>
    {!detailOpen&&<><header className="record-page-head"><div>{onBack&&<button className="text" onClick={onBack}>‹ {t('返回')}</button>}</div><div className="record-header-actions"><button className="primary" disabled={busy||!draftReady} onClick={startNew}>＋ {t(articles?'新建文章':'新建记录')}</button></div></header>
    <div className="record-search"><input type="search" value={query} placeholder={t('搜索标题和正文')} onChange={e=>setQuery(e.target.value)} aria-label={t('搜索标题和正文')}/>{!articles&&<select value={kind} onChange={e=>setKind(e.target.value)} aria-label={t('按类型筛选')}><option value="">{t('全部类型')}</option>{kinds.map(item=><option key={item} value={item}>{kindName(item,t)}</option>)}</select>}<label className="deleted-filter"><input type="checkbox" checked={showDeleted} onChange={e=>setShowDeleted(e.target.checked)}/>{t('回收站')}</label></div></>}
    <div className={`record-layout${detailOpen?' record-detail-open':''}${!detailOpen?' record-list-only':''}`}>
      {!detailOpen&&<div className="record-list" aria-label={t(articles?'文章项目':'素材列表')}>
        {loading&&<p className="secondary">{t('更新中','Loading')}…</p>}
        {rows.map(row=><button key={row.id} className="record-list-row" aria-current={selected?.id===row.id?'true':undefined} onClick={()=>read(row.id)}><strong>{row.title||t('未命名')}</strong><span>{dateText(row.contentDay,t)}</span>{row.syncState&&row.syncState!=='synced'&&<small>{t(row.syncState==='conflict'?'有冲突':row.syncState==='pending'?'待同步':'本机资料')}</small>}</button>)}
        {!rows.length&&!loading&&<p className="empty-state">{query?t('没有匹配的记录。'):t('这里还没有内容。')}</p>}
        {more&&<button className="chip record-more" disabled={loading} onClick={()=>load(false)}>{t('更多历史版本')}</button>}
      </div>}
      <div className="record-detail">
        {detailOpen&&<button className="text record-back-list" onClick={leaveDetail}>‹ {t('返回列表','Back to list')}</button>}
        {editing&&form ? <>
          <div className="record-detail-head"><strong>{t(creating?'新建':articles?'编辑文章':'编辑记录')}</strong><div><button className="chip" disabled={busy||uncertain} onClick={leaveDetail}> {t('取消')}</button><button className="primary" disabled={busy||(!uncertain&&!form.markdown.trim())} onClick={doSave}>{busy?t('保存中…'):uncertain?t('再次核对保存结果'):t('保存')}</button></div></div>
          <label>{t('标题')}<input value={form.title||''} maxLength={200} disabled={busy||uncertain} onChange={e=>setField('title',e.target.value)}/></label>
          <label>{t('正文 · Markdown')}<button type="button" className="chip record-image-insert" disabled={busy||uncertain} onClick={insertImages}>{t('插入图片','Insert image')}</button><textarea ref={markdownInput} className="record-editor" value={form.markdown||''} disabled={busy||uncertain} onChange={e=>setField('markdown',e.target.value)} spellCheck="false"/></label>
          <details className="record-metadata"><summary>{t('记录信息','Details')}</summary>
          {!articles&&<div className="record-form-grid"><label>{t('类型')}<select value={form.kind} disabled={busy||uncertain} onChange={e=>setField('kind',e.target.value)}>{kinds.map(item=><option key={item} value={item}>{kindName(item,t)}</option>)}</select></label><label>{t('内容来源')}<select value={form.origin||'personal'} disabled={busy||uncertain||!creating} onChange={e=>setField('origin',e.target.value)}><option value="personal">{t('自己书写')}</option><option value="external">{t('外部资料')}</option><option value="ai">{t('AI 内容')}</option><option value="translation">{t('译文')}</option><option value="unknown">{t('来源待确认')}</option></select></label></div>}
          {articles&&<><div className="record-form-grid"><label>{t('文章状态')}<select value={form.stage||'draft'} disabled={busy||uncertain} onChange={e=>setField('stage',e.target.value)}><option value="idea">{t('想法')}</option><option value="draft">{t('草稿')}</option><option value="revision">{t('修改中')}</option><option value="final">{t('已定稿')}</option></select></label></div><details className="source-picker"><summary>{t('关联素材')} · {(form.sourceIds||[]).length}</summary><input type="search" aria-label={t('搜索素材','Search materials')} placeholder={t('搜索素材','Search materials')} value={sourceQuery} onChange={e=>{const value=e.target.value;setSourceQuery(value);loadSources(null,value);}}/><div className="source-results">{(form.sourceIds||[]).filter(id=>!sources.some(source=>source.id===id)).map(id=><label key={id}><input type="checkbox" checked disabled={busy||uncertain} onChange={()=>setField('sourceIds',form.sourceIds.filter(item=>item!==id))}/>{t('已关联来源（尚未加载或已删除）','Linked source (not loaded or deleted)')} · {id}</label>)}{sources.map(source=><label key={source.id}><input type="checkbox" disabled={busy||uncertain} checked={(form.sourceIds||[]).includes(source.id)} onChange={e=>setField('sourceIds',e.target.checked?[...(form.sourceIds||[]),source.id]:(form.sourceIds||[]).filter(id=>id!==source.id))}/>{source.title||t('未命名')} · {dateText(source.contentDay,t)}</label>)}{sourceLoading&&<p>{t('正在读取素材…','Loading materials…')}</p>}{sourceError&&<p className="error">{t('读取素材失败','Could not load materials')}: {sourceError} <button type="button" onClick={()=>loadSources(sourceRetry,sourceQuery)}>{t('重试','Retry')}</button></p>}{!sources.length&&!sourceLoading&&!sourceError&&<p className="secondary">{t('暂无可关联素材。','No materials to link.')}</p>}</div>{sourceCursor&&!sourceError&&<button type="button" className="chip" disabled={sourceLoading} onClick={()=>loadSources(sourceCursor,sourceQuery)}>{t('加载更多','Load more')}</button>}</details><details className="publication-check"><summary>{t('发布前检查')} · {checks.filter(x=>!x.ok).length} {t('项待处理')}</summary>{checks.map(check=><p key={check.label} className={check.ok?'check-ok':'check-pending'}>{check.ok?'✓':'○'}　{check.label}</p>)}<p className="secondary">{t('仅检查常见格式，仍需作者人工复核。','Checks common patterns only; review the article yourself.')}</p></details></>}
          <label>{t('内容日期')}<input type="date" value={form.contentDay||''} disabled={busy||uncertain} onChange={e=>setField('contentDay',e.target.value||null)}/></label>
          <label>{t('来源说明')}<input value={form.dateBasis||''} maxLength={200} disabled={busy||uncertain} onChange={e=>setField('dateBasis',e.target.value)}/></label>
          <label>{t('来源链接')}<input type="url" value={form.url||''} maxLength={2048} disabled={busy||uncertain} onChange={e=>setField('url',e.target.value)}/></label>
          <label>{t('备注')}<textarea value={form.annotation||''} maxLength={10000} disabled={busy||uncertain} onChange={e=>setField('annotation',e.target.value)}/></label>
          </details>
        </> : selected ? <>
          <div className="record-detail-head"><div><span className="state-pill">{kindName(selected.kind,t)}</span><span className="state-pill">{originName(selected.origin,t)}</span></div><div>{pendingAction?.type==='delete'?<button className="chip danger" disabled={busy} onClick={remove}>{t('再次核对删除')}</button>:pendingAction?.type==='restore'?<button className="chip" disabled={busy} onClick={restore}>{t('再次核对恢复')}</button>:selected.deleted?<button className="chip" disabled={busy} onClick={restore}>{t('恢复')}</button>:<><button className="chip" disabled={busy||annotationState.dirty||annotationState.busy} onClick={()=>startEdit(selected)}>{t('编辑')}</button><details className="record-actions"><summary>{t('更多','More')}</summary><button className="chip" disabled={busy} onClick={exportSelected}>{t('导出 Markdown','Export Markdown')}</button><button className="chip" disabled={busy} onClick={exportSelectedWithImages}>{t('导出原文、标注与图片','Export original, annotations and images')}</button><button className="chip" disabled={busy} onClick={shareSelected}>{t('分享','Share')}</button><button className="chip" disabled={busy||annotationState.dirty} onClick={correctOrigin}>{t('更正来源','Correct origin')}</button><button className="chip danger" disabled={busy||annotationState.dirty||annotationState.busy} onClick={remove}>{t('删除')}</button></details></>}</div></div>
          <h2>{selected.title||t('未命名')}</h2><p className="secondary record-date">{t('内容日期')}：{dateText(selected.contentDay,t)} · {t('记录于')} {dateText(selected.createdAt,t)}{selected.updatedAt&&` · ${t('更新于')} ${dateText(selected.updatedAt,t)}`}</p>
          {selected.url&&<p className="record-source"><span>{t('来源链接')}</span>{safeHttp(selected.url)?<a href={safeHttp(selected.url)} target="_blank" rel="noreferrer">{selected.url}</a>:<span>{selected.url}</span>}</p>}
          {selected.dateBasis&&<p className="record-source"><span>{t('日期说明')}</span>{selected.dateBasis}</p>}{selected.annotation&&<p className="record-source"><span>{t('备注')}</span>{selected.annotation}</p>}
          {selected.deleted&&<p className="conflict-callout">{t('此记录在回收站中，恢复后会回到当前资料库。')}</p>}
          <AnnotationPanel key={`${libraryId}:${selected.id}`} libraryId={libraryId} original={selected} attachments={attachments} t={t} onStateChange={setAnnotationState}/>
          {selected.sources?.length>0&&<details className="source-picker"><summary>{t('正文来源')} · {selected.sources.length}</summary>{selected.sources.map((segment,index)=><div className="source-segment" key={`${index}-${segment.sourceRef||''}`}><strong>{originName(segment.origin,t)}</strong>{segment.sourceRef&&<span>{segment.sourceRef}</span>}<p>{segment.text?.length>220?`${segment.text.slice(0,220)}…`:segment.text}</p></div>)}</details>}
          {attachments.length>0&&<details className="source-picker"><summary>{t('原件与附件')} · {attachments.length}</summary>{attachments.map(file=><div className="attachment-row" key={file.id}><div><strong>{file.name}</strong><span>{byteText(file.byteLength)} · {file.available===false?t('尚未下载'):t('已保存在资料库')}</span></div><div className="node-actions">{file.available!==false&&<><button className="chip" disabled={busy} onClick={()=>openAttachment(file)}>{t('打开','Open')}</button><button className="chip" disabled={busy} onClick={()=>shareAttachment(file)}>{t('分享','Share')}</button></>}</div></div>)}</details>}
          {!articles&&!selected.deleted&&libraries.some(item=>item.libraryId!==libraryId)&&<div className="record-copy-row"><label>{t('复制到资料库','Copy to library')}<select value={copyTarget} disabled={busy} onChange={e=>setCopyTarget(e.target.value)}><option value="">{t('选择目标资料库','Choose target library')}</option>{libraries.filter(item=>item.libraryId!==libraryId).map(item=><option key={item.libraryId} value={item.libraryId}>{item.name}</option>)}</select></label><button className="chip" disabled={busy||!copyTarget} onClick={copySelected}>{t('复制正文','Copy text')}</button><button className="chip" disabled={busy||!copyTarget} onClick={copySelectedWithImages}>{t('复制正文和图片','Copy with images')}</button></div>}
          {selected.sourceIds?.length>0&&<details className="source-picker" open><summary>{t('关联素材')} · {selected.sourceIds.length}</summary>{selected.sourceIds.map(id=><button key={id} className="source-link" onClick={()=>read(id)}>{sources.find(item=>item.id===id)?.title||id}</button>)}</details>}
          <details className="record-versions" open={showVersions} onToggle={e=>{if(e.currentTarget.open&&!showVersions){setShowVersions(true);loadVersions(true);}}}><summary>{t('版本历史')}</summary>{versions.map((version,index)=><details key={version.versionId||index} className="version-row"><summary>{dateText(version.updatedAt||version.createdAt||version.occurredAt,t)} · {version.reason||'历史版本'}</summary>{version.markdown!=null&&<MarkdownView markdown={version.markdown} libraryId={libraryId} recordId={selected.id} attachmentDescriptors={[...(version.doc?.attachmentDescriptors||[]),...attachments]}/>}</details>)}{versionCursor&&<button className="chip" onClick={()=>loadVersions(false)}>{t('更多历史版本')}</button>}</details>
        </> : <div className="record-empty"><span>◇</span><p>{t('选择一条记录查看正文和来源。')}</p></div>}
      </div>
    </div>
    {error&&<p className="error" role="alert">{error}</p>}{hint&&<p className="success-note" role="status">{hint}</p>}
  </section>;
}

function safeHttp(value){try{const url=new URL(value);return ['http:','https:'].includes(url.protocol)?url.href:null;}catch{return null;}}
