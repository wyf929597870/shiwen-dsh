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
  const {t}=useI18n(),{rpc,libraryId,online,onArticle}=workspace;
  const [onlineAtOpen]=useState(online),[engine,setEngine]=useState(null);
  useEffect(()=>{
    let live=true;
    if(!onlineAtOpen){setEngine('local');return;}
    rpc('serverSearchStatus').then(value=>{if(live)setEngine(value.canSearchSemantic?'pc':'local');},
      ()=>{if(live)setEngine('local');});
    return ()=>{live=false;};
  },[rpc,onlineAtOpen]);
  return <IdeaCanvas textTree root={{...root,sourceLibraryId:libraryId}}
    backLabel={t('返回','Back')} rpc={rpc} t={t} libraryScope={libraryId} localRelated={engine==='local'}
    modeLabel={engine==='local'?t('按手机资料库中的相近文字展开','Related text in the phone library'):engine==='pc'?t('使用已连接电脑的语义索引','Using the connected computer’s semantic index'):null}
    search={{status:engine?{libraryScope:libraryId,canSearchSemantic:engine==='pc'}:null}}
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
      <h1>{record.title||t('未命名','Untitled')}</h1><small>{record.contentDay} {note?.chapter}</small>
      {valid?<MatchContext record={record} match={match} t={t}/>:match&&<small>{t('原文已变化，请核对当前内容。','Source changed; check the current text.')}</small>}
      {note?.excerpts.map((x,i)=><Passage key={i} record={record} workspace={workspace} text={x.text} field="excerpt" index={i}/>)}
      {(!note||record.markdown)&&<><div ref={body}><CanvasMarkdown record={record} body={record.markdown}/></div>
        <MaterialActions workspace={workspace} record={record} bodyRef={body} field={note?'reflection':'body'}/></>}
    </article>}
  </dialog>;
}
export function WorkspaceSearch({workspace}){
  const {t}=useI18n(),[query,setQuery]=useState('');
  const search=useContentSearch(workspace.rpc,'global',query,{});
  useEffect(()=>{if(!workspace.online&&search.mode==='semantic')search.chooseMode('exact');},[workspace.online,search.mode]);
  const [status,setStatus]=useState(null),[error,setError]=useState(''),[attempt,recheck]=useState(0);
  useEffect(()=>{
    if(search.mode!=='semantic'||!workspace.online)return;
    let live=true,timer;
    async function refresh(){try{
      const value=await workspace.rpc('serverSearchStatus');if(!live)return;setStatus(value);setError('');
      if(value.canSearchSemantic)search.retry();
      else if(value.state!=='disabled'&&value.state!=='failed')timer=setTimeout(refresh,3000);
    }catch(e){if(live)setError(e.message);}}
    refresh();return ()=>{live=false;clearTimeout(timer);};
  },[workspace.rpc,workspace.online,search.mode,attempt]);
  return <section className="mw-search"><input type="search" placeholder={t('搜索记录、书摘、收藏和文章','Search records, highlights, collections and articles')} aria-label={t('全局搜索','Global search')}
    value={query} onChange={e=>setQuery(e.target.value)} onCompositionStart={()=>search.setComposing(true)} onCompositionEnd={e=>{setQuery(e.currentTarget.value);search.setComposing(false);}}/>
    <div className="mw-modes"><button aria-pressed={search.mode==='exact'} onClick={()=>search.chooseMode('exact')}>{t('按原文','Exact text')}</button>
      <button disabled={!workspace.online} aria-pressed={search.mode==='semantic'} onClick={()=>search.chooseMode('semantic')}>{t('按意思','By meaning')}</button></div>
    {!workspace.online&&<small>{t('连接本资料库的电脑后可按意思搜索。','Connect this library’s computer for semantic search.')}</small>}
    {search.mode==='semantic'&&workspace.online&&<p>{error||(!status?t('正在连接电脑…','Connecting…'):status.canSearchSemantic?t('使用电脑语义索引','Using the computer’s semantic index'):t('电脑语义索引尚未就绪','Computer index is not ready'))} {status?.state==='disabled'&&<button onClick={async()=>{try{setStatus(await workspace.rpc('contentSearchEnable'));recheck(n=>n+1);}catch(e){setError(e.message);}}}>{t('启用电脑索引','Enable computer index')}</button>}</p>}
    {search.error&&<p role="alert">{search.error} <button onClick={search.retry}>{t('重试','Retry')}</button></p>}
    {query.trim()&&<SearchResults search={search} t={t} onOpen={item=>workspace.source(item.recordId,item.match)}/>}
  </section>;
}
export function WorkspaceThemes({workspace,onNavigation,detailOpen}){
  const {t}=useI18n();
  return <section className="mw-themes">{!detailOpen&&workspace.role!=='standalone'&&<div className="mw-modes">
    <button aria-pressed={!workspace.localTopics} onClick={()=>workspace.chooseLocalTopics(false)}>{t('电脑主题','Computer topics')}</button>
    <button aria-pressed={workspace.localTopics} onClick={()=>workspace.chooseLocalTopics(true)}>{t('手机主题','Phone topics')}</button></div>}
    {!detailOpen&&<small>{workspace.localTopics?t('保存在当前手机资料库','Saved in this phone library'):t('与已绑定电脑共用主题，需要连接电脑。','Shared with this library’s computer while connected.')}</small>}
    <ThemesPage onNavigation={onNavigation} key={workspace.localTopics?'phone':'computer'} draftNamespace={workspace.localTopics?'phone':'computer'} rpc={workspace.rpc} t={t} onOpenSource={(id,opts)=>workspace.source(id,opts.match)}/></section>;
}
