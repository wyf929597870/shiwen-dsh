import {OverflowMenu} from './OverflowMenu.jsx';
import {DesktopBar} from './DesktopBar.jsx';
import {RecordWelcome} from './RecordWelcome.jsx';
import nightCss from './desktop-night.css';
import {GlobalSearch} from './GlobalSearch.jsx';
import {recordSection,sectionKinds} from '../../library/legacy/record-sections.mjs';
import {canvasPassage} from './canvas-passage.mjs';
import {RelationsBrowser} from './RelationsBrowser.jsx';
import {ThemesPage,AddToTheme,requestTheme} from './Themes.jsx';
import {RelatedArticles,requestArticle,requestRecord,subscribeArticleRequests,takeArticleRequest} from './RelatedArticles.jsx';
import {ReadingNotesPage,ReadingNoteSources} from './reading/ReadingNotesPage.jsx';
import {desktopReadingNotes} from './reading/adapters.mjs';
import readingCss from './reading/reading-notes.css';
import readingMobileCss from './reading/reading-notes-mobile.css';
import writingSourcesCss from './writing-sources.css';
import {insertSourceQuote} from './writing-source-helpers.mjs';
import {createDraftAutosave} from './draft-autosave.mjs';
import {IdeaCanvas} from './IdeaCanvas.jsx';
import canvasCss from './idea-canvas.css';
import {MaterialList} from './MaterialList.jsx';
import {useContentSearch,SearchControls,SearchResults,resolveSearchMatch,MatchContext,matchSource} from './ContentSearch.jsx';
import searchCss from './content-search.css';
import React,{useState,useEffect,useMemo,useSyncExternalStore,useRef} from 'react';
import {DiscussionTransfer} from './DiscussionTransfer.jsx';
import recCss from './recommendations.css';
import {ExplorationEntry} from './Exploration.jsx';
import {AssistEntry,WeeklyOpen} from './Recommendations.jsx';
import {HomeOverview} from './HomeOverview.jsx';
import {MobileNav} from './MobileNav.jsx';
import {ExternalPanel} from './ExternalPanel.jsx';
import {ImportSettings} from './ImportSettings.jsx';
import {DiscoverySettings} from './DiscoverySettings.jsx';
import {AccessSettings} from './AccessSettings.jsx';
import MarkdownIt from 'markdown-it';
import baseCss from './style.css';
import themePassagesCss from './theme-passages.css';
import desktopControlsCss from './desktop-workspace.css';
import goalsCss from './review-goals.css';
const css=baseCss+'\n'+themePassagesCss+'\n'+goalsCss+'\n'+readingCss+'\n'+readingMobileCss+'\n'+writingSourcesCss+'\n'+searchCss+'\n'+canvasCss+'\n'+desktopControlsCss+'\n'+nightCss+'\n'+recCss;
import {ReviewPage} from './ReviewPage.jsx';
import {ArticleReferences} from './ArticleReferences.jsx';
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
 zh:{libraryIntro:'让记录有处可寻，让写作有据可依。',articlesIntro:'把想法、记录与资料汇聚起来，继续你的创作。',hideList:'收起列表',showList:'展开列表',dataSettings:'拾文资料',serverPathHelp:'请输入运行服务的电脑上的资料库路径。',remove:'删除',confirmRemove:'确认删除',removePrompt:'删除这条记录？',removeHelp:'删除后不再出现在列表、搜索和助手的资料查询中；原始导入文件不受影响。可在当前页面撤销。',removed:'已删除',undo:'撤销删除',deletedSource:'已删除的素材',linkedWarning:'有关联文章使用此素材，文章正文和关联关系会保留。',library:'记录',collections:'收藏',global:'全局搜索',collectionsIntro:'收藏的网页、参考资料和 AI 讨论。',newCollection:'新建收藏',articles:'创作',review:'回顾',reading:'读书',all:'全部',journal:'日记',freewrite:'自由书写',reading_note:'读书笔记',idea:'想法',web:'网页',ai:'AI 讨论',reference:'参考资料',article:'文章',search:'搜索标题和正文',new:'新建',save:'保存',cancel:'取消',edit:'编辑',preview:'预览',write:'编辑正文',title:'标题',body:'正文',date:'内容日期',unknown:'日期待确认',source:'来源',draft:'草稿',revision:'修改中',final:'已定稿',stage:'状态',allTypes:'全部类型',allStages:'全部状态',associated:'关联素材',noRecords:'还没有内容',choose:'选择一条记录查看',loading:'正在加载…',saving:'正在保存…',error:'操作失败',saved:'已保存',today:'今日',days7:'近 7 天',days14:'近 14 天',days30:'近 30 天',month:'自然月',added:'个人新增字数',collected:'收集素材',personal:'个人记录',active:'活跃文章',history:'历史记录字数',undated:'日期待确认',references:'来源和日期',related:'关联素材',content:'可读正文',kind:'类型',saveDraft:'保存文章',filter:'筛选',back:'返回',newRecord:'新建记录',noSources:'暂无关联素材',noDetail:'这段时间没有记录',timeBasis:'个人新增字数按实际编辑时间统计；历史导入按内容日期展示。',unsaved:'正文尚有未保存的修改。',stay:'继续编辑',discard:'放弃修改',open:'打开',select:'选择',update:'更新',imported:'历史导入',originPersonal:'自己书写',originAI:'AI 内容',originExternal:'外部资料',originUnknown:'来源待确认',originTranslation:'译文',untitled:'未命名',sourceHistory:'对话来源',refresh:'刷新',importOld:'导入旧版资料',oldPath:'旧资料库文件路径',inspect:'预览',applyImport:'导入到空资料库',oldMessages:'历史消息',importDone:'导入完成。历史对话作为归档保留。',importHelp:'只读取旧资料库；目标资料库已有内容时不会覆盖。'},
 en:{libraryIntro:'A place for your notes, a foundation for your writing.',articlesIntro:'Bring your ideas and materials together. Keep writing.',hideList:'Hide list',showList:'Show list',dataSettings:'Shiwen data',serverPathHelp:'Enter a library path on the computer running this service.',remove:'Delete',confirmRemove:'Confirm deletion',removePrompt:'Delete this record?',removeHelp:'Removed from lists, search and assistant library queries. Original imported files remain unchanged. You can undo on this page.',removed:'Deleted',undo:'Undo deletion',deletedSource:'Deleted material',linkedWarning:'Articles reference this material. Their text and links will be preserved.',library:'Records',collections:'Collections',global:'Global search',collectionsIntro:'Saved pages, references and AI discussions.',newCollection:'New collection',articles:'Writing',review:'Review',reading:'Reading notes',all:'All',journal:'Journal',freewrite:'Freewriting',reading_note:'Reading notes',idea:'Idea',web:'Web',ai:'AI discussion',reference:'Reference',article:'Article',search:'Search titles and text',new:'New',save:'Save',cancel:'Cancel',edit:'Edit',preview:'Preview',write:'Edit text',title:'Title',body:'Content',date:'Content date',unknown:'Date unconfirmed',source:'Source',draft:'Draft',revision:'In revision',final:'Final',stage:'Status',allTypes:'All types',allStages:'All statuses',associated:'Related materials',noRecords:'No records yet',choose:'Select a record to read',loading:'Loading…',saving:'Saving…',error:'Action failed',saved:'Saved',today:'Today',days7:'Last 7 days',days14:'Last 14 days',days30:'Last 30 days',month:'Calendar month',added:'Personal characters added',collected:'Materials collected',personal:'Personal records',active:'Active articles',history:'Historical characters',undated:'Dates unconfirmed',references:'Source and date',related:'Related materials',content:'Reading view',kind:'Type',saveDraft:'Save article',filter:'Filter',back:'Back',newRecord:'New record',noSources:'No linked materials',noDetail:'No records in this period',timeBasis:'Personal additions use edit dates; imported history uses content dates.',unsaved:'You have unsaved edits.',stay:'Keep editing',discard:'Discard changes',open:'Open',select:'Select',update:'Update',imported:'Imported',originPersonal:'Personal',originAI:'AI content',originExternal:'External',originUnknown:'Unknown',originTranslation:'Translation',untitled:'Untitled',sourceHistory:'Conversation source',refresh:'Refresh',importOld:'Import previous library',oldPath:'Path to previous library',inspect:'Preview',applyImport:'Import into empty library',oldMessages:'Historical messages',importDone:'Import complete. Previous conversations remain archived.',importHelp:'The old library is read only. An existing destination is never overwritten.'}
};
async function rpc(method,args={}){
 const response=await fetch('/api/shiwen',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({method,args})});
 const data=await response.json();if(!response.ok){const error=new Error(data.error||'Request failed');error.httpStatus=response.status;error.code=data.code;throw error;}return data.result;
}
function markdownPayload(draft){
 const {id,revision,kind,title,body,stage,sources}=draft;
 return {id:id??undefined,revision:revision??undefined,kind,title,body,stage,sourceIds:kind==='article'?sources:undefined};
}
function pendingPayload(draft){
 if(draft.pendingImageSave)return draft.pendingImageSave;
 if(draft.createRequestId)return {...markdownPayload(draft),requestId:draft.createRequestId};
 return null;
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
function Panel({section,locale,uiWorkspace,layout}){
 const materialPage=section==='library'||section==='collections';
 const language=useSyncExternalStore(callback=>locale.subscribe(callback),()=>locale.getSnapshot().active,()=>locale.getSnapshot().active);
 const t=k=>(language==='zh'||String(language).startsWith('zh')?dict.zh:dict.en)[k]??k;
 const [draftReady,setDraftReady]=useState(false),[restoreAttempt,setRestoreAttempt]=useState(0);
 const [canvas,setCanvas]=useState(null);
 const [orphanDraft,setOrphanDraft]=useState(null);
 const [records,setRecords]=useState([]),[selected,setSelected]=useState(null),[record,setRecord]=useState(null),[filter,setFilter]=useState(''),[query,setQuery]=useState('');
 const [loading,setLoading]=useState(false),[error,setError]=useState(''),[busy,setBusy]=useState(false),[editing,setEditing]=useState(false),[dirty,setDirty]=useState(false),[title,setTitle]=useState(''),[body,setBody]=useState(''),[kind,setKind]=useState('freewrite'),[stage,setStage]=useState('draft'),[sources,setSources]=useState([]),[day,setDay]=useState('');
 const tr=(a,b)=>String(language).startsWith('zh')?a:b;
 const search=useContentSearch(rpc,section==='library'?'records':section,query,section==='articles'?{stage:filter||null}:{kind:filter||null},materialPage||section==='articles');
 const [searchMatch,setSearchMatch]=useState(null),[matchNotice,setMatchNotice]=useState('');const searchOpen=useRef(0);
 useEffect(()=>{searchOpen.current++;setSearchMatch(null);setMatchNotice('');},[query,filter,section,search.mode]);
 const [showCheck,setShowCheck]=useState(false),[annotationEditing,setAnnotationEditing]=useState(false);
 const annotationPending=useRef(false),originPending=useRef(false);
 const [originCorrectionPending,setOriginCorrectionPending]=useState(false),[annotationActionPending,setAnnotationActionPending]=useState(false);
 const [stagedImages,setStagedImages]=useState([]),[pendingSave,setPendingSave]=useState(null);
 const imageInput=useRef(null),bodyInput=useRef(null),cursor=useRef(null),materialText=useRef(null);
 const [sourcesOpen,setSourcesOpen]=useState(false);
 const articleView=section==='articles';
 const InfoContainer=articleView?'details':'div';
 const recordsById=useMemo(()=>new Map(records.map(row=>[row.id,row])),[records]);
 const [infoOpen,setInfoOpen]=useState(false),[draftStatus,setDraftStatus]=useState(''),[readFailed,setReadFailed]=useState(false);
 const draftGeneration=useRef(0),mounted=useRef(true);
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
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
 const [deleteTarget,setDeleteTarget]=useState(null),[deleted,setDeleted]=useState([]),[showRemoved,setShowRemoved]=useState(false),[removedRecords,setRemovedRecords]=useState([]);
 const listKey=`shiwen-list-collapsed:${section}`;
 const [listCollapsed,setListCollapsed]=useState(()=>{try{return localStorage.getItem(listKey)==='true';}catch{return false;}});
 useEffect(()=>{try{localStorage.setItem(listKey,String(listCollapsed));}catch{}},[listKey,listCollapsed]);
 const draftKey=`shiwen-editor-draft:${section}`;
 const autosave=useRef(null);
 const persistDraft=draft=>{autosave.current?.cancel();draftTouched.current=true;const revision=Math.max(draftRevision.current+1,Date.now()*1000);draftRevision.current=revision;const value=draft?{...draft,draftRevision:revision}:null;let localError;try{localStorage.setItem(draftKey,JSON.stringify(value??{draftRevision:revision,deleted:true}));}catch(e){localError=e;}const generation=draftGeneration.current;const task=draftQueue.current.catch(()=>{}).then(()=>rpc('workbenchDraft',{slot:section,value,revision})).then(result=>{if(localError)throw localError;return result;});draftQueue.current=task;task.then(()=>{if(value&&generation===draftGeneration.current)setDraftStatus('saved');},e=>{if(generation===draftGeneration.current)setDraftStatus('error');setError(`草稿同步失败：${e.message}`);});return task;};
 if(!autosave.current)autosave.current=createDraftAutosave(persistDraft,{onError:e=>setError(`草稿无法自动保存，请手动保存：${e.message}`)});
 useEffect(()=>{
  const flush=()=>autosave.current.flush();
  const hidden=()=>{if(document.visibilityState==='hidden')flush();};
  window.addEventListener('pagehide',flush);window.addEventListener('beforeunload',flush);window.addEventListener('blur',flush);document.addEventListener('visibilitychange',hidden);
  return()=>{flush();window.removeEventListener('pagehide',flush);window.removeEventListener('beforeunload',flush);window.removeEventListener('blur',flush);document.removeEventListener('visibilitychange',hidden);};
 },[]);

 async function refresh(){setLoading(true);setError('');try{const data=await rpc('snapshot');setRecords(data.records);}catch(e){setError(e.message);}finally{setLoading(false);}}
 useEffect(()=>{refresh();},[]);
 useEffect(()=>{
  let active=true;
  if(section==='review'){setDraftReady(true);return()=>{active=false;};}
  setDraftReady(false);let saved;try{saved=JSON.parse(localStorage.getItem(draftKey)||'null');}catch{}
  const restore=async()=>{
   try{
    let remote;
    try{remote=await rpc('workbenchDraft',{slot:section});}catch(e){if(!saved)throw e;}
    if(!active)return;
    if(remote?.revision>draftRevision.current)draftRevision.current=remote.revision;
    if(remote?.revision>(saved?.draftRevision??0)&&(saved?.draftRevision||remote.value))saved=remote.value;
    if(!saved||saved.deleted||draftTouched.current){setDraftReady(true);return;}
    draftRevision.current=Math.max(draftRevision.current,saved.draftRevision??0);
    const pending=pendingPayload(saved);
    if(!saved.id&&pending){
     // Inspect the receipt without issuing a new write when reopening the editor.
     let receipt,lookupError;
     try{receipt=await rpc('workbenchSaveReceipt',pending);}
     catch(e){lookupError=e.message;}
     if(!active)return;
     showDraft(saved,null);
     if(receipt){
      setBusy(true);
      await finishSave(saved,receipt,()=>active);
     }else{
      const retry=tr('尚未确认上次保存结果，请点击保存重试。','Save is unconfirmed. Select Save to retry.');
      setError(lookupError?retry+' '+lookupError:retry);
     }
     return;
    }
    let current=null;
    if(saved.id){
     try{current=await rpc('readMarkdown',{id:saved.id});}
     catch(e){
      if(e.code!=='RECORD_NOT_FOUND')throw e;
      if(active){setOrphanDraft(saved);setDraftReady('missing');}
      return;
     }
    }
    if(active&&!draftTouched.current)showDraft(saved,current);
   }catch(e){if(active){setError(e.message);setDraftReady('error');}}
  };
  void restore();return()=>{active=false;};
 },[restoreAttempt]);
 useEffect(()=>{const changed=()=>{void refresh();};window.addEventListener('shiwen-library-updated',changed);return()=>window.removeEventListener('shiwen-library-updated',changed);},[]);

 function showDraft(draft,current){
  setRecord(current?{...current,revision:draft.revision}:null);setSelected(draft.id??null);
  setTitle(draft.title);setBody(draft.body);setKind(draft.kind);setStage(draft.stage);
  setSources(draft.sources??[]);setStagedImages(draft.stagedImages??[]);
  setPendingSave(pendingPayload(draft));setEditing(true);setDirty(true);
  setDraftStatus('restored');setMobileDetail(true);setDraftReady(true);
 }
 async function resolveOrphan(keep){
  if(busy||!orphanDraft)return;
  if(!keep&&!window.confirm(tr('确定放弃这份草稿？','Discard this draft?')))return;
  setBusy(true);setError('');
  const draft=keep?{...orphanDraft,id:null,revision:null,pendingImageSave:null,createRequestId:null}:null;
  try{
   await persistDraft(draft);
   if(!mounted.current)return;
   if(keep)showDraft(draft,null);
   else{
    if(orphanDraft.stagedImages?.length)rpc('discardStagedImages',{ids:orphanDraft.stagedImages}).catch(()=>{});
    setDraftReady(true);
   }
   setOrphanDraft(null);
  }catch(e){setError(e.message);}
  finally{setBusy(false);}
 }

 const visible=useMemo(()=>records.filter(r=>recordSection(r.kind)===section).filter(r=>!filter||(section==='articles'?r.stage===filter:r.kind===filter)).filter(r=>!query||(`${r.title}\n${r.body}`).toLowerCase().includes(query.toLowerCase())),[records,section,filter,query]);
 function confirmLeave(){if(originPending.current){setError('来源更正结果待确认，请先重试');return false;}if(annotationPending.current){setError('标注保存结果待确认，请先重试保存');return false;}if(annotationEditing&&!window.confirm(String(language).startsWith('zh')?'标注草稿会保留，继续切换？':'Keep the annotation draft and continue?'))return false;if(pendingSave){setError('上次保存结果待确认，请先重试保存');return false;}return !dirty||window.confirm(t('unsaved')+' '+t('discard')+'?');}
 async function openRecord(id,item=null,requested=null){if(busy||draftReady!==true||!confirmLeave())return;const token=++searchOpen.current;persistDraft(null).then(()=>stagedImages.length&&rpc('discardStagedImages',{ids:stagedImages})).catch(()=>{});setStagedImages([]);setError('');setLoading(true);try{if(requested?.libraryId&&(await rpc('themeContext')).libraryId!==requested.libraryId)throw Error(tr('资料库已切换，请重新打开主题页','Library changed; reopen Themes'));if(requested?.libraryScope&&(await rpc('contentSearchStatus')).libraryScope!==requested.libraryScope)throw Error(tr('资料库已切换，请重新搜索','Library changed. Search again.'));
 const hit=requested?.item||item;
 const resolved=hit?await resolveSearchMatch(rpc,hit,requested?.request||search.request):null;const value=resolved?.record??await rpc('readMarkdown',{id});if(requested?.libraryId&&(await rpc('themeContext')).libraryId!==requested.libraryId)throw Error(tr('资料库已切换，请重新打开主题页','Library changed; reopen Themes'));if(requested?.libraryScope&&(await rpc('contentSearchStatus')).libraryScope!==requested.libraryScope)throw Error(tr('资料库已切换，请重新搜索','Library changed. Search again.'));
 if(token!==searchOpen.current)return;const target=requested?.match,source=target?matchSource(value,target):null,valid=target&&typeof source==='string'&&source.slice(target.anchor.start,target.anchor.end)===target.text;setSearchMatch(resolved?.match??(valid?target:null));setMatchNotice(resolved?.changed?tr('内容已变化，无法定位旧命中，请重新搜索。','Content changed; the old match could not be located. Search again.'):(requested?.unlocated||target&&!valid)?tr('原文已变化，无法定位片段；请对照片段快照阅读全文。','The source changed; compare the snapshot with the full text.'):'');setSelected(id);setRecord(value);setReadFailed(false);cursor.current=null;setTitle(value.title);setBody(value.markdown);setKind(value.kind);setStage(value.stage);setSources(value.sourceIds??[]);setDay(value.importInfo?.day??value.dateInfo?.day??'');setEditing(Boolean(requested?.edit&&value.kind==='article'));setDirty(false);setMobileDetail(true);setShowCheck(false);}catch(e){setError(e.message);}finally{setLoading(false);}}
 function create(){if(busy||draftReady!==true||!confirmLeave())return;searchOpen.current++;setLoading(false);setDraftStatus('');persistDraft(null).then(()=>stagedImages.length&&rpc('discardStagedImages',{ids:stagedImages})).catch(()=>{});setStagedImages([]);setSelected(null);setRecord(null);setReadFailed(false);setTitle('');setBody('');cursor.current=null;setKind(section==='articles'?'article':section==='collections'?'reference':'freewrite');setStage('draft');setSources([]);setDay('');setEditing(true);setDirty(false);setMobileDetail(true);setShowCheck(false);}
 async function save(){
  if(busy)return;
  setBusy(true);setError('');
  const draft={id:record?.id??null,revision:record?.revision??null,title,body,kind,stage,sources,stagedImages};
  let payload=pendingSave??markdownPayload(draft);
  if(!pendingSave){
   const references=imageReferences(body),imageIds=stagedImages.filter(id=>references.has(id));
   if(!draft.id||imageIds.length){
    payload={...payload,requestId:newRequestId()};
    if(imageIds.length){
     payload.imageIds=imageIds;
     draft.pendingImageSave=payload;
    }else draft.createRequestId=payload.requestId;
    // Persist the operation before sending it, even when the user leaves immediately.
    try{await persistDraft(draft);}
    catch(e){setBusy(false);setError(tr('保存前保留草稿失败：','Could not retain draft before saving: ')+e.message);return;}
    setPendingSave(payload);
   }
  }
  await submitSave(draft,payload,()=>mounted.current);
 }
 async function submitSave(draft,payload,isActive){
  let value;
  try{value=await rpc('saveMarkdown',payload);}
  catch(e){
   if(!isActive())return;
   if(e.httpStatus===400&&payload.requestId){
    // Application validation rejected the write. Allow correcting the draft.
    setPendingSave(null);
    const {pendingImageSave,createRequestId,...editable}=draft;
    try{await persistDraft(editable);}catch{}
   }
   setError(e.message);setBusy(false);return;
  }
  await finishSave(draft,value,isActive);
 }
 async function finishSave(draft,value,isActive){
  if(!isActive())return;
  setSelected(value.id);setRecord({...value,markdown:value.body??draft.body});setEditing(false);setDirty(false);setReadFailed(true);
  let cleanupError='';
  try{await persistDraft(null);}catch(e){cleanupError=`已保存，但草稿清理失败：${e.message}`;}
  if(draft.stagedImages?.length)rpc('discardStagedImages',{ids:draft.stagedImages}).catch(()=>{});
  setPendingSave(null);setStagedImages([]);
  try{
   await refresh();
   const fresh=await rpc('readMarkdown',{id:value.id});
   if(!isActive())return;
   setRecord(fresh);setReadFailed(false);setBody(fresh.markdown);setTitle(fresh.title);setSources(fresh.sourceIds??[]);
   if(section==='articles'&&desktop)setEditing(true);
   if(cleanupError)setError(cleanupError);
  }catch(e){if(isActive())setError(`记录已保存，但重新读取失败，请重试：${e.message}${cleanupError?'；'+cleanupError:''}`);}
  finally{if(isActive())setBusy(false);}
 }

 async function cancelEdit(){if(!confirmLeave()||busy)return;setBusy(true);try{await persistDraft(null);if(stagedImages.length)await rpc('discardStagedImages',{ids:stagedImages});setStagedImages([]);setEditing(false);setDirty(false);if(record){setTitle(record.title);setBody(record.markdown);setKind(record.kind);setStage(record.stage);setSources(record.sourceIds??[]);}else{setSelected(null);setMobileDetail(false);}}catch(e){setError(`草稿清理失败：${e.message}`);}finally{setBusy(false);}}
 async function insertImages(files){if(pendingSave||busy)return;setBusy(true);setError('');try{if(stagedImages.length+files.length>20)throw Error('每次最多添加 20 张图片');let next=body,ids=[...stagedImages],pos=bodyInput.current?.selectionStart??next.length;for(const file of files){if(file.size>8*1024*1024)throw Error('图片超过 8 MiB');const bytes=new Uint8Array(await file.arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=32768)binary+=String.fromCharCode(...bytes.subarray(i,i+32768));const image=await rpc('stageImage',{name:file.name,dataBase64:btoa(binary)});ids.push(image.id);const marker=`![图片](attachment:${image.id})`;next=next.slice(0,pos)+marker+next.slice(pos);pos+=marker.length;
   const queued=persistDraft({id:record?.id??null,revision:record?.revision??null,title,body:next,kind,stage,sources,stagedImages:ids});setStagedImages([...ids]);setBody(next);setDirty(true);await queued;}
  }catch(e){setError(e.message);}finally{setBusy(false);if(imageInput.current)imageInput.current.value='';}}
 async function removeRecord(){
  if(busy||!deleteTarget)return;
  setBusy(true);setError('');
  try{
   const receipt=await rpc('remove',{id:deleteTarget.id,revision:deleteTarget.revision});
   setDeleted(items=>[...items,{...receipt,title:deleteTarget.title}]);
   setSelected(null);setRecord(null);setEditing(false);setDirty(false);setDeleteTarget(null);setMobileDetail(false);
   setRecords(items=>items.filter(item=>item.id!==receipt.id));await refresh();
  }catch(e){setError(e.message);setDeleteTarget(null);}finally{setBusy(false);}
 }
 async function undoRemove(receipt){
  if(busy)return;setBusy(true);setError('');
  try{await rpc('restoreRemoved',{id:receipt.id,revision:receipt.revision});setDeleted(items=>items.filter(item=>item.id!==receipt.id));await refresh();}
  catch(e){setError(e.message);}finally{setBusy(false);}
 }
 async function toggleRemoved(){if(showRemoved){setShowRemoved(false);return;}setBusy(true);setError('');try{setRemovedRecords(await rpc('removedRecords'));setShowRemoved(true);}catch(e){setError(e.message);}finally{setBusy(false);}}
 async function restoreFromRemoved(item){if(busy)return;setBusy(true);setError('');try{await rpc('restoreRemoved',{id:item.id,revision:item.revision});setRemovedRecords(items=>items.filter(row=>row.id!==item.id));setDeleted(items=>items.filter(row=>row.id!==item.id));await refresh();window.dispatchEvent(new Event('shiwen-library-updated'));}catch(e){setError(e.message);}finally{setBusy(false);}}
 async function updateDate(){if(!record)return;setBusy(true);setError('');try{await rpc('updateRecord',{id:record.id,revision:record.revision,day:day||null});await refresh();const value=await rpc('readMarkdown',{id:record.id});setRecord(value);}catch(e){setError(e.message);}finally{setBusy(false);}}
 const update=(setter,value)=>{if(busy)return;if(pendingSave){setError('上次保存结果待确认，请先重试保存');return;}const draft={id:record?.id??null,revision:record?.revision??null,title,body,kind,stage,sources,stagedImages};
  if(setter===setTitle)draft.title=value;else if(setter===setBody)draft.body=value;else if(setter===setKind)draft.kind=value;else if(setter===setStage)draft.stage=value;else if(setter===setSources)draft.sources=value;
  draftTouched.current=true;draftGeneration.current++;setDraftStatus('pending');autosave.current.schedule(draft);setError('');
  setter(value);setDirty(true);
 };
 function quoteSource(source,text){
  if(busy||pendingSave||!text)return;
  const result=insertSourceQuote(body,cursor.current,sources,source,text);
  const draft={id:record?.id??null,revision:record?.revision??null,title,body:result.body,kind,stage,sources:result.sources,stagedImages};
  try{persistDraft(draft);setError('');}catch{setError('草稿无法自动保存，请手动保存。');}
  setBody(result.body);setSources(result.sources);setDirty(true);cursor.current=result.cursor;
  requestAnimationFrame(()=>{bodyInput.current?.focus();bodyInput.current?.setSelectionRange(cursor.current,cursor.current);});
 }
 const openRecordRef=useRef(openRecord);openRecordRef.current=openRecord;
 useEffect(()=>{if(!['articles','library','collections'].includes(section)||draftReady!==true)return;const receive=()=>{const request=takeArticleRequest(section);if(request)void openRecordRef.current(typeof request==='string'?request:request.id,null,typeof request==='string'?null:request);};const unsubscribe=subscribeArticleRequests(receive,section);receive();return unsubscribe;},[section,draftReady]);

 const typeName=k=>t(k==='reference'?'reference':k);
 const externalActionName=action=>({shiwen_save:['保存','Saved'],shiwen_collect:['收藏','Collected'],shiwen_update:['修改','Updated'],shiwen_delete:['删除','Deleted'],shiwen_restore:['恢复','Restored']})[action]?.[String(language).startsWith('zh')?0:1]??(String(language).startsWith('zh')?'操作':'Activity');
 const originName=o=>t(({personal:'originPersonal',ai:'originAI',external:'originExternal',translation:'originTranslation'})[o]??'originUnknown');
 if(section==='review')return <ReviewPage rpc={rpc} language={language} md={md} typeName={typeName}/>;
 return <main className={"sw-view sw-library-view"+(listCollapsed?" sw-list-collapsed":"")+(mobileDetail?" sw-mobile-detail":"")+(editing?" sw-editing":"")+(writing?" sw-writing-mode":"")+(writing&&sourcesOpen?" sw-writing-open":"")+(materialPage?" sw-record-workspace":"")}>{canvas&&desktop&&materialPage&&<IdeaCanvas backLabel={section==='collections'?tr('返回收藏','Back to collections'):tr('返回记录','Back to records')} root={canvas.record} libraryScope={canvas.libraryScope} search={search} rpc={rpc} t={tr} MarkdownContent={MarkdownContent} newRequestId={newRequestId} onOpenArticle={(id,libraryId)=>{setCanvas(null);requestRecord(id,layout,'articles',{libraryId});}} onClose={()=>setCanvas(null)}/>}{deleteTarget&&<DeleteConfirmation target={deleteTarget} linked={records.filter(r=>r.kind==='article'&&r.sourceIds?.includes(deleteTarget.id)).length} busy={busy} t={t} onCancel={()=>setDeleteTarget(null)} onConfirm={removeRecord}/>}<div className="sw-head"><button className="sw-mobile-back" onClick={()=>setMobileDetail(false)}>← {t('back')}</button><div className="sw-panel-heading"><h1>{t(section)}</h1><p className="sw-sub">{t(section==='articles'?'articlesIntro':section==='collections'?'collectionsIntro':'libraryIntro')}</p></div><div className="sw-head-actions">{desktop&&section==='articles'&&<AssistEntry scene="writing" rpc={rpc} layout={layout}/>} {editing&&!mobileDetail&&<button className="sw-mobile-resume" onClick={()=>setMobileDetail(true)}>{t('stay')}</button>}{materialPage&&desktop?<OverflowMenu className="sw-list-menu" label={tr('列表选项','List options')}><button type="button" onClick={refresh}>{t('refresh')}</button><button className="sw-list-toggle" aria-expanded={!listCollapsed} aria-controls={`sw-record-list-${section}`} onClick={()=>setListCollapsed(value=>!value)}>{t(listCollapsed?'showList':'hideList')}</button><button disabled={busy} onClick={toggleRemoved} aria-expanded={showRemoved}>{showRemoved?(String(language).startsWith('zh')?'隐藏已删除':'Hide deleted'):(String(language).startsWith('zh')?'已删除':'Recently deleted')}</button></OverflowMenu>:<><button className="sw-list-toggle" aria-expanded={!listCollapsed} aria-controls={`sw-record-list-${section}`} onClick={()=>setListCollapsed(value=>!value)}>{t(listCollapsed?'showList':'hideList')}</button><button disabled={busy} onClick={toggleRemoved} aria-expanded={showRemoved}>{showRemoved?(String(language).startsWith('zh')?'隐藏已删除':'Hide deleted'):(String(language).startsWith('zh')?'已删除':'Recently deleted')}</button></>}<button className="sw-primary" disabled={busy||draftReady!==true} onClick={create}>＋ {materialPage&&desktop?t(section==='collections'?'newCollection':'newRecord'):t('new')}</button></div></div>{orphanDraft&&<div className="sw-notice" role="alert">
  <span>{tr('草稿的原记录已不存在。','The original record for this draft is missing.')} {orphanDraft.title}</span>
  <button disabled={busy} onClick={()=>resolveOrphan(true)}>{tr('转为新草稿','Keep as a new draft')}</button>
  <button disabled={busy} onClick={()=>resolveOrphan(false)}>{tr('放弃草稿','Discard draft')}</button>
 </div>}{(error||draftReady==='error')&&<div className="sw-error" role="alert">{error||tr('草稿读取失败，请重试','Could not load the draft. Please retry.')}{draftReady==='error'&&<button type="button" onClick={()=>{setError('');setDraftReady(false);setRestoreAttempt(v=>v+1);}}>{tr('重试读取草稿','Retry loading draft')}</button>}</div>}{deleted.length>0&&<div className="sw-notice sw-undo" role="status">{deleted.map(item=><div key={item.id}><span>{t('removed')}: {item.title||t('untitled')}</span><button disabled={busy} onClick={()=>undoRemove(item)}>{t('undo')}</button></div>)}</div>}{showRemoved&&<section className="sw-notice sw-removed-list" aria-label={String(language).startsWith('zh')?'已删除记录':'Deleted records'}><h2>{String(language).startsWith('zh')?'已删除记录':'Deleted records'}</h2>{removedRecords.length?removedRecords.map(item=><div key={item.id}><span>{item.title||t('untitled')} · {typeName(item.kind)} · {item.contentDay||t('unknown')}</span><button disabled={busy} onClick={()=>restoreFromRemoved(item)}>{String(language).startsWith('zh')?'恢复':'Restore'}</button></div>):<p>{String(language).startsWith('zh')?'没有已删除的记录':'No deleted records'}</p>}</section>}<div className="sw-columns"><section className="sw-list" id={`sw-record-list-${section}`} ref={listPane} aria-label={t(section)} inert={busy||draftReady!==true?true:undefined}>
 <div className="sw-list-controls"><div className="sw-toolbar">{materialPage&&<ExplorationEntry rpc={rpc} layout={layout}/>}<div className="sw-search-line"><input type="search" aria-label={t('search')} value={query} placeholder={t('search')} onChange={e=>setQuery(e.target.value)} onCompositionStart={()=>search.setComposing(true)} onCompositionEnd={e=>{setQuery(e.currentTarget.value);search.setComposing(false);}}/>{materialPage&&desktop?<details className="sw-search-disclosure"><summary>{search.mode==='exact'?tr('原文','Exact'):tr('语义','Semantic')}</summary><SearchControls search={search} t={tr}/></details>:<SearchControls search={search} t={tr}/>}</div><div className="sw-filter-line"><label className="sw-filter"><span>{t(materialPage?'kind':'stage')}</span><select aria-label={t(materialPage?'kind':'stage')} value={filter} onChange={e=>setFilter(e.target.value)}><option value="">{t(materialPage?'allTypes':'allStages')}</option>{(materialPage?sectionKinds[section]:['idea','draft','revision','final']).map(k=><option key={k} value={k}>{t(k)}</option>)}</select></label><div className="sw-list-status"><span className="sw-count">{query.trim()?(search.result?.total??0):visible.length} · {filter?t(filter):t('all')}</span>{!(materialPage&&desktop)&&<button onClick={refresh}>{t('refresh')}</button>}</div></div></div></div>{query.trim()?<SearchResults search={search} t={tr} onOpen={item=>openRecord(item.recordId,item)}/>:<MaterialList rowHeight={desktop?68:undefined} records={visible} selected={selected} onOpen={openRecordRef} loading={loading} loadingLabel={t('loading')} emptyLabel={t('noRecords')} untitled={t('untitled')} unknown={t('unknown')}/>}</section><section className={"sw-detail"+(!editing&&record?" sw-reading-record":"")} ref={detailPane}>{!record&&!editing?(desktop&&materialPage?<RecordWelcome t={tr} disabled={busy||draftReady!==true} isCollection={section==='collections'} onCreate={create} onSearch={()=>{const field=document.querySelector('.sw-bar-search input');if(field?.getClientRects().length)field.focus();else layout.selectPanel('shiwen-global');}} onReview={()=>layout.selectPanel('shiwen-review')}/>:<div className="sw-empty">◇<p>{t('choose')}</p></div>):<><div className="sw-detail-head"><span>{articleView?t(stage):typeName(kind)}</span><div>{!editing&&<>{readFailed&&<button disabled={busy} onClick={()=>openRecord(record.id)}>{tr('重新读取','Reload')}</button>}{desktop&&['idea','journal','freewrite'].includes(record.kind)&&!readFailed&&<><AssistEntry key={'reading'+record.id} scene="reading" rpc={rpc} layout={layout} record={record} selectionRoot={materialText}/>{record.kind==='idea'&&<AssistEntry key={'experience'+record.id} scene="experience" rpc={rpc} layout={layout} record={record} selectionRoot={materialText}/>}</>}{materialPage&&desktop&&<button type="button" disabled={busy||loading||readFailed} onMouseDown={e=>e.preventDefault()} onClick={()=>setCanvas({record:{...record,canvasText:canvasPassage(materialText.current)||searchMatch?.text||record.markdown},libraryScope:search.status?.libraryScope})}>{tr('在画布中展开','Open in canvas')}</button>}{materialPage&&desktop&&<button type="button" aria-expanded={infoOpen} onClick={()=>setInfoOpen(v=>!v)}>{tr('信息','Info')}</button>}{materialPage&&desktop?<><button className={desktop?"sw-primary":""} disabled={busy||readFailed} onClick={()=>{if(!confirmLeave())return;cursor.current=null;setEditing(true);setDirty(false);setDraftStatus('');}}>{t('edit')}</button><OverflowMenu className="sw-record-menu" label={tr('更多操作','More actions')}><button className={materialPage&&desktop?'sw-record-discuss':''} title={String(language).startsWith('zh')?'若未发送草稿已存在，将保留原草稿，引用可能无法自动加入。':'An existing unsent draft is preserved; the reference may not be inserted.'} onClick={()=>uiWorkspace.startSession(undefined,{prompt:String(language).startsWith('zh')?`请先读取拾文记录 ${record.id}，然后和我讨论这条内容（${record.title||'未命名'}）。`:`Please read Shiwen record ${record.id} and discuss it with me (${record.title||'Untitled'}).`,whenDraftExists:'keep'})}>{String(language).startsWith('zh')?'在对话中讨论':'Discuss in chat'}</button><button className="sw-danger" disabled={busy||loading} onClick={()=>{if(confirmLeave())setDeleteTarget(record);}}>{t('remove')}</button></OverflowMenu></>:<><button className={materialPage&&desktop?'sw-record-discuss':''} title={String(language).startsWith('zh')?'若未发送草稿已存在，将保留原草稿，引用可能无法自动加入。':'An existing unsent draft is preserved; the reference may not be inserted.'} onClick={()=>uiWorkspace.startSession(undefined,{prompt:String(language).startsWith('zh')?`请先读取拾文记录 ${record.id}，然后和我讨论这条内容（${record.title||'未命名'}）。`:`Please read Shiwen record ${record.id} and discuss it with me (${record.title||'Untitled'}).`,whenDraftExists:'keep'})}>{String(language).startsWith('zh')?'在对话中讨论':'Discuss in chat'}</button><button className={desktop?"sw-primary":""} disabled={busy||readFailed} onClick={()=>{if(!confirmLeave())return;cursor.current=null;setEditing(true);setDirty(false);setDraftStatus('');}}>{t('edit')}</button><button className="sw-danger" disabled={busy||loading} onClick={()=>{if(confirmLeave())setDeleteTarget(record);}}>{t('remove')}</button></>}</>}{editing&&<>{materialPage&&desktop&&draftStatus&&<span className="sw-draft-status" role="status">{draftStatus==='saved'?tr('草稿已保留','Draft retained'):draftStatus==='restored'?tr('草稿已恢复','Draft restored'):draftStatus==='pending'?tr('正在保留草稿…','Keeping draft…'):tr('草稿保留失败','Draft could not be retained')}</span>}<button disabled={busy} onClick={cancelEdit}>{writing?(String(language).startsWith('zh')?'返回文章':'Back to articles'):t('cancel')}</button>{writing&&<select className="sw-writing-stage" aria-label={t('stage')} value={stage} disabled={busy||Boolean(pendingSave)} onChange={e=>update(setStage,e.target.value)}><option value="draft">{t('draft')}</option><option value="final">{t('final')}</option></select>}{writing&&<button type="button" aria-expanded={sourcesOpen} onClick={()=>setSourcesOpen(v=>!v)}>{String(language).startsWith('zh')?'素材':'Materials'} · {sources.length}</button>}<button className="sw-primary" disabled={busy} onClick={save}>{busy?t('saving'):t('save')}</button></>}</div></div>{editing?<div className="sw-editor" onKeyDown={event=>{if(materialPage&&desktop&&(event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='s'&&!event.nativeEvent.isComposing&&!event.repeat){event.preventDefault();if(!busy)void save();}}} onBlur={event=>{if(!event.currentTarget.contains(event.relatedTarget))autosave.current.flush();}}><label className="sw-editor-title"><span>{t('title')}</span><input aria-label={t('title')} placeholder={writing?(String(language).startsWith('zh')?'输入文章标题':'Article title') : undefined} value={title} disabled={busy||Boolean(pendingSave)} onChange={e=>update(setTitle,e.target.value)}/></label>{materialPage&&desktop&&record&&<div className="sw-editor-meta">{record.contentDay??t('unknown')} · {originName(record.origin)}</div>}{!record&&materialPage&&<label>{t('kind')}<select value={kind} disabled={busy||Boolean(pendingSave)} onChange={e=>update(setKind,e.target.value)}>{(sectionKinds[section].includes(kind)?sectionKinds[section]:[...sectionKinds[section],kind]).map(k=><option value={k} key={k}>{typeName(k)}</option>)}</select></label>}{kind==='article'&&<>{!writing&&<label>{t('stage')}<select value={stage} disabled={busy||Boolean(pendingSave)} onChange={e=>update(setStage,e.target.value)}><option value="draft">{t('draft')}</option><option value="final">{t('final')}</option></select></label>}<details className="sw-legacy-sources"><summary>{t('associated')} · {sources.length}</summary><div className="sw-source-list">{sources.filter(id=>!records.some(r=>r.id===id)).map(id=><label key={id}><input type="checkbox" checked onChange={()=>update(setSources,sources.filter(x=>x!==id))}/>{t('deletedSource')}</label>)}{records.filter(r=>r.kind!=='article'&&r.kind!=='ai_annotation').map(r=><label key={r.id}><input type="checkbox" checked={sources.includes(r.id)} onChange={e=>update(setSources,e.target.checked?[...sources,r.id]:sources.filter(x=>x!==r.id))}/>{r.title}</label>)}</div></details></>}<label className="sw-editor-body"><span>{t('body')} <small>Markdown</small></span><textarea aria-label={t('body')} placeholder={writing?(String(language).startsWith('zh')?'从这里开始写作…':'Start writing…'):undefined} ref={bodyInput} value={body} disabled={busy||Boolean(pendingSave)} onSelect={e=>{cursor.current=e.currentTarget.selectionEnd;}} onChange={e=>{cursor.current=e.target.selectionEnd;update(setBody,e.target.value);}} spellCheck="false"/></label><input ref={imageInput} type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden onChange={e=>insertImages([...e.target.files])}/><button type="button" className="sw-secondary" disabled={busy||Boolean(pendingSave)} onClick={()=>imageInput.current?.click()}>{String(language).startsWith('zh')?'插入图片':'Insert images'}</button>{materialPage&&desktop&&<span className="sw-save-shortcut">{tr('Ctrl / ⌘ + S 保存','Ctrl / ⌘ + S to save')}</span>}</div>:<><h2 tabIndex={-1}>{title||t('untitled')}</h2>{!articleView&&<><div className="sw-meta">{materialPage&&desktop?<>{record.contentDay??t('unknown')} · {originName(record.origin)}</>:<>{originName(record.origin)} · {typeName(record.kind)} · {record.contentDay??t('unknown')}</>}</div>{record.url&&<p className="sw-meta">{record.url}</p>}</>}{matchNotice&&<p role="status">{matchNotice}</p>}{searchMatch&&<MatchContext record={record} match={searchMatch} t={tr} query={search.mode==='exact'?query:''}/>}{record&&<ExplorationEntry rpc={rpc} layout={layout} recordId={record.id} revision={record.revision} sourceLibraryId={record.sourceLibraryId} label="这篇记录的待探索"/>}<div ref={materialText}><MarkdownContent body={body} record={record}/></div>{articleView&&<ArticleReferences ids={record.sourceIds} recordsById={recordsById} loading={loading} t={tr} onOpen={row=>{if(confirmLeave())requestRecord(row.id,layout,recordSection(row.kind),{libraryId:record.sourceLibraryId});}}/>}
 <InfoContainer key={record.id} className={articleView?'sw-article-tools':'sw-record-info'} hidden={materialPage&&desktop&&!infoOpen}>{articleView&&<summary>{tr('文章工具','Article tools')}</summary>}{record.kind==='article'&&<ArticleCheck title={title} body={body} sourceIds={record.sourceIds} open={showCheck} onToggle={()=>setShowCheck(!showCheck)} zh={String(language).startsWith('zh')}/>}{record.kind!=='article'&&<AddToTheme rpc={rpc} t={tr} sourceRecordId={record.id} sourceRevision={record.revision} sourceLibraryId={record.sourceLibraryId} field={record.kind==='reading_note'?'reflection':'body'} selectionRoot={materialText} sourceText={body} fragment={searchMatch&&['body','reflection'].includes(searchMatch.field)?{quote:searchMatch.text,start:searchMatch.anchor.start,end:searchMatch.anchor.end}:null}/>} <RelationsBrowser key={'relations:'+record.id} record={record} rpc={rpc} t={tr} onOpenRecord={(id,kind,libraryId)=>{if(confirmLeave())requestRecord(id,layout,recordSection(kind),{libraryId});}} onOpenTheme={(id,libraryId)=>{if(confirmLeave())requestTheme(id,libraryId,layout);}}/>{record.kind!=='article'&&<RelatedArticles id={record.id} rpc={rpc} t={tr} onOpen={id=>{if(confirmLeave())requestArticle(id,layout);}}/>}{record.kind==='reading_note'&&<ReadingNoteSources annotation={record.annotation} t={(a,b)=>String(language).startsWith('zh')?a:b}/>}<OriginCorrection key={'origin:'+record.id} record={record} rpc={rpc} newRequestId={newRequestId} zh={String(language).startsWith('zh')} disabled={annotationEditing||annotationActionPending} onPending={value=>{originPending.current=value;setOriginCorrectionPending(value);}} onCorrected={async()=>{const fresh=await rpc('readMarkdown',{id:record.id});setRecord(fresh);await refresh();}}/><Annotations key={record.id} disabled={originCorrectionPending} onEditState={(active,pending)=>{setAnnotationEditing(active);annotationPending.current=pending;setAnnotationActionPending(pending);}} original={record} rpc={rpc} MarkdownContent={MarkdownContent} newRequestId={newRequestId} zh={String(language).startsWith('zh')}/>{(record.importInfo||record.dateInfo)&&<details className="sw-details"><summary>{t('references')}</summary>{record.importInfo?.path&&<p>{record.importInfo.path}</p>}<label>{t('date')}<input type="date" value={day} onChange={e=>setDay(e.target.value)}/><button onClick={updateDate} disabled={busy}>{t('update')}</button></label></details>}{record.externalSources?.length>0&&<details className="sw-details"><summary>{String(language).startsWith('zh')?'外部保存与修改记录':'External activity'}</summary>{record.externalSources.map(source=><p key={source.id}>{source.client_name} · {externalActionName(source.action)} · {new Date(source.at).toLocaleString(String(language).startsWith('zh')?'zh-CN':'en-US')}<br/>{[source.session_id,source.message_id,source.file].filter(Boolean).join(' · ')}</p>)}</details>}{record.dshSources?.length>0&&<details className="sw-details"><summary>{t('sourceHistory')}</summary>{record.dshSources.map((s,i)=><p key={i}>{s.role} · {s.session_id} · {s.message_id}</p>)}</details>}</InfoContainer></>}</>}</section>{section==='articles'&&editing&&<div className="sw-writing-sidebar" hidden={!sourcesOpen}><WritingSources records={records} selectedIds={sources} onChange={value=>update(setSources,value)} onQuote={quoteSource} onClose={()=>setSourcesOpen(false)} rpc={rpc} MarkdownContent={MarkdownContent} zh={String(language).startsWith('zh')} disabled={busy||Boolean(pendingSave)}/></div>}</div></main>;
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
// Match the host's regular-weight navigation icons and its expanded/rail sizing.
const sidebarSymbols={
  global:'search-outline', library:'flat-list-outline', articles:'edit-outline',
  review:'gauge-outline', memory:'goal-outline', external:'link-outline'
};
const sidebarOutlines={
  reading:'M13.5 2H4.8A2.3 2.3 0 0 0 2.5 4.3v7.4A2.3 2.3 0 0 0 4.8 14h8.7V2Zm0 9H4.8a2.3 2.3 0 0 0-2.3 2M5.5 5h5',
  collections:'m8 1.6 2 4.1 4.5.7-3.3 3.2.8 4.5-4-2.2-4 2.2.8-4.5-3.3-3.2 4.5-.7Z',
  themes:'m8 1.8 6.4 3.4L8 8.6 1.6 5.2 8 1.8ZM1.6 8.2 8 11.6l6.4-3.4M1.6 11.2 8 14.6l6.4-3.4'
};
function SidebarIcon({section,size=16}){
  const symbol=sidebarSymbols[section];
  if(symbol)return <svg width={size} height={size} aria-hidden="true"><use href={`#dsw-icon-${symbol}-regular`}/></svg>;
  return <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor"
    strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={sidebarOutlines[section]}/></svg>;
}
export const inject=['slots','locale','uiWorkspace','layout'];
export function apply(ctx){
 const Overview=({inputActions})=> <><DiscussionTransfer rpc={rpc} inputActions={inputActions}/><HomeOverview composer={inputActions} rpc={rpc} locale={ctx.locale} layout={ctx.layout}/></>;
 ctx.slots.inject('shiwen.home.overview',()=>ctx.slots.register({name:'shiwen.home.overview'},Overview));
 ctx.slots.inject('conversation.input.dock',()=>ctx.slots.register({name:'conversation.input.dock',id:'shiwen-home',order:80},Overview));
 const Navigation=()=> <><WeeklyOpen rpc={rpc}/><DesktopBar rpc={rpc} locale={ctx.locale} layout={ctx.layout}/><MobileNav locale={ctx.locale} layout={ctx.layout}/></>;
 ctx.slots.inject('shell.bottom',()=>ctx.slots.register({name:'shell.bottom'},Navigation));
 ctx.effect(()=>{const style=document.createElement('style');style.dataset.plugin='@shiwen/dsh-workbench';style.textContent=css;document.head.append(style);return()=>style.remove();});
 function SaveAssistant({messageId,save}){
  const [state,setState]=useState('idle');
  return <button type="button" className="sw-message-action" disabled={state==='busy'} title={state==='error'?'保存失败，请重试':'保存为素材'} onClick={async()=>{setState('busy');try{await save(messageId);setState('saved');}catch{setState('error');}}}>{state==='saved'?'已保存':state==='busy'?'保存中…':state==='error'?'保存失败':'保存素材'}</button>;
 }
 ctx.slots.inject('conversation.chat.assistant-actions',()=>ctx.slots.register({name:'conversation.chat.assistant-actions',id:'shiwen-save',order:20,inject:sessionId=>({save:messageId=>rpc('saveAssistantMessage',{sessionId,messageId})})},SaveAssistant));
 for(const [section,order] of [['global',5],['library',10],['reading',15],['collections',18],['articles',20],['themes',25],['review',30]]){
  const key=`shiwen-${section}`;
  const Page=()=>{
   const language=useSyncExternalStore(fn=>ctx.locale.subscribe(fn),()=>ctx.locale.getSnapshot().active);
   const api=useMemo(()=>desktopReadingNotes(rpc),[]);
   const tr=(a,b)=>String(language).startsWith('zh')?a:b;
   const openSource=(id,options)=>requestRecord(id,ctx.layout,recordSection(options.kind)||'library',options);
   if(section==='global')return <GlobalSearch rpc={rpc} layout={ctx.layout} t={tr}/>;
   if(section==='themes')return <ThemesPage rpc={rpc} t={tr} onOpenSource={openSource}/>;
   if(section==='reading')return <ReadingNotesPage api={api} renderExploration={r=><ExplorationEntry rpc={rpc} layout={ctx.layout} recordId={r.id} revision={r.revision} sourceLibraryId={r.sourceLibraryId}/>} relatedRpc={rpc} t={tr}
    onOpenArticle={id=>requestArticle(id,ctx.layout)} onOpenRecord={(id,kind,libraryId)=>openSource(id,{kind,libraryId})}
    onOpenTheme={(id,libraryId)=>requestTheme(id,libraryId,ctx.layout)}
    renderCanvas={(root,search,onClose)=><IdeaCanvas root={root} backLabel={tr('返回读书','Back to reading')}
     libraryScope={search.status?.libraryScope} search={search} rpc={rpc} t={tr} MarkdownContent={MarkdownContent} newRequestId={newRequestId}
     onOpenArticle={(id,libraryId)=>{onClose();openSource(id,{kind:'article',libraryId});}} onClose={onClose}/>}/>;
   return <Panel section={section} locale={ctx.locale} uiWorkspace={ctx.uiWorkspace} layout={ctx.layout}/>;
  };
  const Glyph=({size})=> <SidebarIcon section={section} size={size}/>;
  const label=()=>{const value=ctx.locale.getSnapshot().active;return section==='themes'?(String(value).startsWith('zh')?'主题':'Themes'):(String(value).startsWith('zh')?dict.zh:dict.en)[section];};
  ctx.slots.inject('main',()=>ctx.slots.register({name:'main',key},Page));
  if(section!=='global')ctx.slots.inject('sidebar.panellist',()=>ctx.slots.register({name:'sidebar.panellist',id:key,order,label},Glyph));
 }
 const DataSettings=()=>{
  const language=useSyncExternalStore(callback=>ctx.locale.subscribe(callback),()=>ctx.locale.getSnapshot().active,()=>ctx.locale.getSnapshot().active);
  const t=k=>(String(language).startsWith('zh')?dict.zh:dict.en)[k]??k;
  return <><ImportSettings rpc={rpc} t={t}/><AccessSettings rpc={rpc} zh={String(language).startsWith('zh')}/></>;
 };
 ctx.slots.inject('settings.section',()=>ctx.slots.register({name:'settings.section',id:'shiwen-data',order:50,label:()=>String(ctx.locale.getSnapshot().active).startsWith('zh')?'拾文资料':'Shiwen data'},DataSettings));
 const ExplorationSettingsPage=()=>{
  const language=useSyncExternalStore(callback=>ctx.locale.subscribe(callback),()=>ctx.locale.getSnapshot().active);
  return <section className="sw-view"><DiscoverySettings rpc={rpc} t={(zh,en)=>String(language).startsWith('zh')?zh:en}/></section>;
 };
 ctx.slots.inject('settings.section',()=>ctx.slots.register({name:'settings.section',id:'shiwen-exploration',order:51,label:()=>String(ctx.locale.getSnapshot().active).startsWith('zh')?'待探索':'Exploration'},ExplorationSettingsPage));
 const Connections=()=> <ExternalPanel locale={ctx.locale} rpc={rpc}/>;
 const ConnectionIcon=({size})=> <SidebarIcon section="external" size={size}/>;
 ctx.slots.inject('main',()=>ctx.slots.register({name:'main',key:'shiwen-external'},Connections));
 ctx.slots.inject('sidebar.panellist',()=>ctx.slots.register({name:'sidebar.panellist',id:'shiwen-external',order:45,label:()=>String(ctx.locale.getSnapshot().active).startsWith('zh')?'外部接入':'External access'},ConnectionIcon));
 const Memory=()=> <MemoryPanel locale={ctx.locale}/>;
 const MemoryIcon=({size})=> <SidebarIcon section="memory" size={size}/>;
 const memoryLabel=()=>String(ctx.locale.getSnapshot().active).startsWith('zh')?'Agent 与记忆':'Agent and memory';
 ctx.slots.inject('main',()=>ctx.slots.register({name:'main',key:'shiwen-memory'},Memory));
 ctx.slots.inject('sidebar.panellist',()=>ctx.slots.register({name:'sidebar.panellist',id:'shiwen-memory',order:40,label:memoryLabel},MemoryIcon));
}
