import React,{memo,useLayoutEffect,useRef,useState} from 'react';

// A bounded DOM is important even when React skips rendering: editing a textarea
// invalidates browser styles, and thousands of visible rows make that expensive.
export const MATERIAL_ROW_HEIGHT=104;
const OVERSCAN=5;
export const MaterialList=memo(function MaterialList({records,selected,onOpen,loading,loadingLabel,emptyLabel,untitled,unknown}){
 const viewport=useRef(null),pendingFocus=useRef(null);
 const [top,setTop]=useState(0),[height,setHeight]=useState(600);
 useLayoutEffect(()=>{
  const element=viewport.current,measure=()=>setHeight(element.clientHeight||600);
  measure();const observer=new ResizeObserver(measure);observer.observe(element);return()=>observer.disconnect();
 },[]);
 useLayoutEffect(()=>{viewport.current.scrollTop=0;setTop(0);pendingFocus.current=null;},[records]);
 const start=Math.max(0,Math.floor(Math.min(top,Math.max(0,records.length*MATERIAL_ROW_HEIGHT-height))/MATERIAL_ROW_HEIGHT)-OVERSCAN);
 const end=Math.min(records.length,start+Math.ceil(height/MATERIAL_ROW_HEIGHT)+OVERSCAN*2);
 useLayoutEffect(()=>{
  if(pendingFocus.current===null)return;
  const target=viewport.current.querySelector(`[data-material-index="${pendingFocus.current}"]`);
  if(target){target.focus({preventScroll:true});pendingFocus.current=null;}
 },[start,end]);
 const move=event=>{
  const button=event.target.closest('[data-material-index]');if(!button)return;
  const current=Number(button.dataset.materialIndex),next=({ArrowDown:current+1,ArrowUp:current-1,Home:0,End:records.length-1})[event.key];
  if(next===undefined||event.ctrlKey||event.altKey||event.metaKey||event.shiftKey)return;
  event.preventDefault();const index=Math.max(0,Math.min(records.length-1,next)),element=viewport.current;
  const rowTop=index*MATERIAL_ROW_HEIGHT,rowBottom=rowTop+MATERIAL_ROW_HEIGHT;
  if(rowTop<element.scrollTop)element.scrollTop=rowTop;
  else if(rowBottom>element.scrollTop+element.clientHeight)element.scrollTop=rowBottom-element.clientHeight;
  setTop(element.scrollTop);
  const target=element.querySelector(`[data-material-index="${index}"]`);
  if(target)target.focus({preventScroll:true});else pendingFocus.current=index;
 };
 return <div className="sw-list-items sw-virtual-materials" ref={viewport} onScroll={event=>setTop(event.currentTarget.scrollTop)} onKeyDown={move}>
  {loading&&<p className="sw-muted">{loadingLabel}</p>}
  {!loading&&!records.length&&<p className="sw-muted">{emptyLabel}</p>}
  <div aria-hidden="true" style={{height:start*MATERIAL_ROW_HEIGHT}}/>
  {records.slice(start,end).map((record,offset)=><button key={record.id} data-material-index={start+offset} onClick={()=>onOpen.current(record.id)} aria-current={selected===record.id?'true':undefined} title={record.title||untitled} className={'sw-row'+(selected===record.id?' selected':'')} style={{height:MATERIAL_ROW_HEIGHT,minHeight:MATERIAL_ROW_HEIGHT}}><strong>{record.title||untitled}</strong><small>{record.contentDay??unknown}</small></button>)}
  <div aria-hidden="true" style={{height:(records.length-end)*MATERIAL_ROW_HEIGHT}}/>
 </div>;
});
