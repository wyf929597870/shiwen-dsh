// Keep serialization and storage out of the input event. Explicit saves and
// clears cancel the pending value so a delayed draft cannot resurrect old text.
export function createDraftAutosave(write,{delay=1000,onError=()=>{}}={}){
 let timer,pending,hasPending=false;
 function cancel(){clearTimeout(timer);timer=undefined;pending=undefined;hasPending=false;}
 function flush(){
  if(!hasPending)return;
  const value=pending;cancel();
  try{Promise.resolve(write(value)).catch(onError);}catch(error){onError(error);}
 }
 function schedule(value){pending=value;hasPending=true;clearTimeout(timer);timer=setTimeout(flush,delay);}
 return {schedule,flush,cancel};
}
