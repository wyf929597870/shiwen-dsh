import React,{useMemo,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ReadingNotesPage,BookIcon} from '../../plugins/workbench/src/reading/ReadingNotesPage.jsx';
import {desktopReadingNotes} from '../../plugins/workbench/src/reading/adapters.mjs';
import {ReviewPage} from '../../plugins/workbench/src/ReviewPage.jsx';
import MarkdownIt from 'markdown-it';
import '../../plugins/workbench/src/style.css';
import '../../plugins/workbench/src/review-goals.css';
import '../../plugins/workbench/src/reading/reading-notes.css';
import './reading-notes-preview.css';
const rpc=async(method,args={})=>{const response=await fetch('/rpc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({method,args})});const value=await response.json();if(!response.ok)throw Error(value.error);return value.result;};
const api=desktopReadingNotes(rpc),md=new MarkdownIt({html:false});
async function start(){
 if(new URLSearchParams(location.search).has('design')){
  const data=await api.list(),key=`shiwen-reading-notes:${location.origin}:${data.scope}`;
  if(!localStorage.getItem(key))localStorage.setItem(key,JSON.stringify({dirty:true,form:{book:'写作这回事',day:'2026-11-10',chapter:'',page:'',excerpts:[],reflection:'这几天读《写作这回事》，最有启发的是关于具体场景的写法。好的场景不是交代发生了什么，而是通过可感的细节，让读者自然进入情境，看到人物在其中的动作、反应和选择。\n\n我也意识到，日常生活中有很多值得留意的细节：比如街上人说话的语气、店里的光线与气味、一件小事带来的情绪变化。平时多观察并做简短记录，写作时就能更快调动出具体而真实的画面。\n\n对我来说，写作不必追求宏大的主题，从身边的场景和细节出发，就足以写出有层次、有温度的内容。'}}));
 }
 function App(){const [view,setView]=useState('reading');return <div className="reading-preview-shell"><aside><div className="preview-brand"><img src="/logo.png" alt=""/><strong>拾文</strong></div><nav aria-label="主导航"><button disabled title="请在完整应用中使用">素材</button><button aria-current={view==='reading'?'page':undefined} onClick={()=>setView('reading')}><BookIcon/>读书笔记</button><button disabled title="请在完整应用中使用">创作</button><button aria-current={view==='review'?'page':undefined} onClick={()=>setView('review')}>回顾</button></nav><small>独立测试资料库</small></aside><div className="preview-content">{view==='reading'?<ReadingNotesPage api={api}/>:<ReviewPage rpc={rpc} language="zh" md={md} typeName={kind=>kind==='reading_note'?'读书笔记':kind}/>}</div></div>;}
 createRoot(document.getElementById('root')).render(<App/>);
}
start().catch(error=>{document.getElementById('root').textContent=error.message;});
