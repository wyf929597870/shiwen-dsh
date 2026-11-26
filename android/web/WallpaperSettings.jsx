import React,{useRef,useState} from 'react';
import {useI18n} from './i18n.js';

const photoKey='shiwen.phone.wallpaper',shadeKey='shiwen.phone.wallpaper-shade';
function saved(key){
  try{return localStorage.getItem(key);}catch{return null;}
}
function savedShade(){
  const value=Number(saved(shadeKey)??25);
  return Number.isFinite(value)?Math.max(0,Math.min(80,value)):25;
}
export function applyWallpaper(){
  const image=saved(photoKey),style=document.documentElement.style;
  if(image?.startsWith('data:image/webp;base64,'))style.setProperty('--phone-photo','url("'+image+'")');
  else style.removeProperty('--phone-photo');
  style.setProperty('--phone-shade',String(savedShade()/100));
}
export function WallpaperSettings(){
  const {t}=useI18n(),picker=useRef(null);
  const [custom,setCustom]=useState(()=>Boolean(saved(photoKey))),[shade,setShade]=useState(savedShade);
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  async function choose(file){
    if(!file)return;
    setBusy(true);setError('');
    try{
      const image=await createImageBitmap(file);
      try{
        const scale=Math.min(1,1440/Math.max(image.width,image.height)),canvas=document.createElement('canvas');
        canvas.width=Math.max(1,Math.round(image.width*scale));canvas.height=Math.max(1,Math.round(image.height*scale));
        canvas.getContext('2d').drawImage(image,0,0,canvas.width,canvas.height);
        const data=canvas.toDataURL('image/webp',0.8);
        if(!data.startsWith('data:image/webp;base64,'))throw Error();
        localStorage.setItem(photoKey,data);
      }finally{image.close();}
      setCustom(true);applyWallpaper();
    }catch{setError(t('图片未保存，请尝试较小的 JPG、PNG 或 WebP 图片。','Could not save this image. Try a smaller JPG, PNG or WebP.'));}
    finally{setBusy(false);}
  }
  function reset(){
    try{localStorage.removeItem(photoKey);applyWallpaper();setCustom(false);setError('');}
    catch{setError(t('无法保存背景设置。','Could not save background settings.'));}
  }
  function dim(value){
    try{localStorage.setItem(shadeKey,String(value));document.documentElement.style.setProperty('--phone-shade',String(value/100));setShade(value);setError('');}
    catch{setError(t('无法保存背景设置。','Could not save background settings.'));}
  }
  return <section className="phone-wallpaper"><h2>{t('全局背景','App background')}</h2>
    <div className="phone-wallpaper-preview" aria-hidden="true"/>
    <div className="phone-wallpaper-actions"><button className="chip" disabled={busy} onClick={()=>picker.current.click()}>{t('选择图片','Choose image')}</button>
    <button className="chip" disabled={busy||!custom} onClick={reset}>{t('恢复默认图片','Restore default image')}</button></div>
    <input hidden ref={picker} type="file" accept="image/jpeg,image/png,image/webp" onChange={e=>{void choose(e.target.files[0]);e.target.value='';}}/>
    <label>{t('背景暗度','Dimming')} <output>{shade}%</output><input type="range" min="0" max="80" value={shade} onChange={e=>dim(Number(e.target.value))}/></label>
    {error&&<p role="alert">{error}</p>}
  </section>;
}
