import React,{useEffect,useRef} from 'react';

export function OverflowMenu({className,label,children}){
  const menu=useRef(null);
  const trigger=useRef(null);

  useEffect(()=>{
    const element=menu.current;
    function dismissOutside(event){
      if(element.open&&!element.contains(event.target))element.open=false;
    }
    document.addEventListener('pointerdown',dismissOutside,true);
    return ()=>document.removeEventListener('pointerdown',dismissOutside,true);
  },[]);

  function closeAndFocus(){
    menu.current.open=false;
    trigger.current.focus({preventScroll:true});
  }

  return <details className={'sw-overflow-menu '+className} name="sw-record-toolbar" ref={menu}
    onBlur={event=>{
      if(event.relatedTarget&&!event.currentTarget.contains(event.relatedTarget))menu.current.open=false;
    }}
    onKeyDown={event=>{
      if(event.key==='Escape'&&menu.current.open){
        event.preventDefault();
        event.stopPropagation();
        closeAndFocus();
      }
    }}>
    <summary ref={trigger} aria-label={label} title={label}>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
        <circle cx="3.5" cy="8" r="1.35"/><circle cx="8" cy="8" r="1.35"/><circle cx="12.5" cy="8" r="1.35"/>
      </svg>
    </summary>
    <div onClickCapture={event=>{if(event.target.closest('button:enabled'))closeAndFocus();}}>
      {children}
    </div>
  </details>;
}
