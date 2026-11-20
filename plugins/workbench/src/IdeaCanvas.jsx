import React,{createContext,useContext,useEffect,useMemo,useRef,useState} from 'react';
import {kindLabel,MatchContext,resolveSearchMatch,SemanticStatus} from './ContentSearch.jsx';
import {ReadingNoteSources} from './reading/ReadingNotesPage.jsx';

import {canvasOutline} from './canvas-outline.mjs';

const branchSize=5;
const Curation=createContext(null);

function Modal({className,label,onClose,children}){
  const ref=useRef(null);
  useEffect(()=>{
    const dialog=ref.current;
    dialog.showModal();
    return ()=>dialog.close();
  },[]);
  return <dialog ref={ref} className={className} aria-label={label} onCancel={event=>{
    event.preventDefault();
    event.stopPropagation();
    onClose();
  }}>{children}</dialog>;
}

function SourceReader({item,rpc,t,MarkdownContent,onClose,sourceLibraryId,backLabel,onRemove}){
  const [result,setResult]=useState(null),[error,setError]=useState(''),[attempt,retry]=useState(0);
  useEffect(()=>{
    let active=true;
    setError('');
    const load=item.match?resolveSearchMatch(rpc,item,item.request):rpc('readMarkdown',{id:item.recordId}).then(record=>({record}));
    load.then(value=>{
      if(!active)return;
      if(sourceLibraryId&&value.record.sourceLibraryId!==sourceLibraryId){
        setError(t('资料库已切换，请重新打开。','Library changed. Please reopen this view.'));
        return;
      }
      setResult(value);
    },e=>{if(active)setError(e.message);});
    return ()=>{active=false;};
  },[item,rpc,attempt,sourceLibraryId]);
  const record=result?.record;
  return <Modal className="sw-canvas-reader" label={t('查看原文','Read source')} onClose={onClose}>
    <header><span>{t('原文','Source')}</span><div className="sw-canvas-actions">
      {onRemove&&<button type="button" onClick={onRemove}>{t('从列表移除','Remove from list')}</button>}
      <button type="button" autoFocus onClick={onClose}>{backLabel}</button>
    </div></header>
    {error?<p role="alert">{error} <button onClick={()=>retry(n=>n+1)}>{t('重试','Retry')}</button></p>:!record?<p role="status">{t('正在读取原文…','Loading source…')}</p>:<article>
      <small>{[kindLabel(record.kind,t),record.contentDay].filter(Boolean).join(' · ')}</small>
      <h2>{record.title||t('未命名','Untitled')}</h2>
      {result.changed&&<p role="status">{t('原文已变化，以下为当前版本。','The source has changed. Showing the current version.')}</p>}
      {result.match&&<MatchContext record={record} match={result.match} t={t}/>}
      <MarkdownContent body={record.markdown} record={record}/>
      {record.kind==='reading_note'&&<ReadingNoteSources annotation={record.annotation} t={t}/>}
    </article>}
  </Modal>;
}

async function findNeighbors(rpc,request,known,libraryScope,isActive){
  const items=[];
  let offset=0;
  do{
    const page=await rpc('contentSearch',{...request,offset,limit:Math.min(30,branchSize+known.size)});
    if(!isActive()||page.libraryScope!==libraryScope)return [];
    for(const item of page.items){
      if(known.has(item.recordId))continue;
      items.push({...item,request});
      if(items.length===branchSize)return items;
    }
    offset=page.nextOffset;
  }while(offset!=null);
  return items;
}

