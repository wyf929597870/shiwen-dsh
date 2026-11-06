import React,{useEffect,useRef,useState} from 'react';
export function ImportSettings({rpc,t}){
 const [path,setPath]=useState(''),[preview,setPreview]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const pending=useRef(false);
 useEffect(()=>{let live=true;rpc('legacyDefault').then(value=>{if(live)setPath(current=>current||value);}).catch(()=>{});return()=>{live=false;};},[]);
 async function run(importing){
  if(pending.current)return;pending.current=true;setBusy(true);setError('');setNotice('');
  try{
   if(importing){await rpc('importLegacy',{path});setPreview(null);setNotice(t('importDone'));window.dispatchEvent(new Event('shiwen-library-updated'));}
   else setPreview(await rpc('previewLegacy',{path}));
  }catch(e){setPreview(null);setError(e.message);}finally{pending.current=false;setBusy(false);}
 }
 return <section className="sw-view sw-data-settings">
  <h2>{t('dataSettings')}</h2><section className="sw-memory-card sw-import-settings">
   <h3>{t('importOld')}</h3><p className="sw-sub">{t('importHelp')}</p><p className="sw-meta">{t('serverPathHelp')}</p>
   <label className="sw-access-name">{t('oldPath')}<input value={path} disabled={busy} placeholder={t('oldPath')} onChange={e=>{setPath(e.target.value);setPreview(null);setNotice('');}}/></label>
   <button disabled={busy||!path.trim()} onClick={()=>run(false)}>{busy?t('loading'):t('inspect')}</button>
   {preview&&<div className="sw-import-preview"><p className="sw-meta">{preview.records.map(row=>`${t(row.kind)} ${row.count}`).join(' · ')} · {t('oldMessages')} {preview.messages}</p><button className="sw-primary" disabled={busy} onClick={()=>run(true)}>{t('applyImport')}</button></div>}
   {error&&<p className="sw-error" role="alert">{error}</p>}{notice&&<p className="sw-notice" role="status">{notice}</p>}
  </section>
 </section>;
}
