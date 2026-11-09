import React,{useEffect,useMemo,useRef,useState} from 'react';

// Reading materials is independent of the article editor: it never navigates
// the main record or replaces its draft.
export function WritingSources({records,selectedIds,onChange,onQuote,onClose,rpc,MarkdownContent,zh,disabled}){
 const tr=(cn,en)=>zh?cn:en;
 const [tab,setTab]=useState('all'),[query,setQuery]=useState(''),[limit,setLimit]=useState(40);
 const [previewId,setPreviewId]=useState(null),[preview,setPreview]=useState(null),[error,setError]=useState(''),[loading,setLoading]=useState(false),[retry,setRetry]=useState(0),[quote,setQuote]=useState('');
 const list=useRef(null),reader=useRef(null),back=useRef(null),listPosition=useRef(0),opener=useRef(null);
 const materials=useMemo(()=>records.filter(row=>row.kind!=='article'&&row.kind!=='ai_annotation'&&!row.deleted),[records]);
 const results=useMemo(()=>materials.filter(row=>(tab==='all'||selectedIds.includes(row.id))&&(!query||`${row.title}\n${row.body??''}`.toLowerCase().includes(query.toLowerCase()))),[materials,tab,query,selectedIds]);
 const missing=selectedIds.filter(id=>!materials.some(row=>row.id===id));
 useEffect(()=>{setLimit(40);},[query,tab]);
 useEffect(()=>{
  if(!previewId)return;let active=true;setLoading(true);setPreview(null);setError('');setQuote('');back.current?.focus();
  rpc('readMarkdown',{id:previewId}).then(value=>{if(active)setPreview(value);}).catch(e=>{if(active)setError(e.message);}).finally(()=>{if(active)setLoading(false);});
  return()=>{active=false;};
 },[previewId,retry,rpc]);
 useEffect(()=>{if(!previewId&&list.current){list.current.scrollTop=listPosition.current;opener.current?.focus({preventScroll:true});}},[previewId]);
 const toggle=id=>onChange(selectedIds.includes(id)?selectedIds.filter(value=>value!==id):[...selectedIds,id]);
 function open(row,event){opener.current=event.currentTarget;listPosition.current=list.current?.scrollTop??0;setPreviewId(row.id);}
 function captureSelection(){const selection=window.getSelection();setQuote(selection&&reader.current?.contains(selection.anchorNode)&&reader.current?.contains(selection.focusNode)?selection.toString().trim():'');}
 return <aside className="sw-writing-sources" aria-label={tr('写作素材','Writing materials')}>
  <header className="sw-sources-heading"><div><strong>{tr('写作素材','Writing materials')}</strong><small>{tr('先阅读，再加入本篇','Read first, then add to this article')}</small></div><button type="button" onClick={onClose} aria-label={tr('收起素材栏','Hide materials')}>×</button></header>
  <div className="sw-source-browser" hidden={Boolean(previewId)}>
   <div className="sw-source-tabs" aria-label={tr('素材范围','Material scope')}>
    <button type="button" aria-pressed={tab==='all'} onClick={()=>setTab('all')}>{tr('资料库','Library')}</button>
    <button type="button" aria-pressed={tab==='linked'} onClick={()=>setTab('linked')}>{tr('本篇素材','This article')} · {selectedIds.length}</button>
   </div>
   <input type="search" value={query} placeholder={tr('搜索标题或正文','Search titles or text')} aria-label={tr('搜索素材','Search materials')} onChange={event=>setQuery(event.target.value)}/>
   <div ref={list} className="sw-source-cards">
    {tab==='linked'&&missing.map(id=><div className="sw-source-card" key={id}><p className="sw-muted">{tr('素材已删除或暂不可用','Material deleted or unavailable')}</p><button type="button" disabled={disabled} onClick={()=>toggle(id)}>{tr('移除关联','Remove link')}</button></div>)}
    {!results.length&&<p className="sw-muted">{query?tr('没有匹配的素材，试试其他关键词。','No matching materials. Try another keyword.'):tab==='linked'?tr('还没有关联素材。到资料库阅读并加入需要的内容。','No linked materials yet. Read and add materials from the library.'):tr('资料库还没有素材。','No materials in the library yet.')}</p>}
    {results.slice(0,limit).map(row=><article className="sw-source-card" key={row.id}>
     <button type="button" className="sw-source-open" onClick={event=>open(row,event)} aria-label={`${tr('查看素材','Read material')}：${row.title}`}>
      <strong>{row.title||tr('未命名','Untitled')}</strong><small>{row.contentDay??tr('日期待确认','Date unconfirmed')}</small>
      <p>{String(row.body??'').replace(/\s+/g,' ').slice(0,180)||tr('打开查看完整内容','Open to read the full content')}</p>
     </button>
     <div className="sw-source-card-actions"><span>{tr('点击内容阅读全文','Click the content to read')}</span><button type="button" disabled={disabled} aria-pressed={selectedIds.includes(row.id)} onClick={()=>toggle(row.id)}>{selectedIds.includes(row.id)?tr('已加入 · 移除','Added · Remove'):tr('加入本篇','Add to article')}</button></div>
    </article>)}
    {results.length>limit&&<button type="button" className="sw-source-more" onClick={()=>setLimit(value=>value+40)}>{tr('加载更多','Load more')}</button>}
   </div>
  </div>
  {previewId&&<div className="sw-source-preview">
   <div className="sw-source-preview-actions"><button ref={back} type="button" onClick={()=>setPreviewId(null)}>← {tr('返回素材列表','Back to materials')}</button>{preview&&<button type="button" disabled={disabled} aria-pressed={selectedIds.includes(preview.id)} onClick={()=>toggle(preview.id)}>{selectedIds.includes(preview.id)?tr('已加入 · 移除','Added · Remove'):tr('加入本篇','Add to article')}</button>}</div>
   {preview&&<div className="sw-source-identity"><h2>{preview.title||tr('未命名','Untitled')}</h2><p className="sw-meta">{preview.contentDay??tr('日期待确认','Date unconfirmed')}</p></div>}
   <div className="sw-source-reading" ref={reader} onMouseUp={captureSelection} onKeyUp={captureSelection} tabIndex={0} aria-label={tr('素材正文','Material content')}>
    {loading&&<p role="status">{tr('正在读取全文…','Loading full text…')}</p>}
    {error&&<div role="alert"><p>{tr('读取失败：','Could not read: ')}{error}</p><button type="button" onClick={()=>setRetry(value=>value+1)}>{tr('重试','Retry')}</button></div>}
    {preview&&<MarkdownContent body={preview.markdown} record={preview}/>}
   </div>
   {preview&&<footer className="sw-source-quote"><span>{quote?tr(`已选中 ${quote.length} 字`,`Selected ${quote.length} characters`):tr('选中原文，可插入到正文光标处','Select text to quote at your writing cursor')}</span><button type="button" disabled={disabled||!quote} onClick={()=>{onQuote(preview,quote);setQuote('');}}>{tr('插入引用','Insert quote')}</button></footer>}
  </div>}
 </aside>;
}
