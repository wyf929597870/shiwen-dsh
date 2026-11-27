import {MoreRows,usePullRefresh} from '../ListInteractions.jsx';
import {RelationsBrowser} from '../RelationsBrowser.jsx';
import {AddToTheme} from '../Themes.jsx';
import {canvasPassage} from '../canvas-passage.mjs';
import {RelatedArticles,subscribeArticleRequests,takeArticleRequest} from '../RelatedArticles.jsx';
import {useContentSearch,SearchControls,SearchResults,resolveSearchMatch,MatchContext,matchSource} from '../ContentSearch.jsx';
import React,{useEffect,useLayoutEffect,useMemo,useRef,useState} from 'react';
import MarkdownIt from 'markdown-it';
import {count} from '../../../library/legacy/content.mjs';
import {decodeReadingNote,readingNoteDraft,validateReadingNote} from '../../../library/legacy/reading-note.mjs';
import {bookIcon} from './book-icon.mjs';
import {readingCards} from './cards.mjs';
import {readingPageSelection,readingSavedSelection} from './navigation.mjs';
const markdown=new MarkdownIt({html:false,linkify:false,breaks:true});
markdown.renderer.rules.text=(tokens,index,options,env)=>{const text=tokens[index].content,needle=(env.query||'').trim();if(!needle)return markdown.utils.escapeHtml(text);const parts=text.split(new RegExp(`(${needle.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')})`,'gi'));return parts.map(part=>part.toLocaleLowerCase()===needle.toLocaleLowerCase()?`<mark>${markdown.utils.escapeHtml(part)}</mark>`:markdown.utils.escapeHtml(part)).join('');};
const today=()=>{const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;};
const fresh=book=>({book,day:today(),noteType:'excerpt',reflection:'',chapter:'',page:'',excerpts:[]});
const newId=()=>crypto.randomUUID();
const noop=()=>{};
const natural=new Intl.Collator('zh-CN',{numeric:true});
const chapterKey=value=>String(value||'').replace(/第([零〇一二两三四五六七八九十百千]+)(?=[章节卷部篇回])/g,(_,number)=>{const digits={零:0,〇:0,一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9},units={十:10,百:100,千:1000};let result=0,digit=0;for(const c of number){if(c in digits)digit=digits[c];else{result+=(digit||1)*units[c];digit=0;}}return `第${result+digit}`;});
const compareChapter=(a,b)=>!a&&!b?0:!a?1:!b?-1:natural.compare(chapterKey(a),chapterKey(b));
const matchSnippet=(text,query)=>{const value=String(text||''),needle=query.trim(),at=needle?value.toLocaleLowerCase().indexOf(needle.toLocaleLowerCase()):-1;if(at<0)return '';const start=Math.max(0,at-45),end=Math.min(value.length,at+needle.length+45);return `${start?'…':''}${value.slice(start,end)}${end<value.length?'…':''}`;};
export function BookIcon(){return <img className="rn-book-icon" src={bookIcon} alt="" aria-hidden="true"/>;}
export function ReadingNoteSources({annotation,t=(a)=>a}){
 const value=decodeReadingNote(annotation);if(!value)return <p className="rn-muted">{t('备注需在素材页核对','Check this note’s metadata in Materials')}</p>;
 if(!value.excerpts.length&&!value.chapter&&!value.page)return null;
 return <div className="rn-sources">{(value.chapter||value.page)&&<p className="rn-muted">{[value.chapter,value.page&&`${t('页码','Page')} ${value.page}`].filter(Boolean).join(' · ')}</p>}{value.excerpts.length>0&&<><p className="rn-muted">{t('原文摘录 · 不计入感想字数','Book excerpts · excluded from reflection counts')}</p>{value.excerpts.map((x,i)=><blockquote key={i}><p>{x.text}</p>{x.page&&<cite>{t('页码','Page')} {x.page}</cite>}</blockquote>)}</>}</div>;
}
export function ReadingNotesPage({continuous=false,api,t=(a)=>a,onPageStateChange=noop,relatedRpc,onOpenArticle,onOpenRecord,onOpenTheme,renderCanvas,renderExploration,canvasActionLabel,sourceLibraryId}){
 const [canvas,setCanvas]=useState(null),[arrival,setArrival]=useState(null);
 const [records,setRecords]=useState([]),[form,setForm]=useState(()=>fresh('')),[ready,setReady]=useState(false),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[dirty,setDirty]=useState(false),[pending,setPending]=useState(null),[error,setError]=useState(''),[notice,setNotice]=useState(''),[quotesOpen,setQuotesOpen]=useState(false),[expanded,setExpanded]=useState(''),[bookQuery,setBookQuery]=useState(''),[newBook,setNewBook]=useState('');
 const [editorOpen,setEditorOpen]=useState(false),[query,setQuery]=useState(''),[scope,setScope]=useState('book'),[typeFilter,setTypeFilter]=useState('all'),[dateFrom,setDateFrom]=useState(''),[dateTo,setDateTo]=useState(''),[chapterFilter,setChapterFilter]=useState('all'),[page,setPage]=useState(1),[progress,setProgress]=useState(null),[pendingDelete,setPendingDelete]=useState(null),[sort,setSort]=useState('chapter'),[selected,setSelected]=useState(''),[mode,setMode]=useState('list'),[mobile,setMobile]=useState(()=>window.matchMedia('(max-width: 760px)').matches);
 const search=useContentSearch(api.searchRpc,'reading',query,{book:scope==='book'?form.book||null:null,chapter:chapterFilter==='all'?null:chapterFilter,noteType:typeFilter==='all'?null:typeFilter,start:dateFrom||null,end:dateTo||null},Boolean(api.searchRpc));
 const [searchMatch,setSearchMatch]=useState(null),[matchNotice,setMatchNotice]=useState('');const searchOpen=useRef(0);
 useEffect(()=>{searchOpen.current++;setSearchMatch(null);setMatchNotice('');},[query,scope,form.book,chapterFilter,typeFilter,dateFrom,dateTo,search.mode]);
 const excerptRoot=useRef(null),reflectionRoot=useRef(null);
 const dialog=useRef(null),draftKey=useRef(''),alive=useRef(true),formRef=useRef(form),listController=useRef(null),editorRef=useRef(null),returnFocus=useRef(null),pageRef=useRef(null),mainRef=useRef(null),listScroll=useRef(null);
 useEffect(()=>{const media=window.matchMedia('(max-width: 760px)'),change=()=>setMobile(media.matches);media.addEventListener('change',change);return()=>media.removeEventListener('change',change);},[]);
 useEffect(()=>{if(editorOpen){returnFocus.current=document.activeElement;const timer=setTimeout(()=>editorRef.current?.querySelector('textarea:not(:disabled), button:not(:disabled)')?.focus({preventScroll:true}),0);return()=>{clearTimeout(timer);returnFocus.current?.focus?.({preventScroll:true});};}},[editorOpen]);
 const blocked=busy||Boolean(pending)||Boolean(pendingDelete);
 const books=useMemo(()=>[...new Set([...records.map(r=>r.title),form.book].filter(Boolean))].sort((a,b)=>a.localeCompare(b,'zh-CN')),[records,form.book]);
 const types={excerpt:t('摘录','Excerpt'),reflection:t('思考','Reflection'),question:t('疑问','Question')};
 const getData=record=>decodeReadingNote(record.annotation)||{};
 const chapters=useMemo(()=>[...new Set(records.filter(r=>scope==='all'||r.title===form.book).map(r=>getData(r).chapter).filter(Boolean))].sort(compareChapter),[records,scope,form.book]);
 const matches=(r,selectedBook=form.book)=>{
  const data=getData(r), text=[r.title,r.markdown,data.chapter,...(r.cardId?[r.excerpt?.text||'']:(data.excerpts||[]).map(x=>x.text))].join(' ').toLocaleLowerCase();
  return (scope==='all'||r.title===selectedBook)&&(!query.trim()||text.includes(query.trim().toLocaleLowerCase()))&&(typeFilter==='all'||(data.noteType||'reflection')===typeFilter)&&(chapterFilter==='all'||(data.chapter||'')===chapterFilter)&&(!dateFrom||(r.contentDay||'')>=dateFrom)&&(!dateTo||(r.contentDay||'')<=dateTo);
 };
 const byDate=(a,b)=>{const result=(a.contentDay??'').localeCompare(b.contentDay??'')||(a.createdAt??a.created??'').localeCompare(b.createdAt??b.created??'')||a.id.localeCompare(b.id);return sort==='latest'?-result:result;};
 const order=(a,b)=>sort==='chapter'?(natural.compare(a.title||'',b.title||'')||compareChapter(getData(a).chapter,getData(b).chapter)||byDate(a,b)):byDate(a,b);
 const filtered=useMemo(()=>readingCards(records).filter(r=>matches(r)).sort(order),[records,scope,form.book,query,typeFilter,chapterFilter,dateFrom,dateTo,sort,mobile]);
 const pages=Math.max(1,Math.ceil(filtered.length/20)), currentPage=Math.min(page,pages), entries=filtered.slice(continuous?0:(currentPage-1)*20,currentPage*20);
 const groupKey=record=>JSON.stringify([record.title||'',getData(record).chapter||'']);
 const counts=new Map();filtered.forEach(record=>counts.set(groupKey(record),(counts.get(groupKey(record))||0)+1));
 const groups=entries.reduce((all,record)=>{const key=groupKey(record),chapter=getData(record).chapter||t('未标注章节','No chapter');let group=sort==='chapter'?all[all.length-1]:null;if(!group||group.key!==key){group={key,book:record.title,chapter,total:counts.get(key),records:[]};all.push(group);}group.records.push(record);return all;},[]);
 const active=(api.searchRpc&&query.trim()?readingCards(records).find(r=>r.cardId===selected):null)||filtered.find(r=>r.cardId===selected)||filtered[0]||null;
 const scrollContainer=()=>{let node=pageRef.current?.parentElement;while(node){const style=getComputedStyle(node);if(/auto|scroll/.test(style.overflowY))return node;node=node.parentElement;}return document.scrollingElement;};
 const openSearchResult=async item=>{const token=++searchOpen.current;try{const resolved=await resolveSearchMatch(api.searchRpc,item,search.request);if(token!==searchOpen.current)return;const card=readingCards([resolved.record]).find(row=>row.cardId===item.cardId);if(!card){setMatchNotice(t('笔记卡片已变化，请重新搜索。','The note card changed; search again.'));return;}if(!selectCard(card,true))return;setRecords(rows=>rows.some(row=>row.id===resolved.record.id)?rows.map(row=>row.id===resolved.record.id?resolved.record:row):[...rows,resolved.record]);setSearchMatch(resolved.match);setMatchNotice(resolved.changed?t('内容已变化，无法定位旧命中，请重新搜索。','Content changed; search again to locate the match.'):'');}catch(e){setMatchNotice(e.message);}};
 const selectCard=(record,fromSearch=false)=>{if(!fromSearch){searchOpen.current++;setSearchMatch(null);setMatchNotice('');}if(editorOpen){if(!leaveDraft())return;setEditorOpen(false);replaceForm(fresh(form.book));}if(mobile){const element=scrollContainer();listScroll.current=element?{element,top:element.scrollTop}:null;}setSelected(record.cardId);setMode('detail');return true;};
 const changePage=next=>{if(editorOpen){if(!leaveDraft())return;setEditorOpen(false);replaceForm(fresh(form.book));setMode('detail');}const selection=readingPageSelection(filtered,next);setPage(selection.page);setSelected(selection.cardId);};
 const closeEditor=()=>{setEditorOpen(false);setMode(active?'detail':'list');};
 useLayoutEffect(()=>{if(!mobile||mode!=='list'||!listScroll.current)return;const saved=listScroll.current;let second;const first=requestAnimationFrame(()=>{second=requestAnimationFrame(()=>{if(listScroll.current===saved){saved.element.scrollTop=saved.top;listScroll.current=null;}});});return()=>{cancelAnimationFrame(first);if(second)cancelAnimationFrame(second);};},[mobile,mode]);
 useLayoutEffect(()=>{if(editorOpen||mode!=='detail')return;const element=mobile?scrollContainer():mainRef.current;if(element)element.scrollTop=0;},[selected,mode,mobile,editorOpen]);
 const moveCard=offset=>{const index=filtered.findIndex(r=>r.cardId===active?.cardId),next=filtered[index+offset];if(next){setSelected(next.cardId);setPage(Math.floor((index+offset)/20)+1);}};
 const highlight=text=>{const value=String(text||''),needle=api.searchRpc&&search.mode==='semantic'?'':query.trim();if(!needle)return value;const parts=value.split(new RegExp(`(${needle.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')})`,'gi'));return parts.map((part,i)=>part.toLocaleLowerCase()===needle.toLocaleLowerCase()?<mark key={i}>{part}</mark>:part);};
 useEffect(()=>setPage(1),[scope,form.book,query,typeFilter,chapterFilter,dateFrom,dateTo,sort,mobile]);
 const storeDraft=(next,isDirty,nextPending)=>{
  if(!draftKey.current)throw Error(t('资料库尚未就绪','Library is not ready'));
  localStorage.setItem(draftKey.current,JSON.stringify({form:next,dirty:isDirty,pending:nextPending}));
 };
 useEffect(()=>{
  alive.current=true;let live=true;const controller=new AbortController();listController.current=controller;
  api.list({signal:controller.signal,onProgress:value=>{if(live){setProgress(value);setRecords(value.records);}}}).then(data=>{
   if(!live)return;setRecords(data.records);draftKey.current=`shiwen-reading-notes:${location.origin}:${data.scope}`;
   let saved;try{saved=JSON.parse(localStorage.getItem(draftKey.current)||'null');}catch{setError(t('无法恢复本机草稿，请勿清除浏览器资料','Could not restore the local draft'));}
   const next=saved?.form&&typeof saved.form.book==='string'&&typeof saved.form.reflection==='string'&&Array.isArray(saved.form.excerpts)?saved.form:fresh(data.records[0]?.title??'');
   try{setPendingDelete(JSON.parse(localStorage.getItem(draftKey.current+':delete')||'null'));}catch{setError(t('无法恢复删除状态，请勿清除浏览器资料','Could not restore delete state'));}
   formRef.current=next;setForm(next);setDirty(Boolean(saved?.dirty));setPending(saved?.pending??null);setEditorOpen(Boolean(saved?.dirty||saved?.pending));setQuotesOpen(true);setReady(true);
   if(saved?.dirty)setNotice(t('已恢复未保存草稿','Unsaved draft restored'));
  }).catch(e=>{if(live)setError(e.message);}).finally(()=>{if(live)setLoading(false);});
  return()=>{live=false;alive.current=false;listController.current?.abort();};
 },[api]);
 useEffect(()=>{onPageStateChange({dirty,busy:blocked,depth:mobile?(editorOpen?2:mode==='detail'?1:0):0,onBack:()=>{if(editorOpen)closeEditor();else setMode('list');}});return()=>onPageStateChange({dirty:false,busy:false,depth:0});},[dirty,blocked,mobile,mode,editorOpen,active?.cardId,onPageStateChange]);
 useEffect(()=>{const warn=e=>{if(dirty||blocked){e.preventDefault();e.returnValue='';}};window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn);},[dirty,blocked]);
 const replaceForm=(next,isDirty=false,nextPending=null)=>{formRef.current=next;setForm(next);setDirty(isDirty);setPending(nextPending);try{storeDraft(next,isDirty,nextPending);}catch(e){setError(t('本机草稿未能保存：','Could not save local draft: ')+e.message);}};
 const edit=patch=>{setNotice('');replaceForm({...formRef.current,...patch},true);};
 const leaveDraft=()=>!blocked&&(!dirty||window.confirm(t('放弃当前未保存的修改？','Discard the current unsaved changes?')));
 const receiveRef=useRef(null);
 receiveRef.current=async request=>{
  if(!request||!leaveDraft())return;
  const token=++searchOpen.current;
  try{
   const checkScope=async()=>{
    if(request.libraryScope&&(await relatedRpc('contentSearchStatus')).libraryScope!==request.libraryScope)throw Error(t('资料库已切换，请重新搜索','Library changed. Search again.'));
   };
   await checkScope();
   const result=request.item?await resolveSearchMatch(relatedRpc,request.item,request.request):{record:await relatedRpc('readMarkdown',{id:request.id}),match:request.match};
   await checkScope();
   if(!alive.current||token!==searchOpen.current)return;
   const record=result.record;
   if(request.libraryId&&record.sourceLibraryId!==request.libraryId)throw Error(t('资料库已切换，请重新打开原文','Library changed. Reopen the source.'));
   const match=result.match,field=match&&matchSource(record,match);
   const located=typeof field==='string'&&field.slice(match.anchor.start,match.anchor.end)===match.text;
   const cards=readingCards([record]);
   const card=cards.find(row=>row.cardId===request.item?.cardId)||cards[located&&match.field==='excerpt'?match.anchor.excerptIndex:0]||cards[0];
   if(record.kind!=='reading_note'||!card)throw Error(t('笔记已变化，请重新打开','The note changed. Reopen it.'));
   setRecords(rows=>[...rows.filter(row=>row.id!==record.id),record]);
   setEditorOpen(false);replaceForm(fresh(record.title));setScope('book');setQuery('');setTypeFilter('all');setChapterFilter('all');setDateFrom('');setDateTo('');
   setSelected(card.cardId);setMode('detail');setError('');
   setArrival({cardId:card.cardId,match:located?match:null,changed:result.changed||request.unlocated||Boolean(match&&!located)});
  }catch(e){if(alive.current&&token===searchOpen.current)setError(e.message);}
 };
 useEffect(()=>{
  if(!ready||!relatedRpc)return;
  const receive=()=>{const request=takeArticleRequest('reading');if(request)void receiveRef.current(request);};
  const unsubscribe=subscribeArticleRequests(receive,'reading');receive();return unsubscribe;
 },[ready,relatedRpc]);
 useEffect(()=>{
  if(!arrival)return;
  const index=filtered.findIndex(card=>card.cardId===arrival.cardId);
  if(index>=0)setPage(Math.floor(index/20)+1);
  setSearchMatch(arrival.match);setMatchNotice(arrival.changed?t('原文已变化，已打开当前笔记。','The source changed. Showing the current note.'):'');setArrival(null);
 },[arrival,filtered]);
 const selectBook=book=>{if(editorOpen){if(blocked)return;edit({book});}else{if(!leaveDraft())return;replaceForm(fresh(book));}setError('');setNotice('');setExpanded('');setChapterFilter('all');setQuotesOpen(true);if(dialog.current?.open)dialog.current.close();};
 const openBooks=()=>{setBookQuery('');setNewBook('');dialog.current.showModal();};
 const choose=value=>value===':new'?openBooks():selectBook(value);
 const startEdit=record=>{
  if((dirty||pending)&&formRef.current.id===record.id){setEditorOpen(true);setMode('editor');return;}
  if(!leaveDraft())return;
  try{const next=readingNoteDraft(record);replaceForm(next);setQuotesOpen(true);setEditorOpen(true);setMode('editor');setError('');setNotice(t('正在编辑已保存的笔记','Editing a saved note'));}catch(e){setError(e.message);}
 };
 async function refresh(){
  if(blocked)return;listController.current?.abort();const controller=new AbortController();listController.current=controller;setLoading(true);setError('');try{const data=await api.list({signal:controller.signal,onProgress:value=>{if(alive.current&&!controller.signal.aborted)setProgress(value);}});if(alive.current&&!controller.signal.aborted)setRecords(data.records);}catch(e){if(alive.current&&!controller.signal.aborted)setError(e.message);}finally{if(alive.current&&!controller.signal.aborted)setLoading(false);}
 }
 const refreshRef=usePullRefresh(refresh,continuous&&mode==='list'&&!editorOpen&&!blocked&&!loading&&!(api.searchRpc&&query.trim()));
 async function save(){
  if(busy||!ready)return;setError('');setNotice('');let operation=pending,sent=false;
  try{
   if(!operation){if(!formRef.current.id&&!formRef.current.excerpts.some(x=>x.text.trim()))throw Error(t('请先填写一条划线','Enter a highlight first'));validateReadingNote(formRef.current);operation={input:structuredClone(formRef.current),requestId:newId(),recordId:formRef.current.id??newId(),generation:Date.now()};}
   storeDraft(operation.input,true,operation);setPending(operation);setBusy(true);
   sent=true;const record=await api.save(operation);if(!alive.current)return;
   const next=fresh(operation.input.book);replaceForm(next);setQuotesOpen(false);setExpanded(`${record.id}:0`);
   closeEditor();setNotice(t('笔记已保存','Note saved'));window.dispatchEvent(new Event('shiwen-library-updated'));
   try{listController.current?.abort();const controller=new AbortController();listController.current=controller;const data=await api.list({signal:controller.signal});if(alive.current&&!controller.signal.aborted){setRecords(data.records);const sorted=readingCards(data.records).filter(r=>matches(r,operation.input.book)).sort(order),selection=readingSavedSelection(sorted,record.id,selected);if(!selection){setMode('list');setNotice(t('笔记已保存，但当前筛选条件将其隐藏。','Note saved, but hidden by the current filters.'));}else{setSelected(selection.cardId);setPage(selection.page);setMode('detail');}}}catch(e){if(alive.current)setError(t('笔记已保存，列表刷新失败，请刷新列表。','Note saved, but the list could not refresh.'));}
  }catch(e){
   if(!alive.current)return;const message=String(e.message||e);
   if(!sent||/已被更新|REVISION_CONFLICT|不存在|NOT_FOUND|格式|过长|请选择|请先|长度|最多|请求编号|VALIDATION/.test(message)){setPending(null);try{storeDraft(formRef.current,true,null);}catch{};setError(message);}
   else setError(t('保存结果待核对，草稿已保留。请点击“再次核对保存”。','Save result uncertain. Draft retained; choose “Verify save again”.')+' '+message);
  }finally{if(alive.current)setBusy(false);}
 }
 const deleteCard=async(record,retry=false)=>{
  if(busy||pending||(!retry&&pendingDelete))return;
  if(!retry&&(!record||(record.sharedReflection&&!renderCanvas)||!window.confirm(record.sharedReflection?t('将整条读书笔记及其全部划线移入回收站？','Move the entire note and all its highlights to the trash?'):t('将这张划线卡片移入回收站？','Move this highlight card to the trash?'))))return;
  const action=retry?pendingDelete:{id:record.id,revision:record.revision,requestId:newId()};if(!action)return;
  try{localStorage.setItem(draftKey.current+':delete',JSON.stringify(action));}catch(e){setError(t('无法保存删除状态，请重试：','Could not preserve delete state: ')+e.message);return;}
  setPendingDelete(action);setBusy(true);setError('');
  try{await api.remove(action);localStorage.removeItem(draftKey.current+':delete');setPendingDelete(null);setNotice(t('已移入回收站','Moved to trash'));window.dispatchEvent(new Event('shiwen-library-updated'));try{const data=await api.list();if(alive.current)setRecords(data.records);}catch{if(alive.current)setError(t('已删除，但列表刷新失败，请刷新列表。','Deleted, but the list could not refresh.'));}}
  catch(e){const message=String(e.message||e);if(/内容已变更|版本无效|REVISION_CONFLICT/.test(message)){localStorage.removeItem(draftKey.current+':delete');setPendingDelete(null);setError(t('笔记已变更，请刷新后再删除。','Note changed; refresh before deleting.'));}else setError(t('删除结果待核对，请点击“再次核对删除”。','Delete result uncertain; select “Verify delete again”.')+' '+message);}
  finally{if(alive.current)setBusy(false);}
 };
 const updateExcerpt=(i,patch)=>edit({excerpts:form.excerpts.map((x,n)=>i===n?{...x,...patch}:x)});
 const FilterPanel=continuous?'details':React.Fragment;
 const DateFilters=continuous?'div':'details';
 const filterCount=[chapterFilter!=='all',typeFilter!=='all',Boolean(dateFrom),Boolean(dateTo),sort!=='chapter',search.mode==='semantic'].filter(Boolean).length;
 return <section ref={pageRef} className={`rn-page rn-mode-${editorOpen?'editor':mode}`} aria-label={t('读书笔记','Reading notes')}>
  <header className="rn-heading"><h1>{t('读书笔记','Reading notes')}</h1>{ready&&<label className="rn-book-select"><BookIcon/><span className="rn-sr">{t('书名','Book')}</span><select aria-label={t('书名','Book')} value={form.book} disabled={blocked} onChange={e=>choose(e.target.value)}>{!form.book&&<option value="">{t('选择或添加一本书','Choose or add a book')}</option>}{books.map(book=><option key={book} value={book}>{book}</option>)}<option value=":new">{t('添加一本书…','Add a book…')}</option></select></label>}<button className="rn-new" disabled={!ready||busy} onClick={()=>{if(!dirty&&!pending){replaceForm(fresh(form.book));setQuotesOpen(true);}setEditorOpen(true);setMode('editor');}}>＋ {t('新建笔记','New note')}</button></header>
  {!ready&&<p role={error?'alert':'status'}>{error||(progress?t(`正在读取笔记… ${progress.loaded} / ${progress.total}`,`Loading notes… ${progress.loaded} / ${progress.total}`):t('正在读取笔记…','Loading notes…'))}{!loading&&<button onClick={()=>location.reload()}>{t('重试','Retry')}</button>}</p>}
  {ready&&!editorOpen&&<div className="rn-status" aria-live="polite">{pendingDelete&&<p className="rn-error" role="status">{t('删除结果待核对。','Delete result needs verification.')} <button disabled={busy} onClick={()=>deleteCard(null,true)}>{t('再次核对删除','Verify delete again')}</button></p>}{notice&&<p className="rn-notice" role="status">{notice}</p>}{error&&<p className="rn-error" role="alert">{error}</p>}</div>}
  {ready&&<div className="rn-layout"><aside className="rn-sidebar">
   <div className="rn-toolbar"><div className="rn-search"><input aria-label={t('搜索笔记','Search notes')} placeholder={t('搜索正文、想法、章节','Search text, thoughts, chapters')} value={query} onChange={e=>setQuery(e.target.value)} onCompositionStart={()=>search.setComposing(true)} onCompositionEnd={e=>{setQuery(e.currentTarget.value);search.setComposing(false);}}/><select aria-label={t('搜索范围','Search scope')} value={scope} onChange={e=>{setScope(e.target.value);setChapterFilter('all');}}><option value="book">{t('本书','This book')}</option><option value="all">{t('全部书','All books')}</option></select></div>
   <FilterPanel {...(continuous?{className:'rn-phone-filters'}:{})}>
   {continuous&&<summary>{t('筛选','Filters')}{filterCount>0&&' · '+filterCount}</summary>}
   {continuous&&<div className="rn-history-actions"><span>{filtered.length} {t('条笔记','notes')}</span><button disabled={blocked||loading} onClick={refresh}>{loading?t('刷新中…','Refreshing…'):t('刷新列表','Refresh list')}</button></div>}
   {api.searchRpc&&<SearchControls search={search} t={t}/>}<label className="rn-chapter-filter">{t('章节','Chapter')}<select aria-label={t('章节筛选','Filter by chapter')} value={chapterFilter} onChange={e=>setChapterFilter(e.target.value)}><option value="all">{t('全部章节','All chapters')}</option>{chapters.map(chapter=><option key={chapter}>{chapter}</option>)}</select></label>
   <div className="rn-toolbar-options"><label className="rn-sort"><span className="rn-sr">{t('排序','Sort order')}</span><select aria-label={t('排序','Sort order')} value={sort} onChange={e=>setSort(e.target.value)}><option value="chapter">{t('按章节','By chapter')}</option><option value="latest">{t('最新优先','Newest first')}</option><option value="earliest">{t('最早优先','Oldest first')}</option></select></label><DateFilters className={continuous?'rn-phone-dates':'rn-filters'}>{!continuous&&<summary>{t('筛选','Filters')}</summary>}<div><label>{t('类型','Type')}<select value={typeFilter} onChange={e=>setTypeFilter(e.target.value)}><option value="all">{t('全部类型','All types')}</option>{Object.entries(types).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label><label>{t('开始日期','From')}<input type="date" value={dateFrom} onChange={e=>setDateFrom(e.target.value)}/></label><label>{t('结束日期','To')}<input type="date" value={dateTo} onChange={e=>setDateTo(e.target.value)}/></label></div></DateFilters></div></FilterPanel></div>
   <div className="rn-history" ref={refreshRef}>{api.searchRpc&&query.trim()?<SearchResults passageFirst={continuous} search={search} t={t} onOpen={openSearchResult}/>:<>{!continuous&&<div className="rn-history-actions"><span>{filtered.length} {t('条笔记','notes')}</span><button disabled={blocked||loading} onClick={refresh}>{loading?t('刷新中…','Refreshing…'):t('刷新列表','Refresh list')}</button></div>}
   {!entries.length&&<p className="rn-muted">{query||typeFilter!=='all'||dateFrom||dateTo||chapterFilter!=='all'?t('没有找到符合条件的笔记。','No matching notes.'):t('还没有笔记。','No notes yet.')}</p>}
   <div className="rn-card-grid">{groups.map((group,index)=><section className="rn-group" key={`${group.key}-${index}`}>{sort==='chapter'&&<h2>{scope==='all'&&<span>{highlight(group.book)} · </span>}{highlight(group.chapter)} <small>· {group.total} {t('条','notes')}</small></h2>}{group.records.map(record=>{const data=getData(record),body=record.excerpt?.text||record.markdown||'',snippet=matchSnippet(body,query)||matchSnippet(record.markdown,query)||matchSnippet(data.chapter,query);return <button className={`rn-list-item${active?.cardId===record.cardId?' is-selected':''}`} key={record.cardId} aria-current={active?.cardId===record.cardId?'true':undefined} onClick={()=>selectCard(record)}><span>{highlight(snippet||body||t('空笔记','Empty note'))}</span><small>{sort!=='chapter'&&<>{scope==='all'&&`${record.title} · `}{data.chapter||t('未标注章节','No chapter')} · </>}{record.contentDay||t('日期待确认','Date unconfirmed')}</small></button>;})}</section>)}</div>
   {continuous&&currentPage<pages&&<MoreRows cursor={currentPage} onClick={()=>setPage(currentPage+1)}>{t('加载更多','Load more')}</MoreRows>}{!continuous&&pages>1&&<nav className="rn-pagination" aria-label={t('笔记分页','Notes pages')}><button disabled={currentPage===1} onClick={()=>changePage(currentPage-1)}>{t('上一页','Previous')}</button><span>{currentPage} / {pages}</span><button disabled={currentPage===pages} onClick={()=>changePage(currentPage+1)}>{t('下一页','Next')}</button></nav>}</>}</div></aside>
   <main ref={mainRef} className="rn-main">
  {editorOpen&&<div ref={editorRef} className="rn-editor" role="region" aria-labelledby="rn-editor-title" onKeyDown={e=>{if(e.key==='Escape'&&!busy){e.stopPropagation();closeEditor();}}}><header className="rn-editor-heading"><h2 id="rn-editor-title">{form.id?t('编辑笔记','Edit note'):t('新建笔记','New note')}</h2><button disabled={busy} aria-label={t('返回列表，保留草稿','Back to list, keep draft')} onClick={()=>{closeEditor();}}>✕</button></header><details className="rn-editor-meta" open={!mobile}><summary>{t('章节、页码和日期','Chapter, page and date')}</summary><div className="rn-meta">
   <label className="rn-book-select"><BookIcon/><span className="rn-sr">{t('书名','Book')}</span><select aria-label={t('书名','Book')} value={form.book} disabled={blocked} onChange={e=>choose(e.target.value)}>{!form.book&&<option value="">{t('选择或添加一本书','Choose or add a book')}</option>}{books.map(book=><option key={book} value={book}>{book}</option>)}<option value=":new">{t('添加一本书…','Add a book…')}</option></select></label>
   <label className="rn-inline-label">{t('类型','Type')}<select aria-label={t('笔记类型','Note type')} value={form.noteType||'reflection'} disabled={blocked} onChange={e=>edit({noteType:e.target.value})}>{Object.entries(types).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
   <label className="rn-date"><span className="rn-sr">{t('记录日期','Note date')}</span><input type="date" aria-label={t('记录日期','Note date')} value={form.day} disabled={blocked} onChange={e=>edit({day:e.target.value})}/></label>
   <label className="rn-inline-label">{t('章节','Chapter')}<input aria-label={t('章节','Chapter')} placeholder={t('选填','Optional')} maxLength={200} value={form.chapter} disabled={blocked} onChange={e=>edit({chapter:e.target.value})}/></label>
   <label className="rn-inline-label rn-page-number">{t('页码','Page')}<input aria-label={t('页码','Page')} placeholder={t('选填','Optional')} maxLength={80} value={form.page} disabled={blocked} onChange={e=>edit({page:e.target.value})}/></label>
   <button className="rn-books-button" disabled={blocked} onClick={openBooks}><BookIcon/>{t('书目','Books')}</button>
  </div></details>
  <details className="rn-excerpts" open={quotesOpen} onToggle={e=>setQuotesOpen(e.currentTarget.open)}><summary>{t('原文摘录','Book excerpts')}<span>{t('摘录不计入感想字数','Excluded from reflection counts')}</span></summary>
   <div className="rn-excerpt-fields">{(form.excerpts.length?form.excerpts:[{text:'',page:''}]).map((quote,i)=><div className="rn-excerpt-editor" key={i}><label>{t('摘录','Excerpt')} {i+1}<textarea aria-label={`${t('摘录','Excerpt')} ${i+1}`} placeholder={t('粘贴或输入书中的原文…','Paste or type a passage from the book…')} value={quote.text} disabled={blocked} maxLength={9000} onChange={e=>form.excerpts.length?updateExcerpt(i,{text:e.target.value}):edit({excerpts:[{...quote,text:e.target.value}]})}/></label><div><label>{t('页码','Page')}<input aria-label={`${t('摘录页码','Excerpt page')} ${i+1}`} placeholder={t('选填','Optional')} value={quote.page} maxLength={80} disabled={blocked} onChange={e=>form.excerpts.length?updateExcerpt(i,{page:e.target.value}):edit({excerpts:[{...quote,page:e.target.value}]})}/></label>{form.excerpts.length>0&&<button disabled={blocked} onClick={()=>{if(!quote.text||window.confirm(t('移除这段摘录？','Remove this excerpt?')))edit({excerpts:form.excerpts.filter((_,n)=>n!==i)});}}>{t('移除','Remove')}</button>}</div></div>)}{form.excerpts.length>1&&<p className="rn-muted">{t('这条旧笔记包含多条划线，想法由这些划线共同关联。','This older note has multiple highlights sharing one reflection.')}</p>}</div>
  </details>
  <div className="rn-reflection"><label htmlFor="rn-reflection">{t('我的感想','My reflections')}{form.id&&<small>{t('编辑中','Editing')}</small>}</label><textarea id="rn-reflection" aria-label={t('我的感想','My reflections')} placeholder={t('读到这里，你想到了什么？','What came to mind as you read?')} value={form.reflection} disabled={blocked} maxLength={1000000} onChange={e=>edit({reflection:e.target.value})}/></div>
  {notice&&<p className="rn-notice" role="status">{notice}</p>}{error&&<p className="rn-error" role="alert">{error}</p>}
  <div className="rn-save-row"><span>{count(form.reflection).toLocaleString()} {t('字','characters')}</span><div><button disabled={busy} onClick={()=>{closeEditor();}}>{t('返回','Back')}</button><button disabled={blocked} onClick={()=>{if(leaveDraft()){replaceForm(fresh(form.book));setQuotesOpen(true);closeEditor();setNotice('');setError('');}}}>{t('放弃修改','Discard')}</button><button className="rn-primary" disabled={busy||(!pending&&(!form.book||(!form.excerpts.some(x=>x.text.trim())&&(!form.id||!form.reflection.trim()))))} onClick={save}>{busy?t('保存中…','Saving…'):pending?t('再次核对保存','Verify save again'):form.id?t('保存修改','Save changes'):t('保存笔记','Save note')}</button></div></div>
  </div>}
   {!editorOpen&&active&&(()=>{const data=getData(active),index=filtered.findIndex(r=>r.cardId===active.cardId);return <article className="rn-detail"><button className="rn-mobile-back" onClick={()=>setMode('list')}>‹ {t('返回','Back')}</button><div className="rn-detail-top"><p>{highlight(active.title)} <span>›</span> {highlight(data.chapter||t('未标注章节','No chapter'))}</p><div className="rn-detail-actions">{renderCanvas&&<button type="button" onMouseDown={e=>e.preventDefault()} onClick={()=>setCanvas({...active,canvasText:canvasPassage(excerptRoot.current)||canvasPassage(reflectionRoot.current)||searchMatch?.text||active.excerpt?.text||active.markdown})}>{canvasActionLabel||t('在画布中展开','Open in canvas')}</button>}<button className="rn-edit-note" disabled={busy||Boolean(pendingDelete)||(Boolean(pending)&&form.id!==active.id)} onClick={()=>startEdit(active)}>{t('编辑笔记','Edit note')}</button>{(!active.sharedReflection||renderCanvas)&&<details className="rn-more-actions"><summary>{t('更多','More')}</summary><button disabled={blocked} onClick={event=>{const menu=event.currentTarget.closest('details');if(menu){menu.open=false;menu.querySelector('summary')?.focus();}deleteCard(active);}}>{active.sharedReflection?t('删除整条笔记','Delete entire note'):t('删除','Delete')}</button></details>}</div></div>
   {matchNotice&&<p role="status">{matchNotice}</p>}{searchMatch&&<MatchContext record={active} match={searchMatch} t={t} query={search.mode==='exact'?query:''}/>}
   {active.sharedReflection&&<p className="rn-muted">{renderCanvas?t('这条旧笔记的多条划线共享一份感想，编辑和删除作用于整条笔记。','These highlights share a reflection. Edits and deletion apply to the whole note.'):t('旧笔记包含多条划线，共享一份感想；只能整体编辑或在素材页整体删除。','This older note has multiple highlights sharing one reflection. Edit the whole note or delete it in Materials.')}</p>}
   {active.excerpt?.text&&<><h2 className="rn-detail-excerpt-title">{t('原文摘录','Book excerpt')}</h2><blockquote ref={excerptRoot} className="rn-detail-excerpt">{highlight(active.excerpt.text)}</blockquote>{relatedRpc&&<AddToTheme rpc={relatedRpc} t={t} sourceRecordId={active.id} sourceRevision={active.revision} sourceLibraryId={active.sourceLibraryId||sourceLibraryId} field="excerpt" excerptIndex={Number(active.cardId.slice(active.cardId.lastIndexOf(':')+1))} sourceText={active.excerpt.text} selectionRoot={excerptRoot} fragment={searchMatch?.field==='excerpt'?{quote:searchMatch.text,start:searchMatch.anchor.start,end:searchMatch.anchor.end}:null}/>}</>}<p className="rn-detail-meta">{types[data.noteType]||types.reflection} · {active.contentDay||t('日期待确认','Date unconfirmed')} <span> | </span> {t('页码','Page')}：{active.excerpt?.page||data.page||t('未填写','Not set')}</p>
   {(!renderCanvas||active.markdown?.trim())&&<section className="rn-detail-thought"><h2>{active.sharedReflection?t('共同感想','Shared reflection'):t('我的感想','My reflections')}</h2>{active.markdown?<div ref={reflectionRoot} className="rn-card-markdown" dangerouslySetInnerHTML={{__html:markdown.render(active.markdown,{query:api.searchRpc&&search.mode==='semantic'?'':query})}}/>:<p className="rn-muted">{t('暂无感想','No reflection yet')}</p>}{relatedRpc&&<AddToTheme rpc={relatedRpc} t={t} sourceRecordId={active.id} sourceRevision={active.revision} sourceLibraryId={active.sourceLibraryId||sourceLibraryId} field="reflection" sourceText={active.markdown} selectionRoot={reflectionRoot} fragment={searchMatch?.field==='reflection'?{quote:searchMatch.text,start:searchMatch.anchor.start,end:searchMatch.anchor.end}:null}/>}</section>}
   {renderExploration?.(active)}
   {relatedRpc&&onOpenRecord&&onOpenTheme&&<RelationsBrowser key={'relations:'+active.id} record={active} rpc={relatedRpc} t={t} onOpenRecord={(id,kind,libraryId)=>{if(leaveDraft())onOpenRecord(id,kind,libraryId);}} onOpenTheme={(id,libraryId)=>{if(leaveDraft())onOpenTheme(id,libraryId);}}/>}
   {relatedRpc&&onOpenArticle&&<RelatedArticles id={active.id} rpc={relatedRpc} t={t} onOpen={id=>{if(leaveDraft())onOpenArticle(id);}}/>}
   {!(api.searchRpc&&query.trim())&&<nav className="rn-detail-nav" aria-label={t('笔记切换','Navigate notes')}><button disabled={index<=0} onClick={()=>moveCard(-1)}>{t('上一篇','Previous')}</button><span>{index+1} / {filtered.length}</span><button disabled={index>=filtered.length-1} onClick={()=>moveCard(1)}>{t('下一篇','Next')}</button></nav>}</article>;})()}
   {!editorOpen&&!active&&<div className="rn-empty-detail"><button className="rn-mobile-back" onClick={()=>setMode('list')}>‹ {t('返回','Back')}</button><p className="rn-muted">{t('选择一条笔记阅读','Select a note to read')}</p></div>}
   </main></div>}
  {canvas&&renderCanvas?.(canvas,search,()=>setCanvas(null))}
  <dialog className="rn-book-dialog" ref={dialog}><header><h2>{t('我的书目','My books')}</h2><button onClick={()=>dialog.current.close()}>{t('关闭','Close')}</button></header><label>{t('查找书名','Find a book')}<input value={bookQuery} onChange={e=>setBookQuery(e.target.value)} autoFocus/></label><div className="rn-book-list">{books.filter(book=>book.toLowerCase().includes(bookQuery.toLowerCase())).map(book=><button key={book} onClick={()=>selectBook(book)}><span>{book}</span><small>{records.filter(r=>r.title===book).length} {t('条笔记','notes')}</small></button>)}</div><form onSubmit={e=>{e.preventDefault();const name=newBook.trim().normalize('NFC');if(name)selectBook(name);}}><label>{t('添加书名','Add a book')}<input aria-label={t('添加书名','Add a book')} value={newBook} maxLength={200} onChange={e=>setNewBook(e.target.value)} placeholder={t('输入书名即可','Enter a book title')}/></label><button className="rn-primary" disabled={!newBook.trim()}>{t('开始记录','Start a note')}</button></form></dialog>
 </section>;
}
