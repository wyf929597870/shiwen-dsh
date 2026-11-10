import {ReadingNotesPage,BookIcon,ReadingNoteSources} from './reading/ReadingNotesPage.jsx';
import {desktopReadingNotes} from './reading/adapters.mjs';
import readingCss from './reading/reading-notes.css';
import React,{useState,useEffect,useMemo,useSyncExternalStore,useRef} from 'react';
import {HomeOverview} from './HomeOverview.jsx';
import {MobileNav} from './MobileNav.jsx';
import {ExternalPanel} from './ExternalPanel.jsx';
import {ImportSettings} from './ImportSettings.jsx';
import {AccessSettings} from './AccessSettings.jsx';
import MarkdownIt from 'markdown-it';
import baseCss from './style.css';
import goalsCss from './review-goals.css';
const css=baseCss+'\n'+goalsCss+'\n'+readingCss;
import {ReviewPage} from './ReviewPage.jsx';
import {ArticleCheck} from './ArticleCheck.jsx';
import {WritingSources} from './WritingSources.jsx';
import {Annotations} from './Annotations.jsx';
import {OriginCorrection} from './OriginCorrection.jsx';

const md=new MarkdownIt({html:false,linkify:false,breaks:true});
const newRequestId=()=>{if(globalThis.crypto.randomUUID)return globalThis.crypto.randomUUID();const bytes=globalThis.crypto.getRandomValues(new Uint8Array(16));bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;const value=[...bytes].map(x=>x.toString(16).padStart(2,'0')).join('');return `${value.slice(0,8)}-${value.slice(8,12)}-${value.slice(12,16)}-${value.slice(16,20)}-${value.slice(20)}`;};
md.inline.ruler.before('link','wiki_image',(state,silent)=>{
 if(!state.src.startsWith('![[',state.pos))return false;const end=state.src.indexOf(']]',state.pos+3);if(end<0)return false;
 if(!silent){const [target,...label]=state.src.slice(state.pos+3,end).split('|'),token=state.push('image','img',0);token.attrs=[['src',target]];token.content=label.join('|')||target;}
 state.pos=end+2;return true;
});
const decodeImageTarget=value=>{try{return decodeURIComponent(value);}catch{return value;}};
const imageReferences=body=>new Set(md.parse(body,{}).flatMap(block=>block.children??[]).filter(token=>token.type==='image').map(token=>/^attachment:([A-Za-z0-9_-]{1,100})$/i.exec(token.attrGet('src')??'')?.[1]).filter(Boolean));
md.renderer.rules.image=(tokens,index,options,env,self)=>{
 const token=tokens[index],src=token.attrGet('src')??'',match=/^attachment:([0-9a-f-]{36})$/i.exec(src);
 const mapped=env?.links?.find(link=>decodeImageTarget(String(link.target??'').split('|')[0])===decodeImageTarget(src)&&link.attachment)?.attachment,id=match?.[1]??mapped;
 if(!id||!/^[0-9a-f-]{36}$/i.test(id)){
  if(/^https?:\/\//i.test(src)&&src.length<=2048)return `<button type="button" class="sw-remote-image" data-image-url="${md.utils.escapeHtml(src)}">加载网络图片：${md.utils.escapeHtml(token.content||'图片')}</button>`;
  return `<span class="sw-image-placeholder">${md.utils.escapeHtml(token.content||'图片不可用')}</span>`;
 }
 return `<span class="sw-image-placeholder" data-shiwen-image="${id}">${md.utils.escapeHtml(token.content||'图片')}</span>`;
};
const dict={
 zh:{libraryIntro:'让记录有处可寻，让写作有据可依。',articlesIntro:'把想法、记录与资料汇聚起来，继续你的创作。',hideList:'收起列表',showList:'展开列表',dataSettings:'拾文资料',serverPathHelp:'请输入运行服务的电脑上的资料库路径。',remove:'删除',confirmRemove:'确认删除',removePrompt:'删除这条记录？',removeHelp:'删除后不再出现在列表、搜索和助手的资料查询中；原始导入文件不受影响。可在当前页面撤销。',removed:'已删除',undo:'撤销删除',deletedSource:'已删除的素材',linkedWarning:'有关联文章使用此素材，文章正文和关联关系会保留。',library:'素材',articles:'创作',review:'回顾',reading:'读书笔记',all:'全部',journal:'日记',freewrite:'自由书写',reading_note:'读书笔记',idea:'想法',web:'网页',ai:'AI 讨论',reference:'参考资料',article:'文章',search:'搜索标题和正文',new:'新建',save:'保存',cancel:'取消',edit:'编辑',preview:'预览',write:'编辑正文',title:'标题',body:'正文',date:'内容日期',unknown:'日期待确认',source:'来源',draft:'草稿',revision:'修改中',final:'已定稿',stage:'状态',allTypes:'全部类型',allStages:'全部状态',associated:'关联素材',noRecords:'还没有内容',choose:'选择一条记录查看',loading:'正在加载…',saving:'正在保存…',error:'操作失败',saved:'已保存',today:'今日',days7:'近 7 天',days14:'近 14 天',days30:'近 30 天',month:'自然月',added:'个人新增字数',collected:'收集素材',personal:'个人记录',active:'活跃文章',history:'历史记录字数',undated:'日期待确认',references:'来源和日期',related:'关联素材',content:'可读正文',kind:'类型',saveDraft:'保存文章',filter:'筛选',back:'返回',newRecord:'新建记录',noSources:'暂无关联素材',noDetail:'这段时间没有记录',timeBasis:'个人新增字数按实际编辑时间统计；历史导入按内容日期展示。',unsaved:'正文尚有未保存的修改。',stay:'继续编辑',discard:'放弃修改',open:'打开',select:'选择',update:'更新',imported:'历史导入',originPersonal:'自己书写',originAI:'AI 内容',originExternal:'外部资料',originUnknown:'来源待确认',originTranslation:'译文',untitled:'未命名',sourceHistory:'对话来源',refresh:'刷新',importOld:'导入旧版资料',oldPath:'旧资料库文件路径',inspect:'预览',applyImport:'导入到空资料库',oldMessages:'历史消息',importDone:'导入完成。历史对话作为归档保留。',importHelp:'只读取旧资料库；目标资料库已有内容时不会覆盖。'},
 en:{libraryIntro:'A place for your notes, a foundation for your writing.',articlesIntro:'Bring your ideas and materials together. Keep writing.',hideList:'Hide list',showList:'Show list',dataSettings:'Shiwen data',serverPathHelp:'Enter a library path on the computer running this service.',remove:'Delete',confirmRemove:'Confirm deletion',removePrompt:'Delete this record?',removeHelp:'Removed from lists, search and assistant library queries. Original imported files remain unchanged. You can undo on this page.',removed:'Deleted',undo:'Undo deletion',deletedSource:'Deleted material',linkedWarning:'Articles reference this material. Their text and links will be preserved.',library:'Materials',articles:'Writing',review:'Review',reading:'Reading notes',all:'All',journal:'Journal',freewrite:'Freewriting',reading_note:'Reading notes',idea:'Idea',web:'Web',ai:'AI discussion',reference:'Reference',article:'Article',search:'Search titles and text',new:'New',save:'Save',cancel:'Cancel',edit:'Edit',preview:'Preview',write:'Edit text',title:'Title',body:'Content',date:'Content date',unknown:'Date unconfirmed',source:'Source',draft:'Draft',revision:'In revision',final:'Final',stage:'Status',allTypes:'All types',allStages:'All statuses',associated:'Related materials',noRecords:'No records yet',choose:'Select a record to read',loading:'Loading…',saving:'Saving…',error:'Action failed',saved:'Saved',today:'Today',days7:'Last 7 days',days14:'Last 14 days',days30:'Last 30 days',month:'Calendar month',added:'Personal characters added',collected:'Materials collected',personal:'Personal records',active:'Active articles',history:'Historical characters',undated:'Dates unconfirmed',references:'Source and date',related:'Related materials',content:'Reading view',kind:'Type',saveDraft:'Save article',filter:'Filter',back:'Back',newRecord:'New record',noSources:'No linked materials',noDetail:'No records in this period',timeBasis:'Personal additions use edit dates; imported history uses content dates.',unsaved:'You have unsaved edits.',stay:'Keep editing',discard:'Discard changes',open:'Open',select:'Select',update:'Update',imported:'Imported',originPersonal:'Personal',originAI:'AI content',originExternal:'External',originUnknown:'Unknown',originTranslation:'Translation',untitled:'Untitled',sourceHistory:'Conversation source',refresh:'Refresh',importOld:'Import previous library',oldPath:'Path to previous library',inspect:'Preview',applyImport:'Import into empty library',oldMessages:'Historical messages',importDone:'Import complete. Previous conversations remain archived.',importHelp:'The old library is read only. An existing destination is never overwritten.'}
};
async function rpc(method,args={}){
 const response=await fetch('/api/shiwen',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({method,args})});
 const data=await response.json();if(!response.ok){const error=new Error(data.error||'Request failed');error.httpStatus=response.status;throw error;}return data.result;
}
function MarkdownContent({body,record}){
 const recordId=record.id,root=useRef(null),html=useMemo(()=>md.render(body,{links:record.importInfo?.links??[]}),[body,record.importInfo]);
 useEffect(()=>{let active=true,total=0;const elements=[...(root.current?.querySelectorAll('[data-shiwen-image]')??[])].slice(0,20);
  for(const button of root.current?.querySelectorAll('[data-image-url]')??[])button.addEventListener('click',()=>{let url;try{url=new URL(button.dataset.imageUrl);}catch{return;}if(!['http:','https:'].includes(url.protocol)||url.username||url.password)return;const img=document.createElement('img');img.alt=button.textContent||'';img.referrerPolicy='no-referrer';img.onerror=()=>{if(active&&img.isConnected)img.replaceWith(button);};img.src=url.href;button.replaceWith(img);});
  for(const element of elements)rpc('readImage',{id:recordId,attachmentId:element.dataset.shiwenImage}).then(image=>{
   if(!active||!['image/png','image/jpeg','image/gif','image/webp'].includes(image.mime))return;
   total+=image.dataBase64.length;if(total>Math.ceil(16*1024*1024*4/3))return;
   const img=document.createElement('img');img.alt=element.textContent||'';img.src=`data:${image.mime};base64,${image.dataBase64}`;element.replaceWith(img);
  }).catch(()=>{});
  return()=>{active=false;};
 },[html,recordId]);
 return <div ref={root} className="sw-markdown" dangerouslySetInnerHTML={{__html:html}}/>;
}
function DeleteConfirmation({target,linked,busy,t,onCancel,onConfirm}){
 const dialog=useRef(null);
 useEffect(()=>{dialog.current.showModal();},[]);
 return <dialog ref={dialog} className="sw-delete-dialog" aria-labelledby="sw-delete-title" aria-describedby="sw-delete-help" onCancel={event=>{event.preventDefault();if(!busy)onCancel();}}>
  <h2 id="sw-delete-title">{t('removePrompt')}</h2><p className="sw-delete-name">{target.title||t('untitled')}</p><p id="sw-delete-help">{t('removeHelp')}</p>
  {linked>0&&<p>{t('linkedWarning')} ({linked})</p>}
  <div><button autoFocus disabled={busy} onClick={onCancel}>{t('cancel')}</button><button className="sw-danger" disabled={busy} onClick={onConfirm}>{t('confirmRemove')}</button></div>
 </dialog>;
}
function Panel({section,locale,uiWorkspace}){
 const language=useSyncExternalStore(callback=>locale.subscribe(callback),()=>locale.getSnapshot().active,()=>locale.getSnapshot().active);
 const t=k=>(language==='zh'||String(language).startsWith('zh')?dict.zh:dict.en)[k]??k;
 const [records,setRecords]=useState([]),[selected,setSelected]=useState(null),[record,setRecord]=useState(null),[filter,setFilter]=useState(''),[query,setQuery]=useState('');
 const [loading,setLoading]=useState(false),[error,setError]=useState(''),[busy,setBusy]=useState(false),[editing,setEditing]=useState(false),[dirty,setDirty]=useState(false),[title,setTitle]=useState(''),[body,setBody]=useState(''),[kind,setKind]=useState('freewrite'),[stage,setStage]=useState('draft'),[sources,setSources]=useState([]),[day,setDay]=useState('');
 const [showCheck,setShowCheck]=useState(false),[annotationEditing,setAnnotationEditing]=useState(false);
 const annotationPending=useRef(false),originPending=useRef(false);
 const [originCorrectionPending,setOriginCorrectionPending]=useState(false),[annotationActionPending,setAnnotationActionPending]=useState(false);
 const [stagedImages,setStagedImages]=useState([]),[pendingImageSave,setPendingImageSave]=useState(null);
 const imageInput=useRef(null),bodyInput=useRef(null),cursor=useRef(null);
 const [sourcesOpen,setSourcesOpen]=useState(true);
 const [desktop,setDesktop]=useState(()=>window.matchMedia('(min-width: 761px)').matches);
 useEffect(()=>{const media=window.matchMedia('(min-width: 761px)');const change=()=>setDesktop(media.matches);media.addEventListener('change',change);return()=>media.removeEventListener('change',change);},[]);
 const writing=section==='articles'&&editing&&desktop;
 const draftRevision=useRef(Date.now()*1000),draftQueue=useRef(Promise.resolve()),draftTouched=useRef(false);
 const [mobileDetail,setMobileDetail]=useState(false);
 const detailPane=useRef(null),listPane=useRef(null);
 useEffect(()=>{if(!window.matchMedia('(max-width: 760px)').matches)return;
  const target=mobileDetail?detailPane.current?.querySelector('input, h2'):listPane.current?.querySelector('[aria-current="true"]');
  target?.focus({preventScroll:true});
 },[mobileDetail]);
 const [deleteTarget,setDeleteTarget]=useState(null),[deleted,setDeleted]=useState([]);
 const listKey=`shiwen-list-collapsed:${section}`;
 const [listCollapsed,setListCollapsed]=useState(()=>{try{return localStorage.getItem(listKey)==='true';}catch{return false;}});
 useEffect(()=>{try{localStorage.setItem(listKey,String(listCollapsed));}catch{}},[listKey,listCollapsed]);
 const draftKey=`shiwen-editor-draft:${section}`;
 const persistDraft=draft=>{draftTouched.current=true;const revision=Math.max(draftRevision.current+1,Date.now()*1000);draftRevision.current=revision;const value=draft?{...draft,draftRevision:revision}:null;localStorage.setItem(draftKey,JSON.stringify(value));const task=draftQueue.current.catch(()=>{}).then(()=>rpc('workbenchDraft',{slot:section,value,revision}));draftQueue.current=task;task.catch(e=>setError(`草稿同步失败：${e.message}`));return task;};

 async function refresh(){setLoading(true);setError('');try{const data=await rpc('snapshot');setRecords(data.records);}catch(e){setError(e.message);}finally{setLoading(false);}}
 useEffect(()=>{refresh();
  if(section==='review')return;let saved;try{saved=JSON.parse(localStorage.getItem(draftKey)||'null');}catch{};
  const restore=async()=>{try{let remote;try{remote=await rpc('workbenchDraft',{slot:section});}catch(e){if(!saved)throw e;}if(remote?.revision>draftRevision.current)draftRevision.current=remote.revision;if(remote?.revision>(saved?.draftRevision??0)&&(saved?.draftRevision||remote.value))saved=remote.value;
    if(!saved||draftTouched.current)return;draftRevision.current=Math.max(draftRevision.current,saved.draftRevision??0);const current=saved.id?await rpc('readMarkdown',{id:saved.id}):null;if(draftTouched.current)return;setRecord(current?{...current,revision:saved.revision}:null);setSelected(saved.id??null);setTitle(saved.title);setBody(saved.body);setKind(saved.kind);setStage(saved.stage);setSources(saved.sources??[]);setStagedImages(saved.stagedImages??[]);setPendingImageSave(saved.pendingImageSave??null);setEditing(true);setDirty(true);setMobileDetail(true);}catch(e){setError(e.message);}};restore();
 },[]);
 useEffect(()=>{const changed=()=>{void refresh();};window.addEventListener('shiwen-library-updated',changed);return()=>window.removeEventListener('shiwen-library-updated',changed);},[]);

 const visible=useMemo(()=>records.filter(r=>r.kind!=='ai_annotation').filter(r=>section==='articles'?r.kind==='article':r.kind!=='article').filter(r=>!filter||(section==='articles'?r.stage===filter:r.kind===filter)).filter(r=>!query||(`${r.title}\n${r.body}`).toLowerCase().includes(query.toLowerCase())),[records,section,filter,query]);
 function confirmLeave(){if(originPending.current){setError('来源更正结果待确认，请先重试');return false;}if(annotationPending.current){setError('标注保存结果待确认，请先重试保存');return false;}if(annotationEditing&&!window.confirm(String(language).startsWith('zh')?'标注草稿会保留，继续切换？':'Keep the annotation draft and continue?'))return false;if(pendingImageSave){setError('上次图文保存结果待确认，请先重试保存');return false;}return !dirty||window.confirm(t('unsaved')+' '+t('discard')+'?');}
 async function openRecord(id){if(!confirmLeave())return;persistDraft(null).then(()=>stagedImages.length&&rpc('discardStagedImages',{ids:stagedImages})).catch(()=>{});localStorage.removeItem(draftKey);setStagedImages([]);setError('');setLoading(true);try{const value=await rpc('readMarkdown',{id});setSelected(id);setRecord(value);cursor.current=null;setTitle(value.title);setBody(value.markdown);setKind(value.kind);setStage(value.stage);setSources(value.sourceIds??[]);setDay(value.importInfo?.day??value.dateInfo?.day??'');setEditing(false);setDirty(false);setMobileDetail(true);setShowCheck(false);}catch(e){setError(e.message);}finally{setLoading(false);}}
 function create(){if(!confirmLeave())return;persistDraft(null).then(()=>stagedImages.length&&rpc('discardStagedImages',{ids:stagedImages})).catch(()=>{});localStorage.removeItem(draftKey);setStagedImages([]);setSelected(null);setRecord(null);setTitle('');setBody('');cursor.current=null;setKind(section==='articles'?'article':'freewrite');setStage('draft');setSources([]);setDay('');setEditing(true);setDirty(false);setMobileDetail(true);setShowCheck(false);}
 async function save(){if(busy)return;setBusy(true);setError('');const references=imageReferences(body),imageIds=stagedImages.filter(id=>references.has(id));const payload=pendingImageSave??{id:record?.id,revision:record?.revision,kind,title,body,stage,sourceIds:kind==='article'?sources:undefined,...(imageIds.length?{imageIds,requestId:newRequestId()}:{})};
  if(payload.imageIds?.length&&!pendingImageSave){try{await persistDraft({id:record?.id??null,revision:record?.revision??null,title,body,kind,stage,sources,stagedImages,pendingImageSave:payload});setPendingImageSave(payload);}catch{setBusy(false);setError('无法保存待确认的图文草稿');return;}}
  let value;try{value=await rpc('saveMarkdown',payload);}catch(e){if(e.httpStatus&&payload.imageIds?.length){setPendingImageSave(null);try{await persistDraft({id:record?.id??null,revision:record?.revision??null,title,body,kind,stage,sources,stagedImages});}catch{}}setError(e.message);setBusy(false);return;}
  try{await persistDraft(null);}catch(e){if(payload.imageIds?.length){setError(`已保存，但草稿清理未确认，请再次保存以核对：${e.message}`);setBusy(false);return;}setError(`已保存，草稿清理失败：${e.message}`);}localStorage.removeItem(draftKey);if(stagedImages.length)rpc('discardStagedImages',{ids:stagedImages}).catch(()=>{});setPendingImageSave(null);setStagedImages([]);setDirty(false);try{await refresh();const fresh=await rpc('readMarkdown',{id:value.id});setSelected(value.id);setRecord(fresh);setBody(fresh.markdown);setTitle(fresh.title);setSources(fresh.sourceIds??[]);if(!(section==='articles'&&desktop))setEditing(false);}catch(e){setError(e.message);}finally{setBusy(false);}}
 async function cancelEdit(){if(!confirmLeave()||busy)return;setBusy(true);try{await persistDraft(null);if(stagedImages.length)await rpc('discardStagedImages',{ids:stagedImages});localStorage.removeItem(draftKey);setStagedImages([]);setEditing(false);setDirty(false);if(record){setTitle(record.title);setBody(record.markdown);setKind(record.kind);setStage(record.stage);setSources(record.sourceIds??[]);}else{setSelected(null);setMobileDetail(false);}}catch(e){setError(`草稿清理失败：${e.message}`);}finally{setBusy(false);}}
 async function insertImages(files){if(pendingImageSave||busy)return;setBusy(true);setError('');try{if(stagedImages.length+files.length>20)throw Error('每次最多添加 20 张图片');let next=body,ids=[...stagedImages],pos=bodyInput.current?.selectionStart??next.length;for(const file of files){if(file.size>8*1024*1024)throw Error('图片超过 8 MiB');const bytes=new Uint8Array(await file.arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=32768)binary+=String.fromCharCode(...bytes.subarray(i,i+32768));const image=await rpc('stageImage',{name:file.name,dataBase64:btoa(binary)});ids.push(image.id);const marker=`![图片](attachment:${image.id})`;next=next.slice(0,pos)+marker+next.slice(pos);pos+=marker.length;
   const queued=persistDraft({id:record?.id??null,revision:record?.revision??null,title,body:next,kind,stage,sources,stagedImages:ids});setStagedImages([...ids]);setBody(next);setDirty(true);await queued;}
  }catch(e){setError(e.message);}finally{setBusy(false);if(imageInput.current)imageInput.current.value='';}}
 async function removeRecord(){
  if(busy||!deleteTarget)return;
  setBusy(true);setError('');
  try{
   const receipt=await rpc('remove',{id:deleteTarget.id,revision:deleteTarget.revision});
   setDeleted(items=>[...items,{...receipt,title:deleteTarget.title}]);
   localStorage.removeItem(draftKey);setSelected(null);setRecord(null);setEditing(false);setDirty(false);setDeleteTarget(null);setMobileDetail(false);
   setRecords(items=>items.filter(item=>item.id!==receipt.id));await refresh();
  }catch(e){setError(e.message);setDeleteTarget(null);}finally{setBusy(false);}
 }
 async function undoRemove(receipt){
  if(busy)return;setBusy(true);setError('');
  try{await rpc('restoreRemoved',{id:receipt.id,revision:receipt.revision});setDeleted(items=>items.filter(item=>item.id!==receipt.id));await refresh();}
  catch(e){setError(e.message);}finally{setBusy(false);}
 }
 async function updateDate(){if(!record)return;setBusy(true);setError('');try{await rpc('updateRecord',{id:record.id,revision:record.revision,day:day||null});await refresh();const value=await rpc('readMarkdown',{id:record.id});setRecord(value);}catch(e){setError(e.message);}finally{setBusy(false);}}
 const update=(setter,value)=>{if(busy)return;if(pendingImageSave){setError('上次图文保存结果待确认，请先重试保存');return;}const draft={id:record?.id??null,revision:record?.revision??null,title,body,kind,stage,sources,stagedImages};
  if(setter===setTitle)draft.title=value;else if(setter===setBody)draft.body=value;else if(setter===setKind)draft.kind=value;else if(setter===setStage)draft.stage=value;else if(setter===setSources)draft.sources=value;
  try{persistDraft(draft);setError('');}catch(e){setError(String(language).startsWith('zh')?'草稿无法自动保存，请手动保存。':'Draft could not be saved automatically. Save it now.');}
  setter(value);setDirty(true);
 };
 function quoteSource(source,text){
  if(busy||pendingImageSave||!text)return;
  const pos=Math.min(cursor.current??body.length,body.length), quote=text.split(/\r?\n/).map(line=>'> '+line).join('\n');
  const prefix=pos&&body[pos-1]!=='\n'?'\n\n':pos&&body[pos-2]!=='\n'?'\n':'';
  const suffix=body.slice(pos)&&!body.slice(pos).startsWith('\n')?'\n\n':'\n';
  const nextBody=body.slice(0,pos)+prefix+quote+suffix+body.slice(pos), nextSources=sources.includes(source.id)?sources:[...sources,source.id];
  const draft={id:record?.id??null,revision:record?.revision??null,title,body:nextBody,kind,stage,sources:nextSources,stagedImages};
  try{persistDraft(draft);setError('');}catch{setError('草稿无法自动保存，请手动保存。');}
  setBody(nextBody);setSources(nextSources);setDirty(true);cursor.current=pos+prefix.length+quote.length+suffix.length;
  requestAnimationFrame(()=>{bodyInput.current?.focus();bodyInput.current?.setSelectionRange(cursor.current,cursor.current);});
 }
 const typeName=k=>t(k==='reference'?'reference':k);
 const externalActionName=action=>({shiwen_save:['保存','Saved'],shiwen_collect:['收藏','Collected'],shiwen_update:['修改','Updated'],shiwen_delete:['删除','Deleted'],shiwen_restore:['恢复','Restored']})[action]?.[String(language).startsWith('zh')?0:1]??(String(language).startsWith('zh')?'操作':'Activity');
 const originName=o=>t(({personal:'originPersonal',ai:'originAI',external:'originExternal',translation:'originTranslation'})[o]??'originUnknown');
 if(section==='review')return <ReviewPage rpc={rpc} language={language} md={md} typeName={typeName}/>;
 return <main className={"sw-view sw-library-view"+(listCollapsed?" sw-list-collapsed":"")+(mobileDetail?" sw-mobile-detail":"")+(writing?" sw-writing-mode":"")+(writing&&sourcesOpen?" sw-writing-open":"")}>{deleteTarget&&<DeleteConfirmation target={deleteTarget} linked={records.filter(r=>r.kind==='article'&&r.sourceIds?.includes(deleteTarget.id)).length} busy={busy} t={t} onCancel={()=>setDeleteTarget(null)} onConfirm={removeRecord}/>}<div className="sw-head"><button className="sw-mobile-back" onClick={()=>setMobileDetail(false)}>← {t('back')}</button><div className="sw-panel-heading"><h1>{t(section)}</h1><p className="sw-sub">{t(section==='articles'?'articlesIntro':'libraryIntro')}</p></div><div className="sw-head-actions">{editing&&!mobileDetail&&<button className="sw-mobile-resume" onClick={()=>setMobileDetail(true)}>{t('stay')}</button>}<button className="sw-list-toggle" aria-expanded={!listCollapsed} aria-controls={`sw-record-list-${section}`} onClick={()=>setListCollapsed(value=>!value)}>{t(listCollapsed?'showList':'hideList')}</button><button className="sw-primary" onClick={create}>＋ {t('new')}</button></div></div>{error&&<div className="sw-error" role="alert">{error}</div>}{deleted.length>0&&<div className="sw-notice sw-undo" role="status">{deleted.map(item=><div key={item.id}><span>{t('removed')}: {item.title||t('untitled')}</span><button disabled={busy} onClick={()=>undoRemove(item)}>{t('undo')}</button></div>)}</div>}<div className="sw-columns"><section className="sw-list" id={`sw-record-list-${section}`} ref={listPane} aria-label={t(section)}>
 <div className="sw-list-controls"><div className="sw-toolbar"><input type="search" aria-label={t('search')} value={query} placeholder={t('search')} onChange={e=>setQuery(e.target.value)}/><label className="sw-filter"><span>{t(section==='library'?'kind':'stage')}</span><select aria-label={t(section==='library'?'kind':'stage')} value={filter} onChange={e=>setFilter(e.target.value)}><option value="">{t(section==='library'?'allTypes':'allStages')}</option>{(section==='library'?['journal','freewrite','reading_note','idea','web','ai','reference']:['idea','draft','revision','final']).map(k=><option key={k} value={k}>{t(k)}</option>)}</select></label></div><div className="sw-list-status"><span className="sw-count">{visible.length} · {filter?t(filter):t('all')}</span><button onClick={refresh}>{t('refresh')}</button></div></div><div className="sw-list-items">
{loading&&<p className="sw-muted">{t('loading')}</p>}{!loading&&!visible.length&&<p className="sw-muted">{t('noRecords')}</p>}{visible.map(r=><button key={r.id} onClick={()=>openRecord(r.id)} aria-current={selected===r.id?'true':undefined} title={r.title||t('untitled')} className={'sw-row'+(selected===r.id?' selected':'')}><strong>{r.title||t('untitled')}</strong><small>{r.contentDay??t('unknown')}</small></button>)}</div></section><section className="sw-detail" ref={detailPane}>{!record&&!editing?<div className="sw-empty">◇<p>{t('choose')}</p></div>:<><div className="sw-detail-head"><span>{typeName(kind)}</span><div>{!editing&&<><button title={String(language).startsWith('zh')?'若未发送草稿已存在，将保留原草稿，引用可能无法自动加入。':'An existing unsent draft is preserved; the reference may not be inserted.'} onClick={()=>uiWorkspace.startSession(undefined,{prompt:String(language).startsWith('zh')?`请先读取拾文记录 ${record.id}，然后和我讨论这条内容（${record.title||'未命名'}）。`:`Please read Shiwen record ${record.id} and discuss it with me (${record.title||'Untitled'}).`,whenDraftExists:'keep'})}>{String(language).startsWith('zh')?'在对话中讨论':'Discuss in chat'}</button><button onClick={()=>{if(!confirmLeave())return;cursor.current=null;setEditing(true);setDirty(false);}}>{t('edit')}</button><button className="sw-danger" disabled={busy||loading} onClick={()=>{if(confirmLeave())setDeleteTarget(record);}}>{t('remove')}</button></>}{editing&&<><button disabled={busy} onClick={cancelEdit}>{writing?(String(language).startsWith('zh')?'返回文章':'Back to articles'):t('cancel')}</button>{writing&&<select className="sw-writing-stage" aria-label={t('stage')} value={stage} disabled={busy||Boolean(pendingImageSave)} onChange={e=>update(setStage,e.target.value)}><option value="draft">{t('draft')}</option><option value="final">{t('final')}</option></select>}{writing&&<button type="button" aria-expanded={sourcesOpen} onClick={()=>setSourcesOpen(v=>!v)}>{String(language).startsWith('zh')?'素材':'Materials'} · {sources.length}</button>}<button className="sw-primary" disabled={busy} onClick={save}>{busy?t('saving'):t('save')}</button></>}</div></div>{editing?<div className="sw-editor"><label className="sw-editor-title"><span>{t('title')}</span><input aria-label={t('title')} placeholder={writing?(String(language).startsWith('zh')?'输入文章标题':'Article title') : undefined} value={title} disabled={busy||Boolean(pendingImageSave)} onChange={e=>update(setTitle,e.target.value)}/></label>{!record&&section==='library'&&<label>{t('kind')}<select value={kind} onChange={e=>update(setKind,e.target.value)}>{['journal','freewrite','reading_note','idea','reference'].map(k=><option value={k} key={k}>{typeName(k)}</option>)}</select></label>}{kind==='article'&&<>{!writing&&<label>{t('stage')}<select value={stage} disabled={busy||Boolean(pendingImageSave)} onChange={e=>update(setStage,e.target.value)}><option value="draft">{t('draft')}</option><option value="final">{t('final')}</option></select></label>}<details className="sw-legacy-sources"><summary>{t('associated')} · {sources.length}</summary><div className="sw-source-list">{sources.filter(id=>!records.some(r=>r.id===id)).map(id=><label key={id}><input type="checkbox" checked onChange={()=>update(setSources,sources.filter(x=>x!==id))}/>{t('deletedSource')}</label>)}{records.filter(r=>r.kind!=='article'&&r.kind!=='ai_annotation').map(r=><label key={r.id}><input type="checkbox" checked={sources.includes(r.id)} onChange={e=>update(setSources,e.target.checked?[...sources,r.id]:sources.filter(x=>x!==r.id))}/>{r.title}</label>)}</div></details></>}<label className="sw-editor-body"><span>{t('body')} <small>Markdown</small></span><textarea aria-label={t('body')} placeholder={writing?(String(language).startsWith('zh')?'从这里开始写作…':'Start writing…'):undefined} ref={bodyInput} value={body} disabled={busy||Boolean(pendingImageSave)} onSelect={e=>{cursor.current=e.currentTarget.selectionEnd;}} onChange={e=>{cursor.current=e.target.selectionEnd;update(setBody,e.target.value);}} spellCheck="false"/></label><input ref={imageInput} type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden onChange={e=>insertImages([...e.target.files])}/><button type="button" className="sw-secondary" disabled={busy||Boolean(pendingImageSave)} onClick={()=>imageInput.current?.click()}>{String(language).startsWith('zh')?'插入图片':'Insert images'}</button></div>:<><h2 tabIndex={-1}>{title||t('untitled')}</h2><div className="sw-meta">{originName(record.origin)} · {typeName(record.kind)} · {record.contentDay??t('unknown')}</div>{record.url&&<p className="sw-meta">{record.url}</p>}{record.kind==='article'&&<ArticleCheck title={title} body={body} sourceIds={record.sourceIds} open={showCheck} onToggle={()=>setShowCheck(!showCheck)} zh={String(language).startsWith('zh')}/>}<MarkdownContent body={body} record={record}/>{record.kind==='reading_note'&&<ReadingNoteSources annotation={record.annotation} t={(a,b)=>String(language).startsWith('zh')?a:b}/>}<OriginCorrection key={'origin:'+record.id} record={record} rpc={rpc} newRequestId={newRequestId} zh={String(language).startsWith('zh')} disabled={annotationEditing||annotationActionPending} onPending={value=>{originPending.current=value;setOriginCorrectionPending(value);}} onCorrected={async()=>{const fresh=await rpc('readMarkdown',{id:record.id});setRecord(fresh);await refresh();}}/><Annotations key={record.id} disabled={originCorrectionPending} onEditState={(active,pending)=>{setAnnotationEditing(active);annotationPending.current=pending;setAnnotationActionPending(pending);}} original={record} rpc={rpc} MarkdownContent={MarkdownContent} newRequestId={newRequestId} zh={String(language).startsWith('zh')}/>{(record.importInfo||record.dateInfo)&&<details className="sw-details"><summary>{t('references')}</summary>{record.importInfo?.path&&<p>{record.importInfo.path}</p>}<label>{t('date')}<input type="date" value={day} onChange={e=>setDay(e.target.value)}/><button onClick={updateDate} disabled={busy}>{t('update')}</button></label></details>}{record.externalSources?.length>0&&<details className="sw-details"><summary>{String(language).startsWith('zh')?'外部保存与修改记录':'External activity'}</summary>{record.externalSources.map(source=><p key={source.id}>{source.client_name} · {externalActionName(source.action)} · {new Date(source.at).toLocaleString(String(language).startsWith('zh')?'zh-CN':'en-US')}<br/>{[source.session_id,source.message_id,source.file].filter(Boolean).join(' · ')}</p>)}</details>}{record.dshSources?.length>0&&<details className="sw-details"><summary>{t('sourceHistory')}</summary>{record.dshSources.map((s,i)=><p key={i}>{s.role} · {s.session_id} · {s.message_id}</p>)}</details>}{record.kind==='article'&&<details className="sw-details"><summary>{t('related')} · {record.sourceIds?.length??0}</summary>{record.sourceIds?.map(id=>{const r=records.find(item=>item.id===id);return <p key={id}>{r?.title??t('deletedSource')}</p>;})}</details>}</>}</>}</section>{section==='articles'&&editing&&<div className="sw-writing-sidebar" hidden={!sourcesOpen}><WritingSources records={records} selectedIds={sources} onChange={value=>update(setSources,value)} onQuote={quoteSource} onClose={()=>setSourcesOpen(false)} rpc={rpc} MarkdownContent={MarkdownContent} zh={String(language).startsWith('zh')} disabled={busy||Boolean(pendingImageSave)}/></div>}</div></main>;
}
function MemoryPanel({locale}){
 const language=useSyncExternalStore(callback=>locale.subscribe(callback),()=>locale.getSnapshot().active,()=>locale.getSnapshot().active);
 const zh=String(language).startsWith('zh'),tr=(a,b)=>zh?a:b;
 const [state,setState]=useState(null),[identity,setIdentity]=useState(''),[soul,setSoul]=useState(''),[draft,setDraft]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 async function load(){try{const value=await rpc('agentState');setState(value);setIdentity(value.identity.body);setSoul(value.soul.body);setError('');}catch(e){setError(e.message);}}
 useEffect(()=>{load();},[]);
 async function saveDocument(name,value){if(!state)return;setBusy(true);try{const doc=name==='IDENTITY.md'?state.identity:state.soul;await rpc('agentDocumentSave',{name,scope:'global',revision:doc.revision,body:value});await load();}catch(e){setError(e.message);}finally{setBusy(false);}}
 async function act(method,args){setBusy(true);try{await rpc(method,args);setDraft('');await load();}catch(e){setError(e.message);}finally{setBusy(false);}}
 return <main className="sw-view sw-memory"><div className="sw-head"><div><h1>{tr('Agent 与记忆','Agent and memory')}</h1></div><button onClick={load}>{tr('刷新','Refresh')}</button></div><p className="sw-sub">{tr('身份、交流方式和已确认的全局记忆会作为上下文；候选记忆须确认后才会使用。','Identity, style and confirmed global memories are included as context. Proposals require approval.')}</p>{error&&<div className="sw-error" role="alert">{error}</div>}{state&&<><section className="sw-memory-card"><h2>{tr('助手身份','Identity')}</h2><textarea aria-label={tr('助手身份','Identity')} value={identity} onChange={e=>setIdentity(e.target.value)}/><button className="sw-primary" disabled={busy} onClick={()=>saveDocument('IDENTITY.md',identity)}>{tr('保存身份','Save identity')}</button></section><section className="sw-memory-card"><h2>{tr('交流方式','Style')}</h2><textarea aria-label={tr('交流方式','Style')} value={soul} onChange={e=>setSoul(e.target.value)}/><button className="sw-primary" disabled={busy} onClick={()=>saveDocument('SOUL.md',soul)}>{tr('保存方式','Save style')}</button></section><section className="sw-memory-card"><h2>{tr('长期记忆','Long-term memory')}</h2><p className="sw-sub">{tr('只会注入已确认的全局记忆，内容按最近更新时间选取，上限 1800 字符。','Only confirmed global memories are included, newest first, up to 1,800 characters.')}</p><textarea value={draft} onChange={e=>setDraft(e.target.value)} placeholder={tr('添加一条长期偏好或背景','Add a preference or background fact')}/><button className="sw-primary" disabled={busy||!draft.trim()} onClick={()=>act('memorySave',{body:draft,scope:'global',category:'memory'})}>{tr('添加记忆','Add memory')}</button>{state.memories.map(m=><div className="sw-memory-row" key={m.id}><div><strong>{m.status==='pending'?tr('待确认','Pending'):tr('已确认','Confirmed')}</strong><p>{m.body}</p>{m.evidence&&<small>{tr('依据','Evidence')}: {m.evidence}</small>}</div>{m.status==='pending'?<><button disabled={busy} onClick={()=>act('memoryDecide',{id:m.id,revision:m.revision,accept:true})}>{tr('确认','Confirm')}</button><button disabled={busy} onClick={()=>act('memoryDecide',{id:m.id,revision:m.revision,accept:false})}>{tr('拒绝','Reject')}</button></>:<button disabled={busy} onClick={()=>act('memoryDelete',{id:m.id,revision:m.revision})}>{tr('停用','Disable')}</button>}</div>)}</section></>}</main>;
}
const Icon=({section})=><span aria-hidden="true" style={{fontSize:16,lineHeight:1}}>{section==='library'?'▤':section==='articles'?'◇':'◫'}</span>;
export const inject=['slots','locale','uiWorkspace','layout'];
export function apply(ctx){
 const Overview=()=> <HomeOverview rpc={rpc} locale={ctx.locale} layout={ctx.layout}/>;
 ctx.slots.inject('conversation.input.dock',()=>ctx.slots.register({name:'conversation.input.dock',id:'shiwen-home',order:80},Overview));
 const Navigation=()=> <MobileNav locale={ctx.locale} layout={ctx.layout}/>;
 ctx.slots.inject('shell.bottom',()=>ctx.slots.register({name:'shell.bottom'},Navigation));
 ctx.effect(()=>{const style=document.createElement('style');style.dataset.plugin='@shiwen/dsh-workbench';style.textContent=css;document.head.append(style);return()=>style.remove();});
 function SaveAssistant({messageId,save}){
  const [state,setState]=useState('idle');
  return <button type="button" className="sw-message-action" disabled={state==='busy'} title={state==='error'?'保存失败，请重试':'保存为素材'} onClick={async()=>{setState('busy');try{await save(messageId);setState('saved');}catch{setState('error');}}}>{state==='saved'?'已保存':state==='busy'?'保存中…':state==='error'?'保存失败':'保存素材'}</button>;
 }
 ctx.slots.inject('conversation.chat.assistant-actions',()=>ctx.slots.register({name:'conversation.chat.assistant-actions',id:'shiwen-save',order:20,inject:sessionId=>({save:messageId=>rpc('saveAssistantMessage',{sessionId,messageId})})},SaveAssistant));
 for(const [section,order] of [['library',10],['reading',15],['articles',20],['review',30]]){
  const key=`shiwen-${section}`;
  const Page=()=>{const language=useSyncExternalStore(fn=>ctx.locale.subscribe(fn),()=>ctx.locale.getSnapshot().active);const api=useMemo(()=>desktopReadingNotes(rpc),[]);return section==='reading'?<ReadingNotesPage api={api} t={(a,b)=>String(language).startsWith('zh')?a:b}/>:<Panel section={section} locale={ctx.locale} uiWorkspace={ctx.uiWorkspace}/>;};
  const Glyph=()=> section==='reading'?<BookIcon/>:<Icon section={section}/>;
  const label=()=>{const value=ctx.locale.getSnapshot().active;return (String(value).startsWith('zh')?dict.zh:dict.en)[section];};
  ctx.slots.inject('main',()=>ctx.slots.register({name:'main',key},Page));
  ctx.slots.inject('sidebar.panellist',()=>ctx.slots.register({name:'sidebar.panellist',id:key,order,label},Glyph));
 }
 const DataSettings=()=>{
  const language=useSyncExternalStore(callback=>ctx.locale.subscribe(callback),()=>ctx.locale.getSnapshot().active,()=>ctx.locale.getSnapshot().active);
  const t=k=>(String(language).startsWith('zh')?dict.zh:dict.en)[k]??k;
  return <><ImportSettings rpc={rpc} t={t}/><AccessSettings rpc={rpc} zh={String(language).startsWith('zh')}/></>;
 };
 ctx.slots.inject('settings.section',()=>ctx.slots.register({name:'settings.section',id:'shiwen-data',order:50,label:()=>String(ctx.locale.getSnapshot().active).startsWith('zh')?'拾文资料':'Shiwen data'},DataSettings));
 const Connections=()=> <ExternalPanel locale={ctx.locale} rpc={rpc}/>;
 const ConnectionIcon=()=> <span aria-hidden="true">⇄</span>;
 ctx.slots.inject('main',()=>ctx.slots.register({name:'main',key:'shiwen-external'},Connections));
 ctx.slots.inject('sidebar.panellist',()=>ctx.slots.register({name:'sidebar.panellist',id:'shiwen-external',order:45,label:()=>String(ctx.locale.getSnapshot().active).startsWith('zh')?'外部接入':'External access'},ConnectionIcon));
 const Memory=()=> <MemoryPanel locale={ctx.locale}/>;
 const MemoryIcon=()=> <span aria-hidden="true">◎</span>;
 const memoryLabel=()=>String(ctx.locale.getSnapshot().active).startsWith('zh')?'Agent 与记忆':'Agent and memory';
 ctx.slots.inject('main',()=>ctx.slots.register({name:'main',key:'shiwen-memory'},Memory));
 ctx.slots.inject('sidebar.panellist',()=>ctx.slots.register({name:'sidebar.panellist',id:'shiwen-memory',order:40,label:memoryLabel},MemoryIcon));
}
