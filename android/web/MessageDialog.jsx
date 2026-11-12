import React, {useEffect, useRef} from 'react';
import {useI18n} from './i18n.js';
import './message-dialog.css';

export function MessageDialog({message, onClose, title, children, closeLabel}) {
  const {t}=useI18n();
  const button=useRef(null);
  useEffect(()=>{
    if(!message&&!children)return;
    const previous=document.activeElement;
    const previousBack=window.__shiwenModalBack;
    window.__shiwenModalBack=onClose;
    button.current?.focus();
    const key=event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();onClose();}};
    document.addEventListener('keydown',key,true);
    return()=>{document.removeEventListener('keydown',key,true);if(window.__shiwenModalBack===onClose)window.__shiwenModalBack=previousBack;previous?.focus?.();};
  },[message,children,onClose]);
  if(!message&&!children)return null;
  return <div className="message-dialog-backdrop"><section className="message-dialog" role="alertdialog" aria-modal="true" aria-label={title||t('提示','Notice')}>
    <h2>{title||t('提示','Notice')}</h2>{message&&<p>{message}</p>}{children}
    <button ref={button} type="button" className="primary" onClick={onClose}>{closeLabel||t('知道了','OK')}</button>
  </section></div>;
}
