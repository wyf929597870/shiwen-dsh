import React,{useSyncExternalStore} from 'react';
import {brandedTitle} from './title.mjs';
import {tokens} from './palette.mjs';
import css from './style.css';
export const inject=['theme','slots','locale'];
const Mark=({size=24})=> <img className="shiwen-sidebar-mark" src="/shiwen-brand.png" width={size} height={size} alt=""/>;
const Brand=()=> <span className="shiwen-wordmark">拾文 <small title={`Shiwen Web v${__SHIWEN_VERSION__}`}>v{__SHIWEN_VERSION__}</small></span>;
export function apply(ctx){
  ctx.effect(()=>ctx.theme.overrideTokens('@shiwen/dsh-theme',tokens));
  // DSH owns the session title and has no runtime product-title setter.
  // Normalize only its product suffix, preserving session names and other plugins' titles.
  ctx.effect(()=>{
    const sync=()=>{const title=brandedTitle(document.title);if(title!==document.title)document.title=title;};
    sync();const observer=new MutationObserver(sync);
    observer.observe(document.head,{childList:true,subtree:true,characterData:true});
    return()=>observer.disconnect();
  });
  ctx.effect(()=>{const style=document.createElement('style');style.dataset.plugin='@shiwen/dsh-theme';style.textContent=css;document.head.append(style);return()=>style.remove();});
  ctx.slots.inject('sidebar.brand.mark',()=>ctx.slots.register({name:'sidebar.brand.mark'},Mark));
  ctx.slots.inject('sidebar.brand.name',()=>ctx.slots.register({name:'sidebar.brand.name'},Brand));
  const Hero=()=>{
    const lang=useSyncExternalStore(callback=>ctx.locale.subscribe(callback),()=>ctx.locale.getSnapshot().active,()=>ctx.locale.getSnapshot().active);
    const zh=String(lang).startsWith('zh');
    return <div className="shiwen-hero"><img src="/shiwen-brand.png" width="72" height="72" alt=""/><div><h1>{zh?'今天，记下些什么':'What would you like to capture?' }</h1><p>{zh?'和皮皮聊聊，记录日常、整理资料，或继续一篇文章。':'Talk to Pipi, capture your day, explore your library, or keep writing.'}</p><time>{new Date().toLocaleDateString(zh?'zh-CN':'en-US',{month:'long',day:'numeric',weekday:'long'})}</time></div></div>;
  };
  ctx.slots.inject('conversation.hero.brand.mark',()=>ctx.slots.register({name:'conversation.hero.brand.mark'},Hero));
}
