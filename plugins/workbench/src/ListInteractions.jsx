import React,{useEffect,useRef,useState} from 'react';

// The phone gesture controller asks only the foreground surface for a read.
export function usePullRefresh(read, enabled=true) {
  const ref=useRef(null);
  useEffect(()=>{
    if(!enabled)return;
    function register({detail}) {
      if(ref.current?.isConnected && ref.current.closest('dialog')===detail.dialog)detail.reads.push(read);
    }
    window.addEventListener('shiwen-query-refresh',register);
    return ()=>window.removeEventListener('shiwen-query-refresh',register);
  },[enabled,read]);
  return ref;
}

export function MoreRows({cursor,onClick,disabled=false,children,...props}) {
  const ref=useRef(null), pending=useRef(false), attempted=useRef(null);
  const [busy,setBusy]=useState(false);
  async function next(){
    if(disabled||pending.current)return;
    attempted.current=cursor;
    pending.current=true;
    setBusy(true);
    try{await onClick();}finally{pending.current=false;setBusy(false);}
  }
  useEffect(()=>{
    if(disabled||busy||attempted.current===cursor||!document.querySelector('.app > .shell-header')||!window.IntersectionObserver)return;
    const button=ref.current;
    const observer=new IntersectionObserver(entries=>{
      if(entries.some(entry=>entry.isIntersecting)&&attempted.current!==cursor)void next();
    },{root:button.closest('dialog')||button.closest('.app > main'),rootMargin:'0px 0px 100px'});
    observer.observe(button);
    return ()=>observer.disconnect();
  },[cursor,disabled,busy,onClick]);
  return <button {...props} type="button" ref={ref} disabled={disabled||busy} aria-busy={busy||undefined} onClick={next}>{children}</button>;
}
