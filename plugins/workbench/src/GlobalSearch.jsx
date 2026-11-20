import React,{useState} from 'react';
import {SearchControls,SearchResults,useContentSearch} from './ContentSearch.jsx';
import {requestRecord} from './RelatedArticles.jsx';
import {recordSection} from '../../library/legacy/record-sections.mjs';

export function GlobalSearch({rpc,t,layout}){
  const [query,setQuery]=useState('');
  const search=useContentSearch(rpc,'global',query,{});
  function open(item){
    requestRecord(item.recordId,layout,recordSection(item.kind),{
      item,request:search.request,libraryScope:search.result.libraryScope
    });
  }
  return <main className="sw-view sw-global-search"><div className="sw-head"><h1>{t('全局搜索','Global search')}</h1></div>
    <div className="sw-toolbar"><input autoFocus type="search" aria-label={t('全局搜索','Global search')}
      placeholder={t('搜索记录、读书、收藏和创作','Search records, reading, collections and writing')} value={query}
      onChange={e=>setQuery(e.target.value)} onCompositionStart={()=>search.setComposing(true)}
      onCompositionEnd={e=>{setQuery(e.currentTarget.value);search.setComposing(false);}}/></div>
    <SearchControls search={search} t={t}/>
    {query.trim()&&<SearchResults search={search} t={t} onOpen={open}/>}
  </main>;
}
