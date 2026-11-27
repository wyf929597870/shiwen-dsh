import React,{useEffect,useState} from 'react';
import {createPortal} from 'react-dom';
import {PhoneIcon} from './PhoneIcon.jsx';
import {useI18n} from './i18n.js';

// Hit testing respects the browser's modal top layer even with nested portals.
export function topDialog(){
  if(!document.querySelector('dialog[open]'))return null;
  return document.elementFromPoint(innerWidth/2,innerHeight/2)?.closest('dialog[open]')||
    [...document.querySelectorAll('dialog[open]')].at(-1);
}

function refreshReads(dialog){
  const detail={dialog,reads:[]};
  window.dispatchEvent(new CustomEvent('shiwen-query-refresh',{detail}));
  return detail.reads;
}
function atTop(node,surface){
  for(let element=node;element;element=element.parentElement){
    if(element.scrollTop>1 && /auto|scroll/.test(getComputedStyle(element).overflowY))return false;
    if(element===surface)return true;
  }
  return false;
}

export function PhoneGestures(){
  const [feedback,setFeedback]=useState(null);
  const {t}=useI18n();
  useEffect(()=>{
    let start=null,refreshing=false,active=true;
    function begin(e){
      cancel();
      if(e.touches.length!==1||e.target.closest('textarea,input,select,[contenteditable=true],.sw-canvas-surface'))return;
      const point=e.touches[0],dialog=topDialog(),surface=dialog||e.target.closest('.app > main');
      const pull=surface&&!document.querySelector('.message-dialog,.session-sheet,.library-sheet')&&atTop(e.target,surface)&&!refreshing&&refreshReads(dialog).length>0;
      if(point.clientX<=26||pull)start={x:point.clientX,y:point.clientY,pull,dialog,mode:null};
    }
    function move(e){
      if(!start||e.touches.length!==1)return;
      const dx=e.touches[0].clientX-start.x,dy=e.touches[0].clientY-start.y;
      if(!start.mode){
        if(Math.max(Math.abs(dx),Math.abs(dy))<10)return;
        if(start.x<=26&&dx>Math.abs(dy)*1.6)start.mode='back';
        else if(start.pull&&dy>Math.abs(dx)*1.6)start.mode='refresh';
        else {start=null;return;}
      }
      if(e.cancelable)e.preventDefault();
      if(start.mode==='refresh')setFeedback({dialog:start.dialog,state:dy>=72?'release':'pull'});
    }
    function cancel(){start=null;if(!refreshing)setFeedback(null);}
    async function end(e){
      const gesture=start;start=null;
      if(!gesture||!gesture.mode)return;
      const dx=e.changedTouches[0].clientX-gesture.x,dy=e.changedTouches[0].clientY-gesture.y;
      if(gesture.mode==='back'){
        if(dx>=64&&dx>Math.abs(dy)*1.5)window.__shiwenBack?.('edge');
        return;
      }
      if(dy<72||dy<Math.abs(dx)*1.5||topDialog()!==gesture.dialog){setFeedback(null);return;}
      refreshing=true;setFeedback({dialog:gesture.dialog,state:'busy'});
      try{await Promise.allSettled(refreshReads(gesture.dialog).map(read=>Promise.resolve().then(read)));}
      finally{refreshing=false;if(active)setFeedback(null);}
    }
    document.addEventListener('touchstart',begin,{passive:true});
    document.addEventListener('touchmove',move,{passive:false});
    document.addEventListener('touchend',end);
    document.addEventListener('touchcancel',cancel);
    return ()=>{active=false;document.removeEventListener('touchstart',begin);document.removeEventListener('touchmove',move);document.removeEventListener('touchend',end);document.removeEventListener('touchcancel',cancel);};
  },[]);
  if(!feedback||feedback.dialog&&!feedback.dialog.isConnected)return null;
  const label=feedback.state==='busy'?t('正在刷新','Refreshing'):feedback.state==='release'?t('松开刷新','Release to refresh'):t('下拉刷新','Pull to refresh');
  return createPortal(<div className="phone-pull-status" role="status"><PhoneIcon name="refresh" size={16}/>{label}</div>,feedback.dialog||document.body);
}
