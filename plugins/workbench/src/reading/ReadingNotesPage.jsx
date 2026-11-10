import React,{useEffect,useMemo,useRef,useState} from 'react';
import MarkdownIt from 'markdown-it';
import {count} from '../../../library/legacy/content.mjs';
import {decodeReadingNote,readingNoteDraft,validateReadingNote} from '../../../library/legacy/reading-note.mjs';
import {bookIcon} from './book-icon.mjs';
const markdown=new MarkdownIt({html:false,linkify:false,breaks:true});
const today=()=>{const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;};
const fresh=book=>({book,day:today(),reflection:'',chapter:'',page:'',excerpts:[]});
const newId=()=>crypto.randomUUID();
const noop=()=>{};
export function BookIcon(){return <img className="rn-book-icon" src={bookIcon} alt="" aria-hidden="true"/>;}
export function ReadingNoteSources({annotation,t=(a)=>a}){
 const value=decodeReadingNote(annotation);if(!value)return <p className="rn-muted">{t('备注需在素材页核对','Check this note’s metadata in Materials')}</p>;
 if(!value.excerpts.length&&!value.chapter&&!value.page)return null;
 return <div className="rn-sources">{(value.chapter||value.page)&&<p className="rn-muted">{[value.chapter,value.page&&`${t('页码','Page')} ${value.page}`].filter(Boolean).join(' · ')}</p>}{value.excerpts.length>0&&<><p className="rn-muted">{t('原文摘录 · 不计入感想字数','Book excerpts · excluded from reflection counts')}</p>{value.excerpts.map((x,i)=><blockquote key={i}><p>{x.text}</p>{x.page&&<cite>{t('页码','Page')} {x.page}</cite>}</blockquote>)}</>}</div>;
}
export function ReadingNotesPage({api,t=(a)=>a,onPageStateChange=noop}){
 const [records,setRecords]=useState([]),[form,setForm]=useState(()=>fresh('')),[ready,setReady]=useState(false),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[dirty,setDirty]=useState(false),[pending,setPending]=useState(null),[error,setError]=useState(''),[notice,setNotice]=useState(''),[quotesOpen,setQuotesOpen]=useState(false),[expanded,setExpanded]=useState(''),[bookQuery,setBookQuery]=useState(''),[newBook,setNewBook]=useState('');
 const dialog=useRef(null),draftKey=useRef(''),alive=useRef(true),formRef=useRef(form);
 const blocked=busy||Boolean(pending);
 const books=useMemo(()=>[...new Set([...records.map(r=>r.title),form.book].filter(Boolean))].sort((a,b)=>a.localeCompare(b,'zh-CN')),[records,form.book]);
 const entries=records.filter(r=>r.title===form.book).sort((a,b)=>(b.contentDay??'').localeCompare(a.contentDay??'')||(b.createdAt??b.created??'').localeCompare(a.createdAt??a.created??'')||b.id.localeCompare(a.id));
 const storeDraft=(next,isDirty,nextPending)=>{
  if(!draftKey.current)throw Error(t('资料库尚未就绪','Library is not ready'));
  localStorage.setItem(draftKey.current,JSON.stringify({form:next,dirty:isDirty,pending:nextPending}));
 };
 useEffect(()=>{
  alive.current=true;let live=true;
  api.list().then(data=>{
   if(!live)return;setRecords(data.records);draftKey.current=`shiwen-reading-notes:${location.origin}:${data.scope}`;
   let saved;try{saved=JSON.parse(localStorage.getItem(draftKey.current)||'null');}catch{setError(t('无法恢复本机草稿，请勿清除浏览器资料','Could not restore the local draft'));}
   const next=saved?.form&&typeof saved.form.book==='string'&&typeof saved.form.reflection==='string'&&Array.isArray(saved.form.excerpts)?saved.form:fresh(data.records[0]?.title??'');
   formRef.current=next;setForm(next);setDirty(Boolean(saved?.dirty));setPending(saved?.pending??null);setQuotesOpen(Boolean(saved?.form?.excerpts?.length));setReady(true);
   if(saved?.dirty)setNotice(t('已恢复未保存草稿','Unsaved draft restored'));
  }).catch(e=>{if(live)setError(e.message);}).finally(()=>{if(live)setLoading(false);});
  return()=>{live=false;alive.current=false;};
 },[api]);
 useEffect(()=>{onPageStateChange({dirty,busy:blocked});return()=>onPageStateChange({dirty:false,busy:false});},[dirty,blocked,onPageStateChange]);
 useEffect(()=>{const warn=e=>{if(dirty||blocked){e.preventDefault();e.returnValue='';}};window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn);},[dirty,blocked]);
 const replaceForm=(next,isDirty=false,nextPending=null)=>{formRef.current=next;setForm(next);setDirty(isDirty);setPending(nextPending);try{storeDraft(next,isDirty,nextPending);}catch(e){setError(t('本机草稿未能保存：','Could not save local draft: ')+e.message);}};
 const edit=patch=>{setNotice('');replaceForm({...formRef.current,...patch},true);};
 const leaveDraft=()=>!blocked&&(!dirty||window.confirm(t('放弃当前未保存的修改？','Discard the current unsaved changes?')));
 const selectBook=book=>{if(!leaveDraft())return;replaceForm(fresh(book));setError('');setNotice('');setExpanded('');setQuotesOpen(false);dialog.current?.close();};
 const openBooks=()=>{setBookQuery('');setNewBook('');dialog.current.showModal();};
 const choose=value=>value===':new'?openBooks():selectBook(value);
 const startEdit=record=>{
  if(!leaveDraft())return;
  try{const next=readingNoteDraft(record);replaceForm(next);setQuotesOpen(next.excerpts.length>0);setError('');setNotice(t('正在编辑已保存的笔记','Editing a saved note'));document.getElementById('rn-reflection')?.focus();}catch(e){setError(e.message);}
 };
 async function refresh(){
  if(blocked)return;setLoading(true);setError('');try{const data=await api.list();if(alive.current)setRecords(data.records);}catch(e){if(alive.current)setError(e.message);}finally{if(alive.current)setLoading(false);}
 }
 async function save(){
  if(busy||!ready)return;setError('');setNotice('');let operation=pending,sent=false;
  try{
   if(!operation){validateReadingNote(formRef.current);operation={input:structuredClone(formRef.current),requestId:newId(),recordId:formRef.current.id??newId(),generation:Date.now()};}
   storeDraft(operation.input,true,operation);setPending(operation);setBusy(true);
   sent=true;const record=await api.save(operation);if(!alive.current)return;
   const next=fresh(operation.input.book);replaceForm(next);setQuotesOpen(false);setExpanded(record.id);
   setNotice(t('笔记已保存','Note saved'));window.dispatchEvent(new Event('shiwen-library-updated'));
   try{const data=await api.list();if(alive.current)setRecords(data.records);}catch(e){setError(t('笔记已保存，列表刷新失败，请刷新列表。','Note saved, but the list could not refresh.'));}
  }catch(e){
   if(!alive.current)return;const message=String(e.message||e);
   if(!sent||/已被更新|REVISION_CONFLICT|不存在|NOT_FOUND|格式|过长|请选择|请先|长度|最多|请求编号|VALIDATION/.test(message)){setPending(null);try{storeDraft(formRef.current,true,null);}catch{};setError(message);}
   else setError(t('保存结果待核对，草稿已保留。请点击“再次核对保存”。','Save result uncertain. Draft retained; choose “Verify save again”.')+' '+message);
  }finally{if(alive.current)setBusy(false);}
 }
 const updateExcerpt=(i,patch)=>edit({excerpts:form.excerpts.map((x,n)=>i===n?{...x,...patch}:x)});
 return <section className="rn-page" aria-label={t('读书笔记','Reading notes')}>
  <header className="rn-heading"><h1>{t('读书笔记','Reading notes')}</h1><p>{t('专注随记，记录阅读中的思考与收获。','Capture your thoughts and discoveries as you read.')}</p></header>
  {!ready&&<p role={error?'alert':'status'}>{error||t('正在读取笔记…','Loading notes…')}{!loading&&<button onClick={()=>location.reload()}>{t('重试','Retry')}</button>}</p>}
  {ready&&<>
  <div className="rn-meta">
   <label className="rn-book-select"><BookIcon/><span className="rn-sr">{t('书名','Book')}</span><select aria-label={t('书名','Book')} value={form.book} disabled={blocked} onChange={e=>choose(e.target.value)}>{!form.book&&<option value="">{t('选择或添加一本书','Choose or add a book')}</option>}{books.map(book=><option key={book} value={book}>{book}</option>)}<option value=":new">{t('添加一本书…','Add a book…')}</option></select></label>
   <label className="rn-date"><span className="rn-sr">{t('记录日期','Note date')}</span><input type="date" aria-label={t('记录日期','Note date')} value={form.day} disabled={blocked} onChange={e=>edit({day:e.target.value})}/></label>
   <label className="rn-inline-label">{t('章节','Chapter')}<input aria-label={t('章节','Chapter')} placeholder={t('选填','Optional')} maxLength={200} value={form.chapter} disabled={blocked} onChange={e=>edit({chapter:e.target.value})}/></label>
   <label className="rn-inline-label rn-page-number">{t('页码','Page')}<input aria-label={t('页码','Page')} placeholder={t('选填','Optional')} maxLength={80} value={form.page} disabled={blocked} onChange={e=>edit({page:e.target.value})}/></label>
   <button className="rn-books-button" disabled={blocked} onClick={openBooks}><BookIcon/>{t('书目','Books')}</button>
  </div>
  <div className="rn-reflection"><label htmlFor="rn-reflection">{t('我的感想','My reflections')}{form.id&&<small>{t('编辑中','Editing')}</small>}</label><textarea id="rn-reflection" aria-label={t('我的感想','My reflections')} placeholder={t('读到这里，你想到了什么？','What came to mind as you read?')} value={form.reflection} disabled={blocked} maxLength={1000000} onChange={e=>edit({reflection:e.target.value})}/></div>
  <details className="rn-excerpts" open={quotesOpen} onToggle={e=>setQuotesOpen(e.currentTarget.open)}><summary>{t('原文摘录（可选）','Book excerpts (optional)')}<span>{t('摘录不计入感想字数','Excluded from reflection counts')}</span></summary>
   <div className="rn-excerpt-fields">{(form.excerpts.length?form.excerpts:[{text:'',page:''}]).map((quote,i)=><div className="rn-excerpt-editor" key={i}><label>{t('摘录','Excerpt')} {i+1}<textarea aria-label={`${t('摘录','Excerpt')} ${i+1}`} placeholder={t('粘贴或输入书中的原文…','Paste or type a passage from the book…')} value={quote.text} disabled={blocked} maxLength={9000} onChange={e=>form.excerpts.length?updateExcerpt(i,{text:e.target.value}):edit({excerpts:[{...quote,text:e.target.value}]})}/></label><div><label>{t('页码','Page')}<input aria-label={`${t('摘录页码','Excerpt page')} ${i+1}`} placeholder={t('选填','Optional')} value={quote.page} maxLength={80} disabled={blocked} onChange={e=>form.excerpts.length?updateExcerpt(i,{page:e.target.value}):edit({excerpts:[{...quote,page:e.target.value}]})}/></label>{form.excerpts.length>0&&<button disabled={blocked} onClick={()=>{if(!quote.text||window.confirm(t('移除这段摘录？','Remove this excerpt?')))edit({excerpts:form.excerpts.filter((_,n)=>n!==i)});}}>{t('移除','Remove')}</button>}</div></div>)}<button className="rn-text-button" disabled={blocked||form.excerpts.length>=30} onClick={()=>edit({excerpts:[...(form.excerpts.length?form.excerpts:[{text:'',page:''}]),{text:'',page:''}]})}>{t('添加一段摘录','Add another excerpt')}</button></div>
  </details>
  <div className="rn-save-row"><span>{count(form.reflection).toLocaleString()} {t('字','characters')}</span><div><button disabled={blocked} onClick={()=>{if(leaveDraft()){replaceForm(fresh(form.book));setQuotesOpen(false);setNotice('');setError('');}}}>{t('取消','Cancel')}</button><button className="rn-primary" disabled={busy||(!pending&&(!form.book||!form.reflection.trim()))} onClick={save}>{busy?t('保存中…','Saving…'):pending?t('再次核对保存','Verify save again'):form.id?t('保存修改','Save changes'):t('保存笔记','Save note')}</button></div></div>
  {notice&&<p className="rn-notice" role="status">{notice}</p>}{error&&<p className="rn-error" role="alert">{error}</p>}
  <details className="rn-history" open><summary>{t('本书笔记','Notes for this book')}<span> · {entries.length} {t('条','notes')}</span></summary><div className="rn-history-actions"><button disabled={blocked||loading} onClick={refresh}>{loading?t('刷新中…','Refreshing…'):t('刷新列表','Refresh list')}</button></div>
   {!entries.length&&<p className="rn-muted">{form.book?t('写下这本书的第一条感想。','Write your first reflection on this book.'):t('选择一本书，开始记录。','Choose a book to start writing.')}</p>}
   {entries.map(record=><details className="rn-entry" key={record.id} open={expanded===record.id} onToggle={e=>{if(e.currentTarget.open)setExpanded(record.id);else setExpanded(old=>old===record.id?'':old);}}><summary><time dateTime={record.contentDay??undefined}>{record.contentDay||t('日期待确认','Date unconfirmed')}</time><span>{(record.markdown||'').replace(/\s+/g,' ').slice(0,90)}</span></summary><div className="rn-entry-body"><div className="rn-markdown" dangerouslySetInnerHTML={{__html:markdown.render(record.markdown||'')}}/><ReadingNoteSources annotation={record.annotation} t={t}/><footer><small>{count(record.markdown||'').toLocaleString()} {t('字感想','reflection characters')}</small><button disabled={blocked} onClick={()=>startEdit(record)}>{t('编辑这条笔记','Edit this note')}</button></footer></div></details>)}
  </details>
  </>}
  <dialog className="rn-book-dialog" ref={dialog}><header><h2>{t('我的书目','My books')}</h2><button onClick={()=>dialog.current.close()}>{t('关闭','Close')}</button></header><label>{t('查找书名','Find a book')}<input value={bookQuery} onChange={e=>setBookQuery(e.target.value)} autoFocus/></label><div className="rn-book-list">{books.filter(book=>book.toLowerCase().includes(bookQuery.toLowerCase())).map(book=><button key={book} onClick={()=>selectBook(book)}><span>{book}</span><small>{records.filter(r=>r.title===book).length} {t('条笔记','notes')}</small></button>)}</div><form onSubmit={e=>{e.preventDefault();const name=newBook.trim().normalize('NFC');if(name)selectBook(name);}}><label>{t('添加书名','Add a book')}<input aria-label={t('添加书名','Add a book')} value={newBook} maxLength={200} onChange={e=>setNewBook(e.target.value)} placeholder={t('输入书名即可','Enter a book title')}/></label><button className="rn-primary" disabled={!newBook.trim()}>{t('开始记录','Start a note')}</button></form></dialog>
 </section>;
}
