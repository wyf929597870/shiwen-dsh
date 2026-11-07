import React,{useEffect,useState} from 'react';
import {MarkdownView} from './MarkdownView.jsx';
import {t,useI18n} from './i18n.js';

export function PluginDetailsPanel({bundle,request,onClose,onUpdate,disabled}){
  const {language}=useI18n();
  const [detail,setDetail]=useState(null),[versions,setVersions]=useState(null),[error,setError]=useState('');
  useEffect(()=>{let live=true;setDetail(null);setVersions(null);setError('');
    Promise.all([request('plugins.readDetail',{name:bundle.name,language}),bundle.updatable?request('plugins.versions',{name:bundle.name}):null])
      .then(([doc,list])=>{if(live){setDetail(doc);setVersions(list);}}).catch(e=>live&&setError(e.message));return()=>{live=false;};
  },[bundle.name,language,request]);
  return <section className="settings-card"><div className="settings-heading"><h2>{bundle.name}</h2><button className="text" onClick={onClose}>{t('关闭')}</button></div>
    <p className="secondary">{t('版本','Version')}：{bundle.version||versions?.installed||'—'}</p>
    {detail?.markdown?<MarkdownView markdown={detail.markdown}/>:<p>{t('此插件没有提供说明。','No description is available.')}</p>}
    {versions?.status==='refused'&&<p role="status">{versions.reason}</p>}
    {versions?.status==='listed'&&<><h3>{t('可用更新','Available updates')}</h3>{versions.versions.length?versions.versions.map(version=><div className="management-row" key={version.version}><strong>{version.version}</strong><p>{version.publishedAt||''}{version.prerelease?' · Pre-release':''}</p>{version.deprecated&&<p>{version.deprecated}</p>}<button className="chip" disabled={disabled||Boolean(version.incompatible)||!version.bundle} onClick={()=>onUpdate(bundle.name,version.version)}>{version.incompatible?t('不兼容','Incompatible'):t('更新至此版本','Update to this version')}</button></div>):<p>{t('已是最新版本。','Already up to date.')}</p>}</>}
    {error&&<p className="error" role="alert">{error}</p>}
  </section>;
}

function fields(value,path=[],secrets=[]){
  if(secrets.some(secret=>path.slice(0,secret.path.length).every((part,i)=>part===secret.path[i])&&path.length>=secret.path.length))return [];
  if(value&&typeof value==='object'&&!Array.isArray(value))return Object.entries(value).flatMap(([key,child])=>fields(child,[...path,key],secrets));
  return path.length?[{path,value}]:[];
}

/** Path edits preserve redacted secrets; the server checks the namespace revision. */
export function ServerConfigurationPanel({request,mutate,supported,disabled,setDirty}){
  useI18n();
  const [snapshot,setSnapshot]=useState(null),[selected,setSelected]=useState(''),[edits,setEdits]=useState({}),[error,setError]=useState('');
  const load=async()=>{try{const value=await request('settings.describe');if(value){setSnapshot(value);setEdits({});setDirty(false);setError('');}}catch(e){setError(e.message);}};
  if(!supported.has('settings.describe'))return null;
  const section=snapshot?.namespaces?.find(row=>row.ns===selected);
  const rows=section?fields(section.value,[],section.secrets??[]):[];
  const change=(key,value)=>{setEdits(current=>({...current,[key]:value}));setDirty(true);};
  const save=async()=>{
    try{
      const ops=Object.entries(edits).map(([key,raw])=>{const row=rows.find(item=>JSON.stringify(item.path)===key);return {op:'set',path:row.path,value:typeof row.value==='string'?raw:JSON.parse(raw)};});
      if(!ops.length)return;
      if(!window.confirm(t('保存这些服务器配置？可能改变该节点的模型或工具行为。','Save these server settings? This can change model or tool behavior on this node.')))return;
      await mutate('settings.mutate',{ns:selected,expectedRevision:section.revision,ops},{onResult:load});
    }catch(e){setError(e.message);}
  };
  return <details className="settings-card"><summary>{t('服务器插件配置','Server plugin configuration')}</summary><p className="secondary">{t('只修改选中的配置字段；已有密钥会保留。','Only edited fields are changed. Existing secrets are preserved.')}</p>
    <button className="chip" disabled={disabled} onClick={load}>{t('读取配置','Load configuration')}</button>
    {snapshot&&<label>{t('插件','Plugin')}<select value={selected} disabled={disabled} onChange={event=>{if(Object.keys(edits).length&&!window.confirm(t('放弃尚未保存的配置？','Discard unsaved settings?')))return;setSelected(event.target.value);setEdits({});setDirty(false);}}><option value="">{t('选择插件配置','Select plugin configuration')}</option>{snapshot.namespaces.map(row=><option key={row.ns} value={row.ns}>{row.ns}</option>)}</select></label>}
    {section&&<><p className="secondary">{t('配置版本','Configuration revision')} {section.revision}</p>{rows.map(row=>{const key=JSON.stringify(row.path),raw=edits[key]??(typeof row.value==='string'?row.value:JSON.stringify(row.value));return <label key={key}>{row.path.join(' / ')}{typeof row.value==='boolean'?<select disabled={disabled||!snapshot.writable} value={raw} onChange={event=>change(key,event.target.value)}><option value="true">{t('开启','On')}</option><option value="false">{t('关闭','Off')}</option></select>:<textarea value={raw??''} disabled={disabled||!snapshot.writable} onChange={event=>change(key,event.target.value)}/>}</label>;})}
      {(section.secrets??[]).map(secret=><div className="management-row" key={JSON.stringify(secret.path)}><p className="secondary">{secret.path.join(' / ')} · {secret.set?t('已配置密钥','Secret configured'):t('未配置密钥','Secret not configured')}</p><button className="chip" disabled={disabled||!snapshot.writable||!supported.has('settings.secretSet')} onClick={()=>mutate('settings.secretSet',{ns:selected,path:secret.path,expectedRevision:section.revision},{onResult:load})}>{t('安全编辑密钥','Edit credential securely')}</button></div>)}
      <button className="primary" disabled={disabled||!snapshot.writable||!Object.keys(edits).length||!supported.has('settings.mutate')} onClick={save}>{t('保存','Save')}</button></>}
    {error&&<p className="error" role="alert">{error}</p>}
  </details>;
}
