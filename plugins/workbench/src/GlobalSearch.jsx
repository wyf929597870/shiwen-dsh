import React,{useEffect,useRef,useState} from 'react';
import {SearchControls,SearchResults,useContentSearch} from './ContentSearch.jsx';
import {requestRecord} from './RelatedArticles.jsx';
import {recordSection} from '../../library/legacy/record-sections.mjs';

export function GlobalSearch({rpc,t,layout,inTopBar=false}){
  const [query,setQuery]=useState('');
  const [expanded,setExpanded]=useState(false);
  const container=useRef(null),input=useRef(null);
  const search=useContentSearch(rpc,'global',query,{},!inTopBar||expanded);
  useEffect(()=>{
    if(!expanded)return;
    const dismiss=event=>{if(!container.current?.contains(event.target))setExpanded(false);};
    document.addEventListener('pointerdown',dismiss,true);
    return ()=>document.removeEventListener('pointerdown',dismiss,true);
  },[expanded]);
  function open(item){
    if(inTopBar)setExpanded(false);
    requestRecord(item.recordId,layout,recordSection(item.kind),{
      item,request:search.request,libraryScope:search.result.libraryScope
    });
  }
  const field=<input ref={input} autoFocus={!inTopBar} type="search" aria-label={t('全局搜索','Global search')}
    placeholder={inTopBar?t('全局搜索…','Global search…'):t('搜索记录、读书、收藏和创作','Search records, reading, collections and writing')}
    value={query} onFocus={()=>{if(inTopBar)setExpanded(true);}} onClick={()=>{if(inTopBar)setExpanded(true);}}
    onChange={event=>{setQuery(event.target.value);if(inTopBar)setExpanded(true);}}
    onCompositionStart={()=>search.setComposing(true)}
    onCompositionEnd={event=>{setQuery(event.currentTarget.value);search.setComposing(false);}}/>;
  const results=<><SearchControls search={search} t={t}/>
    {query.trim()&&<SearchResults search={search} t={t} onOpen={open}/>}</>;
  if(inTopBar)return <div className="sw-bar-search" ref={container}
    onBlur={event=>{if(!event.currentTarget.contains(event.relatedTarget))setExpanded(false);}}
    onKeyDown={event=>{
      if(event.nativeEvent.isComposing||event.keyCode===229)return;
      if(event.key==='Escape'&&expanded){
        event.preventDefault();event.stopPropagation();input.current.focus();setExpanded(false);
      }else if(event.key==='Enter'&&event.target===input.current){
        event.preventDefault();
        if(expanded&&search.result?.items.length)open(search.result.items[0]);
        else setExpanded(true);
      }
    }}>
    <div className="sw-bar-search-field" role="search">{field}
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><circle cx="10" cy="10" r="6.5"/><path d="m15 15 6 6"/></svg>
    </div>
    {expanded&&<div className="sw-bar-results">{results}</div>}
  </div>;
  return <main className="sw-view sw-global-search"><div className="sw-head"><h1>{t('全局搜索','Global search')}</h1></div>
    <div className="sw-toolbar">{field}</div>{results}
  </main>;
}
