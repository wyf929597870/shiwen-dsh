import React,{useEffect,useRef,useState,useSyncExternalStore} from 'react';

import {GlobalSearch} from './GlobalSearch.jsx';

const photoKey='shiwen.desktop.wallpaper';
const shadeKey='shiwen.desktop.wallpaper-shade';
function saved(key){
  try{return localStorage.getItem(key);}catch{return null;}
}
async function wallpaper(file){
  if(!['image/jpeg','image/png','image/webp'].includes(file.type))throw Error();
  const bitmap=await createImageBitmap(file);
  try{
    const scale=Math.min(1,1920/Math.max(bitmap.width,bitmap.height));
    const canvas=document.createElement('canvas');
    canvas.width=Math.max(1,Math.round(bitmap.width*scale));
    canvas.height=Math.max(1,Math.round(bitmap.height*scale));
    canvas.getContext('2d').drawImage(bitmap,0,0,canvas.width,canvas.height);
    return canvas.toDataURL('image/webp',0.82);
  }finally{bitmap.close();}
}
export function DesktopBar({locale,layout,rpc}){
  const lang=useSyncExternalStore(fn=>locale.subscribe(fn),()=>locale.getSnapshot().active);
  const t=(zh,en)=>String(lang).startsWith('zh')?zh:en;
  const [photo,setPhoto]=useState(()=>saved(photoKey));
  const [shade,setShade]=useState(()=>Math.max(0,Math.min(80,Number(saved(shadeKey)??18)||0)));
  const [error,setError]=useState(''),[busy,setBusy]=useState(false);
  const picker=useRef(null),appearance=useRef(null);
  useEffect(()=>{
    const style=document.documentElement.style;
    if(photo?.startsWith('data:image/webp;base64,'))style.setProperty('--sw-wallpaper','url("'+photo+'")');
    style.setProperty('--sw-shade',String(shade/100));
    return ()=>{style.removeProperty('--sw-wallpaper');style.removeProperty('--sw-shade');};
  },[photo,shade]);
  async function change(file){
    if(!file)return;
    setBusy(true);setError('');
    try{const image=await wallpaper(file);localStorage.setItem(photoKey,image);setPhoto(image);}
    catch{setError(t('图片未保存，请尝试较小的 JPG、PNG 或 WebP 图片。','Could not save this image. Try a smaller JPG, PNG or WebP.'));}
    finally{setBusy(false);}
  }
  return <div className="sw-desktop-bar">
    <GlobalSearch rpc={rpc} t={t} layout={layout} inTopBar/>
    <button className="sw-bar-appearance" aria-controls="sw-desktop-appearance" onClick={()=>appearance.current.togglePopover()}>{t('背景','Background')}</button>
    <div ref={appearance} popover="auto" id="sw-desktop-appearance" className="sw-appearance">
      <h2>{t('全局背景','App background')}</h2>
      <div className="sw-wallpaper-sample" aria-hidden="true"/>
      <div><button disabled={busy} onClick={()=>picker.current.click()}>{t('选择图片…','Choose image…')}</button>
      <button disabled={busy||!photo} onClick={()=>{try{localStorage.removeItem(photoKey);setPhoto(null);setError('');}catch{setError(t('无法保存设置','Could not save settings'));}}}>{t('恢复默认','Restore default')}</button></div>
      <input hidden ref={picker} type="file" accept="image/jpeg,image/png,image/webp" onChange={e=>{void change(e.target.files[0]);e.target.value='';}}/>
      <label>{t('背景暗度','Dimming')} <output>{shade}%</output><input type="range" min="0" max="80" value={shade} onChange={e=>{const value=Number(e.target.value);setShade(value);try{localStorage.setItem(shadeKey,String(value));}catch{setError(t('无法保存设置','Could not save settings'));}}}/></label>
      {error&&<p role="alert">{error}</p>}
    </div>
  </div>;
}
