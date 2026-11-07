import React,{useCallback,useEffect,useState} from 'react';
import {call} from '../bridge/library.mjs';
import {useI18n} from './i18n.js';

const localDay=()=>{const date=new Date();return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;};
const safeUrl=value=>{try{const url=new URL(value);return ['https:','http:'].includes(url.protocol)?url.href:null;}catch{return null;}};

export function ShareInboxPanel({ready,libraryId,libraries=[],onPageStateChange}){
  const {t}=useI18n();
  const [items,setItems]=useState([]),[forms,setForms]=useState({}),[collapsed,setCollapsed]=useState(new Set());
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState('');
  useEffect(()=>{onPageStateChange?.({dirty:false,busy});},[busy,onPageStateChange]);
  const refresh=useCallback(async()=>{
    try{const snapshot=await call('shareInboxList');setItems(snapshot.items||[]);setError('');}
    catch(e){setError(String(e?.message||e));}
  },[]);
  useEffect(()=>{if(ready)refresh();},[ready,refresh]);
  const formFor=item=>{
    const frozen=item.pendingRecord;
    const existing=forms[item.id];
    if(frozen)return {...frozen,targetLibraryId:item.pendingTargetLibraryId||libraryId};
    if(existing)return existing;
    const markdown=item.text||item.url||'';
    const date=(item.receivedAt||'').slice(0,10)||localDay();
    return {title:item.title||markdown.split('\n')[0]?.slice(0,120)||t('来自其他应用','From another app'),markdown,
      kind:item.url?'web':'reference',origin:'external',processing:'original',contentDay:date,url:item.url||null,
      targetLibraryId:item.pendingTargetLibraryId||libraryId};
  };
  const setForm=(item,key,value)=>setForms(old=>({...old,[item.id]:{...formFor(item),[key]:value}}));
  const save=async item=>{
    if(busy||!ready)return;
    const data=formFor(item);
    setBusy(true);setError('');setMessage('');
    try{
      const result=await call('shareInboxSave',{id:item.id,targetLibraryId:item.pendingTargetLibraryId||data.targetLibraryId,
        record:item.pendingRecord||{title:data.title.trim(),markdown:data.markdown,kind:data.kind,origin:data.origin,
          processing:data.processing,contentDay:data.contentDay,url:data.url}});
      setItems(rows=>rows.filter(row=>row.id!==item.id));
      setForms(old=>{const next={...old};delete next[item.id];return next;});
      setMessage(`${t('已保存到资料库','Saved to library')} · ${libraries.find(row=>row.libraryId===result.libraryId)?.name||result.libraryId}`);
    }catch(e){setError(String(e?.message||e));await refresh();}
    finally{setBusy(false);}
  };
  const dismiss=async item=>{
    if(!window.confirm(t('丢弃这条分享内容？此操作会从收件箱移除。','Discard this shared item? It will be removed from the inbox.')))return;
    setBusy(true);setError('');
    try{await call('shareInboxDismiss',{id:item.id});setItems(rows=>rows.filter(row=>row.id!==item.id));setMessage(t('已从收件箱移除。','Removed from the inbox.'));}
    catch(e){setError(String(e?.message||e));}
    finally{setBusy(false);}
  };
  const later=item=>setCollapsed(old=>new Set(old).add(item.id));
  const reopen=()=>setCollapsed(new Set());
  return <section className="settings-card share-inbox">
    <div className="settings-heading"><div><h2>{t('来自其他应用','Shared from other apps')}</h2><p className="secondary">{t('收到的文字与链接会先在这里预览，只有确认保存后才写入资料库。','Shared text and links are previewed here. Nothing enters a library until you save it.')}</p></div><button className="chip" disabled={busy} onClick={refresh}>{t('刷新','Refresh')}</button></div>
    {collapsed.size>0&&<button className="text" onClick={reopen}>{t('显示稍后处理的内容','Show items for later')}</button>}
    {items.filter(item=>!collapsed.has(item.id)).map(item=>{
      const form=formFor(item),frozen=Boolean(item.pendingRecord),targetId=item.pendingTargetLibraryId||form.targetLibraryId;
      return <article className="share-inbox-item" key={item.id}>
        <div className="settings-heading"><div><h3>{item.title||t('来自其他应用','From another app')}</h3><p className="secondary">{item.receivedAt}</p></div>{frozen&&<span className="state-pill">{t('保存内容已冻结','Save is pending')}</span>}</div>
        {item.url&&<p className="record-source"><span>{t('链接','Link')}</span>{safeUrl(item.url)?<a href={safeUrl(item.url)} target="_blank" rel="noreferrer">{item.url}</a>:<span>{item.url}</span>}</p>}
        <details className="share-preview"><summary>{t('预览原文','Preview shared text')}</summary><pre>{item.text}</pre></details>
        <label>{t('保存标题','Title')}<input value={form.title} disabled={busy||frozen} maxLength={200} onChange={e=>setForm(item,'title',e.target.value)}/></label>
        <label>{t('正文','Content')}<textarea value={form.markdown} disabled={busy||frozen} maxLength={1_000_000} onChange={e=>setForm(item,'markdown',e.target.value)}/></label>
        <div className="record-form-grid"><label>{t('目标资料库','Target library')}<select value={targetId||''} disabled={busy||frozen||libraries.length===0} onChange={e=>setForm(item,'targetLibraryId',e.target.value)}>{libraries.map(row=><option key={row.libraryId} value={row.libraryId}>{row.name}</option>)}</select></label><label>{t('素材类型','Material type')}<select value={form.kind} disabled={busy||frozen} onChange={e=>setForm(item,'kind',e.target.value)}><option value="web">{t('网页','Web')}</option><option value="reference">{t('参考资料','Reference')}</option><option value="idea">{t('想法','Idea')}</option></select></label><label>{t('内容来源','Content source')}<select value={form.origin} disabled={busy||frozen} onChange={e=>setForm(item,'origin',e.target.value)}><option value="external">{t('外部资料','External source')}</option><option value="personal">{t('自己书写','Written by me')}</option></select></label></div>
        <div className="node-actions"><button className="primary" disabled={!ready||busy||!targetId||(!form.markdown.trim()&&!form.url)} onClick={()=>save(item)}>{frozen?t('用原内容重试保存','Retry saving original content'):t('保存到资料库','Save to library')}</button><button className="chip" disabled={busy} onClick={()=>later(item)}>{t('稍后','Later')}</button><button className="text" disabled={busy} onClick={()=>dismiss(item)}>{t('丢弃','Discard')}</button></div>
      </article>;
    })}
    {items.length===0&&<p className="empty-state">{t('收件箱为空。','The inbox is empty.')}</p>}
    {message&&<p className="success-note" role="status">{message}</p>}{error&&<p className="error" role="alert">{error}</p>}
  </section>;
}
