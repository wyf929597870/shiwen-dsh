import React,{useState} from 'react';
import {MessageDialog} from './MessageDialog.jsx';
import {MarkdownView} from './MarkdownView.jsx';
import {useI18n} from './i18n.js';

export function MessageBubble({role,text,onDirect,embedded=false,children}){
  const {t}=useI18n();
  const [open,setOpen]=useState(false),[kind,setKind]=useState(role==='user'?'idea':'ai');
  if(!text)return null;
  const activate=event=>{if(event.target.closest('a,button,input,select,textarea'))return;setOpen(true);};
  const key=event=>{if(event.target!==event.currentTarget)return;if(event.key==='Enter'||event.key===' '){event.preventDefault();setOpen(true);}};
  return <>
    <div className={`${embedded?'message-content':role==='user'?'user-message':'agent-message'} chat-message-tappable`} role="button" tabIndex={0} aria-label={t('点击消息保存到资料','Tap message to save to materials')} onClick={activate} onKeyDown={key}>
      {!embedded&&<span className="message-avatar" aria-hidden="true">{role==='user'?'我':<img src="./shiwen-mark.png" alt=""/>}</span>}<MarkdownView markdown={text}/>{children}
    </div>
    {open&&<MessageDialog title={t('保存这条消息','Save this message')} closeLabel={t('取消','Cancel')} onClose={()=>setOpen(false)}>
      <label className="message-save-kind">{t('记录类型','Note type')}<select value={kind} onChange={event=>setKind(event.target.value)}><option value="journal">{t('日记','Journal')}</option><option value="idea">{t('想法','Idea')}</option><option value="freewrite">{t('自由书写','Freewriting')}</option><option value="reading_note">{t('读书笔记','Reading note')}</option><option value="web">{t('网页','Web')}</option><option value="ai">{t('AI 讨论','AI discussion')}</option><option value="reference">{t('参考资料','Reference')}</option></select></label>
      <button className="primary" onClick={()=>{setOpen(false);onDirect?.(text,{kind,origin:role==='user'?'personal':'ai',submit:true});}}>{t('保存到资料','Save to materials')}</button>
    </MessageDialog>}
  </>;
}
