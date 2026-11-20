import React from 'react';
import {createRoot} from 'react-dom/client';
import {WritingSources} from '../../plugins/workbench/src/WritingSources.jsx';
import {encodeReadingNote} from '../../plugins/library/legacy/reading-note.mjs';
const annotation=encodeReadingNote({excerpts:[{text:'旧摘录',page:'1'}]});let record={id:'n1',revision:1,title:'书',kind:'reading_note',markdown:'感想',annotation},quoted=0;
const rpc=async method=>method==='readingNoteList'?{records:[record]}:method==='readMarkdown'?record:method==='contentSearchStatus'?{libraryScope:'test',state:'disabled'}:null;
function Fixture(){return <WritingSources records={[record]} selectedIds={[]} onChange={()=>{}} onQuote={()=>quoted++} onClose={()=>{}} rpc={rpc} MarkdownContent={({body})=><p>{body}</p>} zh disabled={false}/>}
createRoot(document.getElementById('root')).render(<Fixture/>);
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
(async()=>{try{await wait(150);const open=[...document.querySelectorAll('button')].find(b=>b.textContent.includes('旧摘录'));if(!open)throw Error('missing card');open.click();await wait(50);record={...record,revision:2,annotation:encodeReadingNote({excerpts:[{text:'新摘录',page:'2'}]})};const insert=[...document.querySelectorAll('button')].find(b=>b.textContent==='插入引用');if(!insert||insert.disabled)throw Error('initial quote unavailable');insert.click();await wait(60);if(quoted)throw Error('stale quote inserted');if(!document.body.textContent.includes('原文已变化')||!insert.disabled)throw Error('changed source not guarded');if(!document.body.textContent.includes('新摘录'))throw Error('fresh source not shown');document.getElementById('result').textContent=JSON.stringify({passed:true});}catch(error){document.getElementById('result').textContent=JSON.stringify({passed:false,error:error.message});}})();
