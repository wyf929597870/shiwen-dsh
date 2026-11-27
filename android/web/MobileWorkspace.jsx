import React,{useEffect,useRef,useState} from 'react';
import {IdeaCanvas} from '../../plugins/workbench/src/IdeaCanvas.jsx';
import {AddToTheme,ThemesPage} from '../../plugins/workbench/src/Themes.jsx';
import {MatchContext,SearchResults,useContentSearch,matchSource} from '../../plugins/workbench/src/ContentSearch.jsx';
import {canvasPassage} from '../../plugins/workbench/src/canvas-passage.mjs';
import {decodeReadingNote} from '../../plugins/library/legacy/reading-note.mjs';
import {MarkdownView} from './MarkdownView.jsx';
import {useI18n} from './i18n.js';
import '../../plugins/workbench/src/idea-canvas.css';
import '../../plugins/workbench/src/content-search.css';

function CanvasMarkdown({body,record}){
  return <MarkdownView markdown={body} libraryId={record.sourceLibraryId} recordId={record.id} attachmentDescriptors={record.attachmentDescriptors}/>;
}
export function MobileCanvas({root,workspace,onClose}){
  const {t}=useI18n(),{rpc,libraryId,onArticle}=workspace;
  const [engine,setEngine]=useState(null);
  useEffect(()=>{
    let live=true;
    rpc('contentSearchEnable').then(status=>{if(live)setEngine(status.canSearchSemantic?'semantic':'related');},
      ()=>{if(live)setEngine('related');});
    return ()=>{live=false;};
  },[rpc]);
  return <IdeaCanvas textTree root={{...root,sourceLibraryId:libraryId}}
    backLabel={t('返回','Back')} rpc={rpc} t={t} libraryScope={libraryId} localRelated={engine==='related'}
    modeLabel={engine==='related'?t('按手机资料库中的相近文字展开','Related text in the phone library'):engine==='semantic'?t('使用手机本地语义索引','Using the phone’s semantic index'):null}
    search={{status:engine?{libraryScope:libraryId,canSearchSemantic:engine==='semantic'}:null}}
    MarkdownContent={CanvasMarkdown} newRequestId={()=>crypto.randomUUID()} onOpenArticle={id=>{onClose();onArticle(id);}} onClose={onClose}/>;
}
export function MaterialActions({record,workspace,bodyRef,field='body',excerptIndex,text=record.markdown}){
  const {t}=useI18n();
  return <div className="mw-material-actions"><button type="button" className="chip" onMouseDown={e=>e.preventDefault()}
    onClick={()=>workspace.explore({...record,canvasText:canvasPassage(bodyRef?.current)||text})}>{t('展开相关内容','Explore related content')}</button>
    <AddToTheme rpc={workspace.rpc} t={t} selectionRoot={bodyRef} sourceText={text} sourceRecordId={record.id}
      sourceRevision={record.revision} sourceLibraryId={workspace.libraryId} field={field} excerptIndex={excerptIndex}/></div>;
}
function Passage({record,workspace,text,field,index}){
  const ref=useRef(null);
  return <><blockquote ref={ref}>{text}</blockquote><MaterialActions record={record} workspace={workspace} bodyRef={ref} field={field} excerptIndex={index} text={text}/></>;
}
export function WorkspaceSource({id,match,workspace,onClose}){
  const {t}=useI18n(),dialog=useRef(null),body=useRef(null);
  const [record,setRecord]=useState(null),[error,setError]=useState(''),[attempt,retry]=useState(0);
  useEffect(()=>{const d=dialog.current;d.showModal();return ()=>d.close();},[]);
  useEffect(()=>{let live=true;setError('');workspace.rpc('readMarkdown',{id}).then(r=>{if(live)setRecord(r);},e=>{if(live)setError(e.message);});return ()=>{live=false;};},[workspace.rpc,id,attempt]);
  const note=record?.kind==='reading_note'?decodeReadingNote(record.annotation):null;
  const valid=match&&record&&matchSource(record,match)?.slice(match.anchor.start,match.anchor.end)===match.text;
  return <dialog ref={dialog} className="mw-source" onCancel={e=>{e.preventDefault();onClose();}} aria-label={t('查看原文','Read source')}>
    <header><button className="chip" onClick={onClose}>‹ {t('返回','Back')}</button></header>
    {error?<p role="alert">{error} <button onClick={()=>retry(n=>n+1)}>{t('重试','Retry')}</button></p>:!record?<p>{t('正在读取…','Loading…')}</p>:<article>
      {valid&&<MatchContext record={record} match={match} t={t}/>}
      <h1>{record.title||t('未命名','Untitled')}</h1><small>{record.contentDay} {note?.chapter}</small>
      {!valid&&match&&<small>{t('原文已变化，请核对当前内容。','Source changed; check the current text.')}</small>}
      {note?.excerpts.map((x,i)=><Passage key={i} record={record} workspace={workspace} text={x.text} field="excerpt" index={i}/>)}
      {(!note||record.markdown)&&<><div ref={body}><CanvasMarkdown record={record} body={record.markdown}/></div>
        <MaterialActions workspace={workspace} record={record} bodyRef={body} field={note?'reflection':'body'}/></>}
    </article>}
  </dialog>;
}
export function WorkspaceSearch({workspace}){
  const {t}=useI18n(),[query,setQuery]=useState('');
  const search=useContentSearch(workspace.rpc,'global',query,{});
  const status=search.status;
  const [startError,setStartError]=useState('');
  useEffect(()=>{
    if(search.mode!=='semantic')return;
    let live=true;
    setStartError('');
    workspace.rpc('contentSearchEnable').catch(e=>{if(live)setStartError(e.message);});
    return ()=>{live=false;};
  },[workspace.rpc,search.mode]);
  const indexed=Boolean(status?.canSearchSemantic);
  useEffect(()=>{if(indexed&&search.mode==='semantic')search.retry();},[indexed,search.mode]);
  return <section className="mw-search"><input type="search" placeholder={t('搜索记录、书摘、收藏和文章','Search records, highlights, collections and articles')} aria-label={t('全局搜索','Global search')}
    value={query} onChange={e=>setQuery(e.target.value)} onCompositionStart={()=>search.setComposing(true)} onCompositionEnd={e=>{setQuery(e.currentTarget.value);search.setComposing(false);}}/>
    <div className="mw-modes"><button aria-pressed={search.mode==='exact'} onClick={()=>search.chooseMode('exact')}>{t('按原文','Exact text')}</button>
      <button aria-pressed={search.mode==='semantic'} onClick={()=>search.chooseMode('semantic')}>{t('按意思','By meaning')}</button></div>
    {search.mode==='semantic'&&<p role="status">{startError||(
      status?.state==='failed'?status.message:
      status?.state==='ready'?t('手机本地语义检索','On-device semantic search'):
      t('正在建立手机索引','Building the on-device index')+(status?.total?` · ${status.completed} / ${status.total}`:''))}
      {status?.state==='indexing'&&indexed&&t(' · 可先搜索已完成的记录',' · Indexed records are searchable')}
      {(startError||status?.state==='failed')&&<button onClick={async()=>{try{await workspace.rpc('contentSearchEnable',{retry:true});setStartError('');search.retry();}catch(e){setStartError(e.message);}}}>{t('重试','Retry')}</button>}</p>}
    {search.error&&<p role="alert">{search.error} <button onClick={search.retry}>{t('重试','Retry')}</button></p>}
    {query.trim()&&(search.mode!=='semantic'||indexed)&&<SearchResults passageFirst search={search} t={t} onOpen={item=>workspace.source(item.recordId,item.match)}/>}
  </section>;
}
export function WorkspaceThemes({workspace,onNavigation}){
  const {t}=useI18n();
  return <section className="mw-themes"><ThemesPage onNavigation={onNavigation} draftNamespace="phone" rpc={workspace.rpc} t={t} onOpenSource={(id,opts)=>workspace.source(id,opts.match)}/></section>;
}
