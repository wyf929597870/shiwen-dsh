import React,{useEffect,useMemo,useRef,useState} from 'react';
import {readingSourceCards,sourceCitation,matchesSource,materialTypes} from './writing-source-helpers.mjs';

export function WritingSources({records,selectedIds,onChange,onQuote,onClose,rpc,MarkdownContent,zh,disabled}){
 const tr=(cn,en)=>zh?cn:en;
 const [tab,setTab]=useState('all'),[query,setQuery]=useState(''),[type,setType]=useState('all'),[book,setBook]=useState('all'),[limit,setLimit]=useState(40);
 const [reading,setReading]=useState(null),[readingError,setReadingError]=useState(''),[readingLoading,setReadingLoading]=useState(true),[retry,setRetry]=useState(0);
 const [expanded,setExpanded]=useState(''),[preview,setPreview]=useState(null),[error,setError]=useState(''),[loading,setLoading]=useState(false),[quote,setQuote]=useState('');
 const reader=useRef(null),request=useRef(0);
 useEffect(()=>{let active=true;setReadingError('');setReadingLoading(true);rpc('readingNoteList').then(async value=>{const ids=new Set(value.records.map(row=>row.id));const extra=records.filter(row=>row.kind==='reading_note'&&!row.deleted&&!ids.has(row.id));const loaded=await Promise.all(extra.map(row=>rpc('readMarkdown',{id:row.id})));if(active)setReading([...value.records,...loaded]);}).catch(e=>{if(active){setReading(null);setReadingError(e.message);}}).finally(()=>{if(active)setReadingLoading(false);});return()=>{active=false;};},[rpc,retry,records]);
 const materials=useMemo(()=>records.filter(row=>row.kind!=='article'&&row.kind!=='ai_annotation'&&!row.deleted),[records]);
 const cards=useMemo(()=>{
  const ids=new Set((reading??[]).map(row=>row.id));
  return [...readingSourceCards(reading??[]),...materials.filter(row=>row.kind!=='reading_note'&&!ids.has(row.id)).map(row=>({...row,cardId:row.id}))];
 },[materials,reading]);
 const books=useMemo(()=>[...new Set(cards.filter(r=>r.kind==='reading_note').map(r=>r.title).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'zh-CN')),[cards]);
 const results=useMemo(()=>cards.filter(row=>{
  return (tab==='all'||selectedIds.includes(row.id))&&(type==='all'||row.kind===type)&&(book==='all'||row.kind==='reading_note'&&row.title===book)&&matchesSource(row,query);
 }),[cards,tab,selectedIds,type,book,query]);
 const missing=selectedIds.filter(id=>!materials.some(row=>row.id===id)&&!(reading??[]).some(row=>row.id===id));
 useEffect(()=>{setLimit(40);},[query,tab,type,book]);
 const toggle=id=>onChange(selectedIds.includes(id)?selectedIds.filter(value=>value!==id):[...selectedIds,id]);
 async function open(row){const token=++request.current;setQuote('');setExpanded(row.cardId);setLoading(false);setError('');if(row.kind==='reading_note'&&row.metadata!==undefined){setPreview(row);return;}setPreview(null);setError('');setLoading(true);try{const value=await rpc('readMarkdown',{id:row.id});if(token===request.current)setPreview(value);}catch(e){if(token===request.current)setError(e.message);}finally{if(token===request.current)setLoading(false);}}
 function captureSelection(){const selection=window.getSelection();setQuote(selection&&reader.current?.contains(selection.anchorNode)&&reader.current?.contains(selection.focusNode)?selection.toString().trim():'');}
 const isReading=preview?.kind==='reading_note'&&preview.metadata!==undefined;
 const excerpt=isReading?preview.excerpt?.text??'':'';
 const citation=isReading?sourceCitation(preview,zh):(preview?.title||'');
 return <aside className="sw-writing-sources" aria-label={tr('写作素材','Writing materials')}>
  <header className="sw-sources-heading"><strong>{tr('写作素材','Writing materials')}</strong><button type="button" onClick={onClose} aria-label={tr('收起素材栏','Hide materials')}>×</button></header>
  <div className="sw-source-tabs" aria-label={tr('素材范围','Material scope')}><button type="button" aria-pressed={tab==='all'} onClick={()=>{setTab('all');setPreview(null);setExpanded('');}}>{tr('资料库','Library')}</button><button type="button" aria-pressed={tab==='linked'} onClick={()=>{setTab('linked');setPreview(null);setExpanded('');}}>{tr('本篇素材','This article')} · {selectedIds.length}</button></div>
  <input type="search" value={query} placeholder={tr('搜索摘录、感想、书名','Search excerpts, reflections, books')} aria-label={tr('搜索素材','Search materials')} onChange={event=>setQuery(event.target.value)}/>
  <div className="sw-source-filters"><label>{tr('类型','Type')}<select value={type} onChange={e=>{setType(e.target.value);setBook('all');}}><option value="all">{tr('全部类型','All types')}</option><option value="reading_note">{tr('读书笔记','Reading notes')}</option>{materialTypes(materials).map(k=><option value={k} key={k}>{({journal:tr('日记','Journal'),freewrite:tr('自由书写','Freewriting'),idea:tr('想法','Idea'),web:tr('网页','Web'),ai:tr('AI 讨论','AI discussion'),reference:tr('参考资料','Reference')})[k]||k}</option>)}</select></label><label>{tr('书籍','Book')}<select value={book} onChange={e=>setBook(e.target.value)}><option value="all">{tr('全部书籍','All books')}</option>{books.map(b=><option key={b} value={b}>{b}</option>)}</select></label></div>
  <div className="sw-source-cards">
   {readingLoading&&<p role="status">{tr('正在读取读书笔记…','Loading reading notes…')}</p>}
   {readingError&&<p role="alert">{tr('读书笔记读取失败：','Could not load reading notes: ')}{readingError} <button onClick={()=>setRetry(v=>v+1)}>{tr('重试','Retry')}</button></p>}
   {tab==='linked'&&!readingLoading&&!readingError&&missing.map(id=><div className="sw-source-card" key={id}><p className="sw-muted">{tr('素材已删除或暂不可用','Material deleted or unavailable')}</p><button type="button" disabled={disabled} onClick={()=>toggle(id)}>{tr('移除关联','Remove link')}</button></div>)}
   {!results.length&&!readingLoading&&!readingError&&<p className="sw-muted">{query||type!=='all'||book!=='all'?tr('没有匹配的素材。','No matching materials.'):tab==='linked'?tr('还没有关联素材。','No linked materials yet.'):tr('资料库还没有素材。','No materials in the library yet.')}</p>}
   {results.slice(0,limit).map(row=><article className="sw-source-card" key={row.cardId}>
    <div className="sw-source-card-top"><button type="button" className="sw-source-open" aria-expanded={expanded===row.cardId} onClick={()=>expanded===row.cardId?(request.current++,setExpanded(''),setPreview(null),setError(''),setLoading(false)):open(row)}><strong>{row.kind==='reading_note'?(row.metadata?.chapter||row.title||tr('读书笔记','Reading note')):(row.title||tr('未命名','Untitled'))}</strong><small>{row.kind==='reading_note'?row.title:row.contentDay??tr('日期待确认','Date unconfirmed')}</small>{expanded!==row.cardId&&<p>{String(row.excerpt?.text||row.markdown||row.body||'').replace(/\s+/g,' ').slice(0,180)||tr('打开查看完整内容','Open to read the full content')}</p>}</button><button type="button" className="sw-source-add" disabled={disabled} aria-pressed={selectedIds.includes(row.id)} onClick={()=>toggle(row.id)}>{selectedIds.includes(row.id)?tr('✓ 已加入','✓ Added'):tr('＋ 加入本篇','＋ Add')}</button></div>
    {expanded===row.cardId&&<div className="sw-source-expanded">
     {loading&&<p role="status">{tr('正在读取全文…','Loading full text…')}</p>}{error&&<div role="alert">{tr('读取失败：','Could not read: ')}{error} <button onClick={()=>open(row)}>{tr('重试','Retry')}</button></div>}
     {preview&&isReading&&<>{!preview.metadata&&<p>{tr('备注格式无法识别，请在素材页核对。','Metadata is unrecognized; check it in Materials.')}</p>}{excerpt&&<><small>{tr('原文摘录','Excerpt')}</small><div className="sw-source-excerpt" ref={reader} onMouseUp={captureSelection} onKeyUp={captureSelection} tabIndex={0}>{excerpt}</div></>}{preview.markdown&&<><small>{preview.sharedReflection?tr('原笔记的共同感想','Shared reflection from original note'):tr('我的感想','My reflection')}</small><div ref={!excerpt?reader:undefined} onMouseUp={!excerpt?captureSelection:undefined} onKeyUp={!excerpt?captureSelection:undefined} tabIndex={!excerpt?0:undefined}><MarkdownContent body={preview.markdown} record={preview}/></div></>}{citation&&<p className="sw-source-citation">{citation}</p>}</>}
     {preview&&!isReading&&<div ref={reader} onMouseUp={captureSelection} onKeyUp={captureSelection} tabIndex={0}><MarkdownContent body={preview.markdown??''} record={preview}/></div>}
     {preview&&<div className="sw-source-quote"><span>{quote?tr(`已选中 ${quote.length} 字`,`Selected ${quote.length} characters`):isReading?(excerpt?tr('可选择原文的一部分','Select part of the excerpt'):tr('选中个人感想后插入','Select personal reflection to insert')):tr('选中内容后插入引用','Select text to quote')}</span><button type="button" className="sw-primary" disabled={disabled||(!quote&&!excerpt)} onMouseDown={e=>e.preventDefault()} onClick={()=>{onQuote({...preview,citation},quote||excerpt);setQuote('');}}>{tr('插入引用','Insert quote')}</button></div>}
    </div>}
   </article>)}
   {results.length>limit&&<button type="button" className="sw-source-more" onClick={()=>setLimit(value=>value+40)}>{tr('加载更多','Load more')}</button>}
  </div>
 </aside>;
}
