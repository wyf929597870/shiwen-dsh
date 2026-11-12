import {MessageDialog} from './MessageDialog.jsx';
import React,{useEffect,useRef,useState} from 'react';
import {call} from '../bridge/library.mjs';
import {MarkdownView} from './MarkdownView.jsx';
import {t,useI18n} from './i18n.js';

export function AgentProposals({conversationId,onRead}){
  useI18n();
  const [items,setItems]=useState([]),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const [selected,setSelected]=useState(null),[receipt,setReceipt]=useState(null),seen=useRef(new Set());
  useEffect(()=>{let mounted=true,pending=false;
    const load=async()=>{if(pending||document.visibilityState==='hidden')return;pending=true;try{const result=await call('agentRecordProposals',{conversationId});if(mounted){setItems(result.items??[]);setError('');}}catch(e){if(mounted)setError(e.message);}finally{pending=false;}};
    load();const timer=setInterval(load,3500);return()=>{mounted=false;clearInterval(timer);};
  },[conversationId]);
  useEffect(()=>{seen.current=new Set();setSelected(null);setReceipt(null);},[conversationId]);
  useEffect(()=>{const fresh=items.filter(item=>item.status==='pending'&&!seen.current.has(item.id));if(!fresh.length)return;fresh.forEach(item=>seen.current.add(item.id));setSelected(current=>current||fresh[0].id);},[items]);
  const decide=async(item,accept)=>{
    if(busy)return;setBusy(true);setError('');
    try{const result=await call('agentRecordDecide',{conversationId,id:item.id,accept});setItems(rows=>rows.map(row=>row.id===item.id?result:row));setSelected(null);if(accept&&result.status==='applied')setReceipt(result);}
    catch(e){setError(t('操作结果待核对，建议仍保留；可使用同一条建议再次查询。','Result needs checking. The proposal is preserved; retry this same proposal.')+' '+e.message);}
    finally{setBusy(false);}
  };
  const pending=items.filter(item=>item.status==='pending'),item=pending.find(row=>row.id===selected);
  if(!pending.length&&!receipt&&!error)return null;
  return <section className="agent-proposals" aria-label={t('资料操作建议','Proposed library actions')}>
    {pending.length>0&&<button className="chip" onClick={()=>setSelected(pending[0].id)}>{t(`待确认的资料操作（${pending.length}）`,`Pending library actions (${pending.length})`)}</button>}
    {item&&<MessageDialog title={t('确认资料操作','Review library action')} onClose={()=>setSelected(null)}>
      {pending.length>1&&<label>{t('选择建议','Choose a proposal')}<select value={item.id} disabled={busy} onChange={event=>setSelected(event.target.value)}>{pending.map(row=><option key={row.id} value={row.id}>{row.patch?.title||row.beforeTitle||t('未命名','Untitled')}</option>)}</select></label>}
      <article><strong>{({create:t('保存新记录','Save a new record'),update:t('修改记录','Update record'),delete:t('移入回收站','Move to trash'),restore:t('恢复记录','Restore record')})[item.action]}</strong>
        <p>{item.patch?.title||item.beforeTitle||t('未命名','Untitled')}</p><p>{t('尚未执行，请核对后决定。','Not applied. Review and decide below.')}</p>
        {item.patch?.markdown&&<details><summary>{t('查看建议正文（AI 内容）','View proposed content (AI content)')}</summary><MarkdownView markdown={item.patch.markdown}/></details>}
        {item.beforeMarkdown&&<details><summary>{t('查看当前正文','View current content')}</summary><MarkdownView markdown={item.beforeMarkdown}/>{item.beforeTruncated&&<small>{t('此处仅预览正文前段。','Only the beginning is previewed here.')}</small>}</details>}
        {Object.entries(item.patch??{}).filter(([key])=>!['title','markdown'].includes(key)).map(([key,value])=><p key={key}>{key}：{String(value)}</p>)}
        <div className="profile-actions"><button className="chip" disabled={busy} onClick={()=>decide(item,false)}>{t('拒绝','Reject')}</button><button className="primary" disabled={busy||item.action==='delete'||item.action==='restore'} onClick={()=>decide(item,true)}>{t('确认执行','Apply this change')}</button></div>
      </article>
    </MessageDialog>}
    {receipt&&<MessageDialog message={t('资料操作已完成。','Library action completed.')} onClose={()=>setReceipt(null)}>{receipt.action!=='delete'&&<button className="chip" onClick={()=>{setReceipt(null);onRead?.(receipt.recordId);}}>{t('查看记录','Read record')}</button>}</MessageDialog>}
    {error&&<MessageDialog message={error} onClose={()=>setError('')}/>}
  </section>;
}
