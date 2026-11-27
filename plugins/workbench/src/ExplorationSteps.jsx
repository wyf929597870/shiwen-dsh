import React,{useRef} from 'react';

export const stepLabels={ask:'追问',judgment:'我目前的判断',trial:'试一次',result:'行动结果'};
const actions={ask:'追问一句',judgment:'写下判断',trial:'试一次',result:'记结果'};
export function stepDraft(kind,parent=null,response=null,quote=''){
 return {stepId:crypto.randomUUID(),kind,parent,response,quote,text:kind==='judgment'?quote:'',observation:'',reviewDay:'',takeaway:''};
}

export function ResponseSteps({response,start}){
 const selection=useRef('');
 function capture(){
  const text=window.getSelection()?.toString().trim();
  selection.current=text&&(response.passage?.quote||response.preview||'').includes(text)?text:'';
 }
 return <div className="sw-rec-actions">{['ask','trial','judgment'].map(kind=>
  <button key={kind} type="button" onPointerDown={capture} onClick={()=>{
   const quote=selection.current||response.passage?.quote||response.preview||'';
   selection.current='';start(stepDraft(kind,null,response,quote));
  }}>{kind==='judgment'?'作为目前的判断':actions[kind]}</button>)}</div>;
}

function StepForm({form,setForm,save,busy,pending}){
 const edit=(key,value)=>setForm(old=>({...old,[key]:value}));
 const {kind,parent,response}=form;
 async function submit(e){
  e.preventDefault();
  const args={action:'add',stepId:form.stepId,kind,text:form.text.trim()};
  if(pending)args.accept=true;
  if(parent)args.parentId=parent.id;
  if(response){
   args.responseId=response.recordId;args.responseRevision=response.revision;
   if(form.quote.trim())args.quote=form.quote.trim();
  }
  for(const key of ['observation','reviewDay','takeaway'])if(form[key].trim())args[key]=form[key].trim();
  if(await save(args))setForm(null);
 }
 return <form className="sw-rec-quote sw-step-form" onSubmit={submit}>
  {parent&&<><small>{stepLabels[parent.kind]}</small><blockquote>{parent.text}</blockquote>
   {kind==='result'&&parent.observation&&<p>想观察的是「{parent.observation}」</p>}</>}
  {response&&<label>{response.title||'这篇回应'} · 起点原句<input maxLength={16000} value={form.quote} onChange={e=>edit('quote',e.target.value)}/></label>}
  <label>{{ask:'还想追问什么？',judgment:'我目前怎么想？',trial:'打算具体试什么？',result:'实际发生了什么？'}[kind]}
   <textarea required autoFocus maxLength={10000} value={form.text} onChange={e=>edit('text',e.target.value)}/></label>
  {kind==='trial'&&<><label>想观察什么（可选）<input maxLength={2000} value={form.observation} onChange={e=>edit('observation',e.target.value)}/></label>
   <label>哪天回来看看（可选）<input type="date" value={form.reviewDay} onChange={e=>edit('reviewDay',e.target.value)}/></label></>}
  {kind==='result'&&<label>这次让我改了哪一点（可选）<textarea maxLength={2000} value={form.takeaway} onChange={e=>edit('takeaway',e.target.value)}/></label>}
  <div className="sw-rec-actions"><button disabled={busy||!form.text.trim()}>{pending?'收下并保存':'保存'}{{ask:'追问',judgment:'判断',trial:'尝试',result:'结果'}[kind]}</button>
   <button type="button" disabled={busy} onClick={()=>setForm(null)}>取消</button></div>
 </form>;
}

export function ExplorationSteps({q,form,setForm,busy,readOnly,save}){
 if(!Array.isArray(q.steps))return null;
 const writable=!readOnly&&['accepted','pending'].includes(q.status)&&q.stepsSupported!==false;
 const current=q.nextStep,history=q.steps.filter(s=>s.id!==current?.id).slice().reverse();
 if(!writable&&!q.steps.length){
  return !readOnly&&q.stepsSupported===false?<p>连接支持探索下一步的电脑后，可以在手机上接着写。</p>:null;
 }
 const byId=new Map(q.steps.map(s=>[s.id,s]));
 const byResponse=new Map(q.responses.map(r=>[r.recordId,r]));
 const completed=new Set(q.steps.filter(s=>s.kind==='result').map(s=>s.parentId));
 function entry(s,active){
  const parent=byId.get(s.parentId),response=byResponse.get(s.responseId);
  return <article className="sw-rec-quote" key={s.id}><small>{active?'当前下一步 · ':''}{stepLabels[s.kind]}</small>
   <p className="sw-step-text">{s.text}</p>
   {s.observation&&<p>想观察「{s.observation}」</p>}{s.reviewDay&&<p>{s.reviewDay} 回看</p>}
   {s.takeaway&&<p>这次改变的判断 · {s.takeaway}</p>}
   {parent&&<small>接着{stepLabels[parent.kind]}「{parent.text}」</small>}
   {s.responseId&&<small>{s.quote?'来自回应「'+s.quote+'」':response?'来自回应 · '+response.title:'原回应已不可用'}</small>}
   {writable&&!form&&<div className="sw-rec-actions">
    {s.kind==='ask'&&<button onClick={()=>setForm(stepDraft('judgment',s))}>回应这个追问</button>}
    {s.kind==='trial'&&!completed.has(s.id)&&<button onClick={()=>setForm(stepDraft('result',s))}>记结果</button>}
    <button onClick={()=>setForm(stepDraft('ask',s))}>追问一句</button>
    <button onClick={()=>setForm(stepDraft('trial',s))}>试一次</button>
    {['result','judgment'].includes(s.kind)&&<button onClick={()=>setForm(stepDraft('judgment',s))}>更新判断</button>}
    {active?<button onClick={()=>save({action:'pause',stepId:s.id})}>先放一放</button>:
     !completed.has(s.id)&&<button onClick={()=>save({action:'select',stepId:s.id})}>设为下一步</button>}
   </div>}
  </article>;
 }
 return <section className="sw-steps"><h3>探索下一步</h3>
  {writable&&form?<StepForm pending={q.status==='pending'} form={form} setForm={setForm} save={save} busy={busy}/>:current?entry(current,true):
   writable&&<div className="sw-rec-actions">{['ask','trial'].map(kind=><button key={kind} onClick={()=>setForm(stepDraft(kind))}>{actions[kind]}</button>)}</div>}
  {history.length>0&&<details><summary>探索经过 · {history.length}</summary>{history.map(s=>entry(s,false))}</details>}
 </section>;
}
