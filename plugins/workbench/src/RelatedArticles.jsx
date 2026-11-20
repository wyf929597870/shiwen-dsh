import React,{useEffect,useState} from 'react';

// A request survives the destination panel being mounted after panel selection.
const pendingRecords={};
const listeners={articles:new Set(),library:new Set(),collections:new Set(),reading:new Set()};
export function requestArticle(id,layout){
 requestRecord(id,layout,'articles');
}
export function requestRecord(id,layout,section='library',options=null){pendingRecords[section]=options?{id,...options}:id;layout.selectPanel(`shiwen-${section}`);for(const listener of listeners[section])listener();}
export function subscribeArticleRequests(listener,section='articles'){listeners[section].add(listener);return()=>listeners[section].delete(listener);}
export function takeArticleRequest(section='articles'){const id=pendingRecords[section];pendingRecords[section]=null;return id;}

export function RelatedArticles({id,rpc,t,onOpen}){
 const [state,setState]=useState({loading:true,items:[],error:''}),[retry,setRetry]=useState(0);
 useEffect(()=>{let active=true;setState({loading:true,items:[],error:''});rpc('relatedArticles',{id}).then(items=>{if(active)setState({loading:false,items,error:''});}).catch(error=>{if(active)setState({loading:false,items:[],error:error.message});});return()=>{active=false;};},[id,rpc,retry]);
 return <section className="sw-related-articles" aria-label={t('关联文章','Related articles')}><h3>{t('关联文章','Related articles')}</h3>
  {state.loading?<p role="status">{t('正在读取关联文章…','Loading related articles…')}</p>:state.error?<p role="alert">{t('读取关联文章失败：','Could not load related articles: ')}{state.error} <button type="button" onClick={()=>setRetry(value=>value+1)}>{t('重试','Retry')}</button></p>:state.items.length?<ul>{state.items.map(item=><li key={item.id}><button type="button" onClick={()=>onOpen(item.id)}>{item.title||t('未命名','Untitled')}</button><small>{item.stage==='final'?t('已定稿','Final'):t('创作中','In progress')}</small></li>)}</ul>:<p>{t('暂无关联文章','No related articles yet')}</p>}
 </section>;
}