function Branch({item,known,root=false,ready,libraryScope,rpc,t,onRead}){
  const [expanded,setExpanded]=useState(root),[children,setChildren]=useState(null);
  const [error,setError]=useState(''),[attempt,setAttempt]=useState(0);
  const {selected,removed,toggle,remove,curationMode,textTree}=useContext(Curation);
  const isRemoved=removed.has(item.recordId);
  const card=useRef(null);
  const text=item.match?.text||item.text||item.title||'';
  // Leave room for the model's query instruction and preserve Unicode boundaries.
  const query=Array.from(text.trim().slice(0,1000)).slice(0,384).join('');
  useEffect(()=>{
    if(!ready||!expanded||isRemoved||children!==null)return;
    let active=true;
    const request={scope:'ideaCanvas',mode:curationMode,query};
    setError('');
    findNeighbors(rpc,request,known,libraryScope,()=>active).then(items=>{
      if(!active)return;
      // Other branches may have finished while this request was in flight.
      const fresh=items.filter(child=>!known.has(child.recordId));
      fresh.forEach(child=>known.add(child.recordId));
      setChildren(fresh.map((child,i)=>({...child,path:[...item.path,i]})));
    },e=>{if(active)setError(e.message);});
    return ()=>{active=false;};
  },[ready,expanded,children,query,attempt,rpc,libraryScope,known,isRemoved,item.path,curationMode]);
  useEffect(()=>{
    if(!textTree&&expanded&&children?.length){
      const first=card.current?.nextElementSibling?.querySelector('.sw-canvas-card');
      first?.scrollIntoView({block:'nearest',inline:'nearest'});
    }
  },[expanded,children,textTree]);
  if(isRemoved&&!children?.length)return null;
  const title=item.title||t('未命名','Untitled');
  const status=expanded&&ready&&(error?<p role="alert">{error} <button onClick={()=>setAttempt(n=>n+1)}>{t('重试','Retry')}</button></p>:
        children===null?<p role="status">{t('正在找相近内容…','Finding related content…')}</p>:children.length===0?<p role="status">{t('没有找到更多相近内容','No further related content')}</p>:null);
  const branches=children?.map(child=><Branch key={child.recordId} item={child} known={known} ready={ready} libraryScope={libraryScope} rpc={rpc} t={t} onRead={onRead}/>);
  if(textTree)return <li>
    {!isRemoved&&<>
      <div className="mw-tree-row">
        <button type="button" className="mw-tree-toggle" aria-expanded={expanded} disabled={!ready}
          aria-label={(expanded?t('收起','Collapse'):t('展开','Expand'))+' · '+title} onClick={()=>setExpanded(!expanded)}>
          <span aria-hidden="true">{expanded?'▾':'▸'}</span>
        </button>
        <button type="button" className="mw-tree-source" onClick={()=>onRead(item)}>
          {root&&<small>{t('起点','Starting idea')}</small>}
          <strong>{title}</strong>{text&&text!==title&&<span>{text}</span>}
        </button>
        <label className="mw-tree-check"><input type="checkbox" aria-label={t('纳入大纲','Include in outline')+' · '+title}
          checked={selected.has(item.recordId)} onChange={()=>toggle(item)}/></label>
      </div>
      {status}
    </>}
    {branches?.length>0&&<ul className={isRemoved?'mw-tree-promoted':undefined} hidden={!expanded&&!isRemoved}>{branches}</ul>}
  </li>;
  return <div className={'sw-canvas-branch'+(isRemoved?' sw-canvas-promoted':'')}>
    <article hidden={isRemoved} ref={card} className={'sw-canvas-card'+(root?' sw-canvas-seed':'')}>
      <div className="sw-canvas-card-tools">
        <label><input type="checkbox" checked={selected.has(item.recordId)} aria-label={t('纳入大纲','Include in outline')+' · '+item.title} onChange={()=>toggle(item)}/>
        <small>{[root?t('起点','Starting idea'):kindLabel(item.kind,t),item.contentDay].filter(Boolean).join(' · ')}</small></label>
        <button type="button" title={t('从画布移除这张卡片','Remove this card from the canvas')} onClick={()=>remove(item)}>{t('移除','Remove')}</button>
      </div>
      <button type="button" className="sw-canvas-content" onClick={()=>onRead(item)}>
        <strong>{item.title||t('未命名','Untitled')}</strong>
        {text&&text!==item.title&&<span>{text}</span>}
      </button>
      <footer><button type="button" onClick={()=>onRead(item)}>{t('查看原文','Read source')}</button>
        <button type="button" disabled={!ready} aria-expanded={expanded} onClick={()=>setExpanded(!expanded)}>{expanded?t('收起','Collapse'):t('继续展开','Expand')}</button>
      </footer>
      {status}
    </article>
    {branches?.length>0&&<div className="sw-canvas-children" hidden={!expanded&&!isRemoved}>{branches}</div>}
  </div>;
}

