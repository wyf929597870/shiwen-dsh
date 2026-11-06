import React,{useEffect,useState} from 'react';

export function BrowserAccess({rpc,t}){
 const [state,setState]=useState(null),[login,setLogin]=useState(''),[error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false);
 useEffect(()=>{let active=true;rpc('browserStatus').then(value=>{if(active)setState(value);}).catch(e=>{if(active)setError(e.message);});return()=>{active=false;};},[]);
 async function copyLogin(){
  setBusy(true);setError('');setNotice('');
  try{
   const value=await rpc('browserLogin');setState(value);setLogin(value.loginUrl);
   try{await navigator.clipboard.writeText(value.loginUrl);setNotice(t('已复制，在可连接此服务的浏览器中打开即可。','Copied. Open it in a browser that can reach this service.'));}
   catch{setNotice(t('请选中下面的登录地址，手动复制到浏览器。','Select the login URL below and copy it into your browser.'));}
  }catch(e){setError(e.message);}finally{setBusy(false);}
 }
 return <section className="sw-memory-card sw-browser-access">
  <h2>{t('浏览器访问 · 共用当前资料','Browser access · shared data')}</h2>
  <p className="sw-sub">{t('连接此 DSH 服务的浏览器共用已保存的素材、文章、会话和设置。无需再导入。','Browsers connected to this DSH service share saved materials, articles, conversations and settings. No reimport needed.')}</p>
  {error&&<p className="sw-error" role="alert">{error}</p>}
  {state&&<>
   <dl><dt>{t('当前资料库','Current library')}</dt><dd>{state.library}</dd><dt>DSH profile</dt><dd>{state.profile}</dd><dt>{t('服务地址','Service address')}</dt><dd>{state.url??t('不可用，请使用部署时的 Web 地址','Unavailable; use your deployment’s Web address')}</dd></dl>
   <p className="sw-sub">{state.desktop?t('使用时保持桌面端运行；退出程序后浏览器也会断开。重启后请重新复制地址。','Keep the desktop app running. Quitting disconnects the browser; copy a new address after restarting.'):t('使用时保持当前 DSH 服务运行。单独启动的桌面端或其他 profile 不会自动连接这个资料库。','Keep this DSH service running. A separately launched desktop app or another profile does not automatically connect to this library.')}</p>
   {state.passwordAuth&&<p><a href="/auth/manage">{t('管理访问密码与设备','Manage password and devices')}</a></p>}{state.available&&<><p className="sw-meta">{state.passwordAuth?t('直接打开服务地址，使用访问密码登录。已授权设备可记住登录状态。HTTP 仅适合可信局域网。','Open the server address and sign in with your access password. You can remember authorized devices. HTTP is for trusted LANs.'):t('登录地址包含当前 DSH 的完整访问凭据，仅供自己的设备使用。','The login URL grants full access. Use only on your own devices.')}</p><button className="sw-primary" disabled={busy} onClick={copyLogin}>{busy?t('正在获取…','Loading…'):t('复制浏览器登录地址','Copy browser login URL')}</button></>}
   {login&&<label className="sw-access-name">{t('浏览器登录地址','Browser login URL')}<input readOnly value={login} onFocus={e=>e.target.select()}/><button onClick={()=>{setLogin('');setNotice('');}}>{t('隐藏地址','Hide URL')}</button></label>}
  </>}
  {notice&&<p className="sw-meta" role="status">{notice}</p>}
 </section>;
}
