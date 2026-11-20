import {useEffect,useState} from 'react';
import {call} from '../bridge/library.mjs';

const empty=new Map();
export function useReferenceTitles(libraryId,ids,revision){
  const key=JSON.stringify([libraryId,ids||[],revision]);
  const [result,setResult]=useState(null),[attempt,setAttempt]=useState(0);
  useEffect(()=>{
    const [scope,sourceIds]=JSON.parse(key);
    if(!scope||!sourceIds.length)return;
    let current=true;
    call('recordReferenceTitles',{libraryId:scope,ids:sourceIds}).then(({items})=>{
      if(current)setResult({key,records:new Map(items.map(row=>[row.id,row]))});
    }).catch(()=>{if(current)setResult({key,records:empty,error:true});});
    return ()=>{current=false;};
  },[key,attempt]);
  const loaded=result?.key===key;
  return {recordsById:loaded?result.records:empty,loading:!loaded,error:loaded&&result.error,
    retry:()=>{setResult(null);setAttempt(n=>n+1);}};
}
