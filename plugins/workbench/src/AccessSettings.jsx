import React,{useEffect,useState} from 'react';
export function AccessSettings({rpc,zh}){
 const [enabled,setEnabled]=useState(false);const t=(a,b)=>zh?a:b;
 useEffect(()=>{let active=true;rpc('browserStatus').then(s=>{if(active)setEnabled(s.passwordAuth===true);}).catch(()=>{});return()=>{active=false;};},[]);
 if(!enabled)return null;
 return <section className="sw-view sw-data-settings"><h2>{t('访问与登录','Access and sign-in')}</h2><div className="sw-memory-card"><p>{t('设置访问密码、查看和撤销已授权设备，或退出当前设备。修改密码后，其他设备需要重新登录。','Set your access password, review or revoke devices, and sign out. Changing the password signs out other devices.')}</p><a href="/auth/manage">{t('管理访问密码与设备','Manage password and devices')}</a></div></section>;
}