export function IdeaCanvas({root,backLabel,libraryScope,search,rpc,t,MarkdownContent,newRequestId,onOpenArticle,onClose,localRelated=false,modeLabel,textTree=false}){
  const [source,setSource]=useState(null);
  const [selected,setSelected]=useState(()=>new Map());
  const [removed,setRemoved]=useState(()=>new Map());
  const [preview,setPreview]=useState(null),[saving,setSaving]=useState(false),[error,setError]=useState('');
  const requests=useRef(new Map()),inFlight=useRef(false);
  function toggle(item){
    setSelected(current=>{
      const next=new Map(current);
      if(next.has(item.recordId))next.delete(item.recordId);else next.set(item.recordId,item);
      return next;
    });
  }
  function remove(item){
    setRemoved(current=>new Map(current).set(item.recordId,{item,checked:selected.has(item.recordId)}));
    setSelected(current=>{const next=new Map(current);next.delete(item.recordId);return next;});
  }
  function undo(){
    const [id,last]=Array.from(removed).at(-1);
    setRemoved(current=>{const next=new Map(current);next.delete(id);return next;});
    if(last.checked)setSelected(current=>new Map(current).set(id,last.item));
  }
  async function generate(){
    if(!selected.size||inFlight.current||switched)return;
    inFlight.current=true;setSaving(true);setError('');
    try{
      const draft=canvasOutline(selected.values(),t);
      const key=JSON.stringify([draft.title,[...selected.keys()].sort()]);
      let requestId=requests.current.get(key);
      if(!requestId){requestId=newRequestId();requests.current.set(key,requestId);}
      if(!root.sourceLibraryId)throw Error(t('请从当前资料库重新打开。','Reopen from the current library.'));
      const record=await rpc('saveMarkdown',{...draft,kind:'article',stage:'draft',requestId,expectedLibraryId:root.sourceLibraryId});
      const saved=await rpc('readMarkdown',{id:record.id});
      if(saved.sourceLibraryId!==root.sourceLibraryId)throw Error(t('资料库已切换，请重新打开。','Library changed. Please reopen this view.'));
      setPreview(saved);
      window.dispatchEvent(new Event('shiwen-library-updated'));
    }catch(e){setError(e.message);}finally{inFlight.current=false;setSaving(false);}
  }
  const surface=useRef(null);
  const [fullscreen,setFullscreen]=useState(false);
  useEffect(()=>{
    const element=surface.current;
    const sync=()=>setFullscreen(document.fullscreenElement===element);
    element.addEventListener('fullscreenchange',sync);
    return ()=>element.removeEventListener('fullscreenchange',sync);
  },[]);
  function exitFullscreen(){
    if(document.fullscreenElement===surface.current){
      void document.exitFullscreen().catch(()=>setFullscreen(document.fullscreenElement===surface.current));
    }else{
      setFullscreen(false);
    }
  }
  function toggleFullscreen(){
    if(fullscreen){exitFullscreen();return;}
    setFullscreen(true);
    // Keep the edge-to-edge window layout when the host denies native fullscreen.
    if(document.fullscreenEnabled)void surface.current.requestFullscreen().catch(()=>{});
  }
  const [known]=useState(()=>new Set([root.id]));
  const scope=useRef(libraryScope);
  if(!scope.current&&search.status)scope.current=search.status.libraryScope;
  const ready=localRelated||Boolean(search.status?.canSearchSemantic);
  const switched=scope.current&&search.status&&scope.current!==search.status.libraryScope;
  const seed=useMemo(()=>({recordId:root.id,title:root.title,kind:root.kind,contentDay:root.contentDay,text:root.canvasText||root.markdown,path:[]}),[root]);
  const title=textTree?t('相关内容','Related content'):t('想法画布','Idea canvas');
  const readerBack=textTree?t('返回列表','Back to list'):t('返回画布','Back to canvas');
  const outlineActions=<><span aria-live="polite">{textTree?t(`已选 ${selected.size} 条`,`${selected.size} selected`):t('已选','Selected')+' '+selected.size}</span>
    <button type="button" className="sw-primary" disabled={!selected.size||saving} onClick={generate}>{saving?t('生成中…','Generating…'):t('生成文章大纲','Generate outline')}</button></>;
  const Tree=textTree?'ul':'div';
  return <Modal className={'sw-idea-canvas'+(textTree?' mw-related-list':'')+(fullscreen?' sw-canvas-fullscreen':'')} label={title} onClose={()=>{if(fullscreen)exitFullscreen();else if(!inFlight.current)onClose();}}>
    <div className="sw-canvas-surface" ref={surface}>
    <header><h2>{title}</h2><div className="sw-canvas-actions">
      {!textTree&&!switched&&outlineActions}
      {!textTree&&<button type="button" onClick={toggleFullscreen}>{fullscreen?t('退出全屏','Exit full screen'):t('全屏','Full screen')}</button>}
      <button autoFocus type="button" disabled={saving} onClick={onClose}>{backLabel||t('返回素材','Back to materials')}</button>
    </div></header>
    {modeLabel&&<small className="mw-canvas-mode">{modeLabel}</small>}
    {switched?<p role="alert">{t('资料库已切换，请重新打开。','Library changed. Please reopen this view.')}</p>:<>
      {!ready&&<div className="sw-canvas-status"><SemanticStatus search={search} t={t}/>{search.error&&<p role="alert">{search.error}</p>}</div>}
      {removed.size>0&&<div className="sw-canvas-removal"><span>{t('已移除','Removed')} · {Array.from(removed.values()).at(-1).item.title}</span><button onClick={undo} disabled={saving}>{t('撤销移除','Undo removal')}</button></div>}
      {error&&<p role="alert">{error}</p>}
      <div className={textTree?'mw-tree-scroll':'sw-canvas-viewport'} inert={saving||undefined} tabIndex={0} aria-label={textTree?title:t('画布分支','Canvas branches')}>
        <Curation.Provider value={{selected,removed,toggle,remove,textTree,curationMode:localRelated?'related':'semantic'}}>
          <Tree className={textTree?'mw-related-tree':'sw-canvas-tree'}>
            <Branch root item={seed} known={known} ready={ready} libraryScope={scope.current} rpc={rpc} t={t} onRead={setSource}/>
          </Tree>
        </Curation.Provider>
        {removed.size===known.size&&<p>{textTree?t('列表已清空','List is empty'):t('画布已清空','Canvas is empty')}</p>}
      </div>
      {textTree&&<footer className="mw-tree-footer">{outlineActions}</footer>}
      {preview&&<Modal className="sw-canvas-reader" label={t('文章大纲','Article outline')} onClose={()=>setPreview(null)}>
        <header><span>{t('已保存到创作草稿','Saved to writing drafts')}</span><div className="sw-canvas-actions">
          <button autoFocus onClick={()=>setPreview(null)}>{readerBack}</button>
          <button onClick={()=>onOpenArticle(preview.id,root.sourceLibraryId)}>{t('在创作中打开','Open in Writing')}</button>
        </div></header>
        <article><h2>{preview.title}</h2><MarkdownContent body={preview.markdown} record={preview}/></article>
      </Modal>}
      {source&&<SourceReader backLabel={readerBack} onRemove={textTree?()=>{remove(source);setSource(null);}:undefined} sourceLibraryId={root.sourceLibraryId} item={source} rpc={rpc} t={t} MarkdownContent={MarkdownContent} onClose={()=>setSource(null)}/>}
    </>}
    </div>
  </Modal>;
}
