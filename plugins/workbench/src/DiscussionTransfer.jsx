import React,{useSyncExternalStore} from 'react';

let pending=null;
const listeners=new Set();
const subscribe=listener=>{listeners.add(listener);return()=>listeners.delete(listener);};
function update(value){pending=value;for(const listener of listeners)listener();}
export function keepDiscussion(text,libraryId){update({text,libraryId});}
export function DiscussionTransfer({rpc,inputActions}){
 const value=useSyncExternalStore(subscribe,()=>pending);
 const [message,setMessage]=React.useState('');
 if(!value||!inputActions)return null;
 async function insert(){
  const span=inputActions.captureInsertion();
  try{
   if((await rpc('themeContext')).libraryId!==value.libraryId){update(null);return;}
   if(value!==pending)return;
   if(inputActions.insertText('\n'+value.text,span)){setMessage('');update(null);}
   else setMessage('输入框已变化，请重新确认插入位置。');
  }catch(e){setMessage(e.message);}
 }
 return <div className="sw-rec-transfer"><span>有一段待讨论的原文</span><button onClick={insert}>加入当前对话</button><button onClick={()=>update(null)}>取消</button>{message&&<p role="status">{message}</p>}</div>;
}
