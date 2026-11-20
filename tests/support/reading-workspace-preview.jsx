import React,{useCallback,useEffect,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import MarkdownIt from 'markdown-it';
import {ReadingNotesPage} from '../../plugins/workbench/src/reading/ReadingNotesPage.jsx';
import {desktopReadingNotes} from '../../plugins/workbench/src/reading/adapters.mjs';
import {WritingSources} from '../../plugins/workbench/src/WritingSources.jsx';
import {insertSourceQuote} from '../../plugins/workbench/src/writing-source-helpers.mjs';
import '../../plugins/workbench/src/style.css';
import '../../plugins/workbench/src/reading/reading-notes.css';
import '../../plugins/workbench/src/reading/reading-notes-mobile.css';
import '../../plugins/workbench/src/writing-sources.css';
import './reading-notes-preview.css';
import './reading-workspace-preview.css';
const rpc=async(method,args={})=>{const response=await fetch('/rpc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({method,args})});const value=await response.json();if(!response.ok)throw Error(value.error);return value.result;};
const api=desktopReadingNotes(rpc),md=new MarkdownIt({html:false,breaks:true});
const initialBody='写作不只是把话记下来，更是把思路整理清楚。\n\n## 从表达之前开始\n\n说话时，我们可以借助语气、表情和情境。写下来以后，文字需要自己承担这些工作。\n\n';
function MarkdownContent({body}){return <div className="sw-markdown" dangerouslySetInnerHTML={{__html:md.render(body||'')}}/>;}
function WritingPreview(){
 const [records,setRecords]=useState([]),[ids,setIds]=useState([]),[body,setBody]=useState(initialBody),[sources,setSources]=useState([{text:initialBody,origin:'personal'}]),[show,setShow]=useState(true);
 const cursor=useRef(initialBody.length),editor=useRef(null);
 useEffect(()=>{api.list().then(data=>setRecords(data.records.map(row=>({...row,body:row.markdown}))));},[]);
 const remember=e=>{cursor.current=e.currentTarget.selectionEnd;};
 const quote=(source,text)=>{const result=insertSourceQuote(body,cursor.current,ids,source,text);setBody(result.body);setIds(result.sources);cursor.current=result.cursor;requestAnimationFrame(()=>{editor.current?.focus();editor.current?.setSelectionRange(result.cursor,result.cursor);});};
 return <section className={`sw-view sw-library-view sw-writing-mode ${show?'sw-writing-open':''}`}><header className="acceptance-writing-heading"><strong>创作</strong><span>文章草稿</span><button onClick={()=>setShow(!show)}>写作素材</button></header><div className="sw-columns"><section className="sw-detail"><div className="sw-editor"><label className="sw-editor-title"><span>标题</span><input defaultValue="把想法写清楚"/></label><p className="sw-meta">草稿 · 独立验收数据</p><label className="sw-editor-body"><span>正文</span><textarea ref={editor} aria-label="文章正文" value={body} onChange={e=>{setBody(e.target.value);setSources([{text:e.target.value,origin:'personal'}]);}} onSelect={remember} onBlur={remember}/></label><p className="sw-meta" role="status">已关联 {ids.length} 条素材 · 此预览不保存文章</p></div></section>{show&&<section className="sw-writing-sidebar"><WritingSources records={records} selectedIds={ids} onChange={setIds} onQuote={quote} onClose={()=>setShow(false)} rpc={rpc} MarkdownContent={MarkdownContent} zh={true} disabled={false}/></section>}</div></section>;
}
function App(){
 const params=new URLSearchParams(location.search),[view,setView]=useState(params.get('view')==='writing'?'writing':'reading'),[pageState,setPageState]=useState({});
 const updateState=useCallback(value=>setPageState(value),[]);
 if(params.has('light'))document.documentElement.dataset.previewTheme='light';else document.documentElement.dataset.theme='dark';
 const frame=Number(params.get('frame'));
 if([360,390,412,760,900].includes(frame))return <main className="acceptance-device-stage"><iframe title={`${frame}px 阅读验收`} style={{width:frame,height:844}} src={`/?${params.has('light')?'light&':''}embedded`}/></main>;
 return <div className={`reading-preview-shell acceptance-shell ${pageState.depth?'is-reading-child':''}`}><aside><div className="preview-brand"><img src="/logo.png" alt="拾文"/></div><nav aria-label="验收导航"><button aria-current={view==='reading'?'page':undefined} onClick={()=>setView('reading')}>读书</button><button className="acceptance-writing-nav" aria-current={view==='writing'?'page':undefined} onClick={()=>setView('writing')}>创作</button></nav><small>隔离测试</small></aside><div className="preview-content">{view==='reading'?<ReadingNotesPage api={api} onPageStateChange={updateState}/>:<WritingPreview/>}</div></div>;
}
createRoot(document.getElementById('root')).render(<App/>);
