import {diffChars} from 'diff';

// Bound work on long records; never present a partial comparison as complete.
export function conflictTextDiff(local, remote, options={}) {
  local=String(local??'');remote=String(remote??'');
  if(local===remote)return {same:true,local:[],remote:[]};
  if(local.length+remote.length>100_000)return {unavailable:true};
  const parts=diffChars(local,remote,{timeout:120,maxEditLength:4000,...options});
  if(!parts)return {unavailable:true};
  const context=32;
  const side=which=>{
    const out=[];
    const add=(text,changed=false)=>{if(text)out.push({text,changed});};
    parts.forEach((part,index)=>{
      if(part.added||part.removed){if((which==='local'&&part.removed)||(which==='remote'&&part.added))add(part.value,true);return;}
      const chars=Array.from(part.value),before=index>0,after=index<parts.length-1;
      if(!before&&!after)return;
      if(before&&after&&chars.length<=context*2){add(part.value);return;}
      if(before)add(chars.slice(0,context).join(''));
      if(chars.length>(before?context:0)+(after?context:0))add(' … ');
      if(after)add(chars.slice(-context).join(''));
    });
    return out;
  };
  return {same:false,local:side('local'),remote:side('remote')};
}
