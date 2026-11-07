import React,{useEffect,useState} from 'react';
import {call} from '../bridge/library.mjs';
import {t,useI18n} from './i18n.js';

export function LocalAgentProfilePanel({ready,onPageStateChange}){
  useI18n();
  const [state,setState]=useState(null),[form,setForm]=useState({identity:'',soul:'',user:''}),[body,setBody]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const personaDirty=Boolean(state&&Object.keys(form).some(key=>form[key]!==state[key]));
  const dirty=personaDirty||Boolean(body.trim());
  const apply=result=>{setState(result);setForm({identity:result.identity,soul:result.soul,user:result.user});setError('');};
  useEffect(()=>{if(!ready)return;let active=true;call('localProfileRead').then(result=>active&&apply(result)).catch(e=>active&&setError(e.message));return()=>{active=false;};},[ready]);
  useEffect(()=>{onPageStateChange?.({dirty,busy});return()=>onPageStateChange?.({dirty:false,busy:false});},[dirty,busy,onPageStateChange]);
  const mutate=async(method,args)=>{if(!state||busy)return;setBusy(true);setError('');try{const result=await call(method,{expectedRevision:state.revision,...args});apply(result);if(method==='localMemoryDecide'&&args.action==='save')setBody('');}catch(e){setError(t('未确认保存，请保留编辑并重新读取核对。','Save not confirmed. Keep your edits and reload to check.')+' '+e.message);}finally{setBusy(false);}};
  return <section className="settings-card local-profile"><p className="secondary">{t('未选用服务器人设时使用此配置。修改后新建会话生效；候选记忆需要你确认。','Used when no server persona is selected. Start a new conversation after changes. Memory candidates need your confirmation.')}</p>
    {state&&<><label>IDENTITY<textarea maxLength={3000} disabled={busy} value={form.identity} onChange={event=>setForm({...form,identity:event.target.value})}/></label><label>SOUL<textarea maxLength={3000} disabled={busy} value={form.soul} onChange={event=>setForm({...form,soul:event.target.value})}/></label><label>USER<textarea maxLength={2000} disabled={busy} value={form.user} onChange={event=>setForm({...form,user:event.target.value})}/></label>
      <button className="primary" disabled={busy||!personaDirty||!form.identity.trim()} onClick={()=>mutate('localProfileSave',form)}>{t('保存人设','Save persona')}</button>
      <h3>{t('记忆','Memory')}</h3>{(state.memories??[]).map(item=><article className="management-row" key={item.id}><p>{item.body}</p><span className="state-pill">{item.status==='candidate'?t('待确认','Awaiting confirmation'):t('已确认','Confirmed')}</span><div className="node-actions">{item.status==='candidate'&&<button className="chip" disabled={busy||dirty} onClick={()=>mutate('localMemoryDecide',{id:item.id,action:'accept'})}>{t('确认记住','Confirm memory')}</button>}<button className="text" disabled={busy||dirty} onClick={()=>{if(window.confirm(t('移除此条记忆？','Remove this memory?')))mutate('localMemoryDecide',{id:item.id,action:item.status==='candidate'?'reject':'delete'});}}>{t('移除','Remove')}</button></div></article>)}
      <label>{t('明确记住的信息','Information to remember')}<textarea maxLength={2000} disabled={busy} value={body} onChange={event=>setBody(event.target.value)}/></label><button className="chip" disabled={busy||!body.trim()||Object.keys(form).some(key=>form[key]!==state[key])} onClick={()=>mutate('localMemoryDecide',{body:body.trim(),action:'save'})}>{t('保存为已确认记忆','Save as confirmed memory')}</button>
    </>}
    <button className="text" disabled={busy} onClick={async()=>{if(dirty&&!window.confirm(t('丢弃未保存编辑并重新读取？','Discard unsaved edits and reload?')))return;try{apply(await call('localProfileRead'));setBody('');}catch(e){setError(e.message);}}}>{t('重新读取','Reload')}</button>
    {error&&<p className="error" role="alert">{error}</p>}
  </section>;
}
