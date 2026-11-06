import React,{useSyncExternalStore} from 'react';
import {tokens} from './palette.mjs';
import css from './style.css';
export const inject=['theme','slots','locale'];
const Mark=({size=24})=> <img className="shiwen-sidebar-mark" src="/shiwen-brand.png" width={size} height={size} alt=""/>;
const Brand=()=> <span className="shiwen-wordmark">拾文</span>;
export function apply(ctx){
  ctx.effect(()=>ctx.theme.overrideTokens('@shiwen/dsh-theme',tokens));
  ctx.effect(()=>{const previous=document.title;document.title='拾文 · Shiwen';return()=>{document.title=previous;};});
  ctx.effect(()=>{const style=document.createElement('style');style.dataset.plugin='@shiwen/dsh-theme';style.textContent=css;document.head.append(style);return()=>style.remove();});
  ctx.slots.inject('sidebar.brand.mark',()=>ctx.slots.register({name:'sidebar.brand.mark'},Mark));
  ctx.slots.inject('sidebar.brand.name',()=>ctx.slots.register({name:'sidebar.brand.name'},Brand));
  const Hero=()=>{
    const lang=useSyncExternalStore(callback=>ctx.locale.subscribe(callback),()=>ctx.locale.getSnapshot().active,()=>ctx.locale.getSnapshot().active);
    const zh=String(lang).startsWith('zh');
    return <div className="shiwen-hero"><img src="/shiwen-brand.png" width="72" height="72" alt=""/><div><h1>{zh?'从一个想法开始':'Start with a thought'}</h1><p>{zh?'记录日常，整理所见，把值得留下的想法写下来。':'Capture your days, collect ideas, and develop them into writing.'}</p></div></div>;
  };
  ctx.slots.inject('conversation.hero.brand.mark',()=>ctx.slots.register({name:'conversation.hero.brand.mark'},Hero));
}
