import {BookIcon} from './reading/ReadingNotesPage.jsx';
import React,{useSyncExternalStore} from 'react';

const paths={
 chat:'M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9H13a8.5 8.5 0 0 1 8 8v.5Z',
 library:'m12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5',
 articles:'m16 3 5 5-12 12-6 1 1-6L16 3Zm-2 2 5 5',
 review:'M12 8v4l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z'
};
export function MobileNav({locale,layout}){
 const language=useSyncExternalStore(fn=>locale.subscribe(fn),()=>locale.getSnapshot().active);
 const active=useSyncExternalStore(fn=>layout.panelInfo.subscribe(fn),()=>layout.panelInfo.getSnapshot().activePanelId);
 const zh=String(language).startsWith('zh');
 return <nav className="sw-mobile-nav" aria-label={zh?'主导航':'Main navigation'}>
  {[[null,'chat','对话','Chat'],['shiwen-library','library','素材','Materials'],['shiwen-reading','reading','读书','Reading'],['shiwen-articles','articles','创作','Writing'],['shiwen-review','review','回顾','Review']].map(([id,icon,cn,en])=><button key={icon} type="button" aria-current={active===id?'page':undefined} onClick={()=>layout.selectPanel(id)}>{icon==='reading'?<BookIcon/>:<svg viewBox="0 0 24 24" aria-hidden="true"><path d={paths[icon]}/></svg>}<span>{zh?cn:en}</span></button>)}
 </nav>;
}
