import './chat-translations.mjs';
import {t,useI18n} from './i18n.js';
import React,{useCallback,useEffect,useRef,useState} from 'react';
import {call} from '../bridge/library.mjs';
import {MarkdownView} from './MarkdownView.jsx';
import {mergeSessionEvents,sessionEventPresentation} from './remote-session-state.mjs';

const fresh=()=>({requestId:crypto.randomUUID(),text:'',mode:'queue',pending:false,localGeneration:0});
const title=row=>row.projections?.values?.title??row.sessionId;
const safeTitle=row=>typeof title(row)==='string'?title(row):row.sessionId;

function Interaction({item,clientId,onReply,busy}){
  useI18n();
  const [answers,setAnswers]=useState({});const request=item.request??{};
  const answerFor=question=>answers[question.id]??{selected:[],custom:''};
  const update=(question,patch)=>setAnswers(current=>({...current,[question.id]:{...(current[question.id]??{selected:[],custom:''}),...patch}}));
  return <div className="session-notice" role="alert">
    <strong>{t(item.event==='approval/request'?'工具需要你的确认':'助手需要你的回答',item.event==='approval/request'?'A tool needs your approval':'The assistant needs your answer')}</strong>
    <small>{t('会话','Session')}：{item.agentId}</small>
    {item.event==='approval/request'?<><p>{request.reason??request.toolName??t('执行工具','Run tool')}</p><details><summary>{t('查看请求详情','View request details')}</summary><pre>{JSON.stringify(request,null,2)}</pre></details><div className="profile-actions">
      <button className="chip" disabled={busy} onClick={()=>onReply({clientId,eventId:item.eventId,value:'rejected'})}>{t('拒绝')}</button>
      <button className="primary" disabled={busy} onClick={()=>onReply({clientId,eventId:item.eventId,value:'allowed-once'})}>{t('仅允许这一次')}</button>
    </div></>:item.event==='user-questions/request'?<>
      {(request.questions??[]).map(question=><fieldset key={question.id}><legend>{question.question??question.id}</legend>
        {question.detail&&<MarkdownView markdown={question.detail}/>}
        {(question.options??[]).map(option=><label key={option.label}><input type={question.multiSelect?'checkbox':'radio'} name={`${item.eventId}:${question.id}`} checked={answerFor(question).selected.includes(option.label)} disabled={busy}
          onChange={event=>update(question,{selected:question.multiSelect?(event.target.checked?[...answerFor(question).selected,option.label]:answerFor(question).selected.filter(label=>label!==option.label)):[option.label],...(question.multiSelect?{}:{custom:''})})}/>{option.label}{option.description&&<small>{option.description}</small>}</label>)}
        <textarea aria-label={`${question.question??t('回答','Answer')}: ${t('补充文字','additional text')}`} placeholder={t('也可以直接输入回答','Or type an answer')} value={answerFor(question).custom} disabled={busy} onChange={event=>update(question,{custom:event.target.value,...(question.multiSelect?{}:{selected:[]})})}/>
      </fieldset>)}
      <button className="primary" disabled={busy||!(request.questions??[]).length||(request.questions??[]).some(question=>!answerFor(question).selected.length&&!answerFor(question).custom.trim())}
        onClick={()=>onReply({clientId,eventId:item.eventId,value:{answers:request.questions.map(question=>({id:question.id,...answerFor(question)}))}})}>{t('提交回答')}</button>
    </>:<p>{t('此交互暂需在 DSH 网页处理：','Handle this interaction in the DSH web app: ')}{item.event}</p>}
  </div>;
}

export function RemoteChatPanel({node,onSending}){
  useI18n();
  const [sessions,setSessions]=useState([]),[sessionId,setSessionId]=useState(''),[catalog,setCatalog]=useState({presets:[],workspaces:[]});
  const [skills,setSkills]=useState([]);
  const [workspace,setWorkspace]=useState(''),[preset,setPreset]=useState(''),[models,setModels]=useState({groups:[]});
  const [events,setEvents]=useState([]),[state,setState]=useState(null),[more,setMore]=useState(false),[cut,setCut]=useState(null);
  const [draft,setDraft]=useState(fresh),[busy,setBusy]=useState(false),[feedback,setFeedback]=useState(null),[creationStateReady,setCreationStateReady]=useState(false);
  const setError=value=>setFeedback(value?{kind:'error',text:value}:null);
  const setSuccess=value=>setFeedback(value?{kind:'success',text:value}:null);
  const mounted=useRef(true),session=useRef(''),draftRef=useRef(draft),writes=useRef(Promise.resolve()),createRequest=useRef(null),lastCursor=useRef(-1);
  const rpc=useCallback(async(action,args={})=>{
    const response=await call('nodeSessions',{id:node.id,configRevision:node.configRevision,action,args});
    if(response.nodeChanged)throw Error(t('服务器地址已改变，请返回重新连接；原请求结果仍需核对。','The server address changed. Reconnect in Settings and verify the result of the original request.'));
    return response.data;
  },[node.id,node.configRevision]);
  const persist=next=>{
    next={...next,localGeneration:(draftRef.current.localGeneration??0)+1};
    const captured=session.current;draftRef.current=next;setDraft(next);
    writes.current=writes.current.catch(()=>{}).then(()=>call('nodeSessionDraftSave',{id:node.id,sessionId:captured,configRevision:node.configRevision,draft:next}));
    writes.current.catch(()=>{if(mounted.current)setError(t('远程会话草稿未保存，请暂时不要离开。','The remote chat draft was not saved. Stay on this page for now.'));});return writes.current;
  };
  const persistCreation=async value=>{
    const args={id:node.id,sessionId:'__create__',configRevision:node.configRevision};
    const stored=await call('nodeSessionDraftRead',args);
    return call('nodeSessionDraftSave',{...args,draft:{...value,localGeneration:(stored.draft?.localGeneration??0)+1}});
  };
  const readCreationState=useCallback(async()=>{
    if(!mounted.current)return;
    setCreationStateReady(false);
    try{
      const stored=await call('nodeSessionDraftRead',{id:node.id,sessionId:'__create__',configRevision:node.configRevision});
      if(!mounted.current)return;
      if(stored.draft?.pending){
        const request=JSON.parse(stored.draft.text);
        if(!request.requestId||!request.sessionId)throw Error('CREATION_RECEIPT_UNREADABLE');
        createRequest.current=request;
        setError(t('有一条新会话创建请求等待核对，请核对后继续。','A conversation creation request is awaiting verification. Check its result before continuing.'));
      }else createRequest.current=null;
      setCreationStateReady(true);
    }catch(e){
      if(mounted.current)setError(`${t('无法读取新会话创建回执；为避免重复创建，暂时不能新建会话。请重试读取。','Could not read the conversation creation receipt. To avoid creating a duplicate, new conversations are temporarily disabled. Retry the check.')} ${e.message||e}`);
    }
  },[node.id,node.configRevision]);
  const refresh=useCallback(async(id,replace=false)=>{
    const [status,page]=await Promise.all([rpc('state',{sessionId:id}),rpc('events',{sessionId:id})]);
    let combined=page.records??[],previous=page;
    // A busy tool loop may commit more than one page between polls. Backfill the
    // pinned cut before accepting its cursor, so no durable event is skipped.
    if(!replace&&lastCursor.current>=0){
      while(previous.hasMore){
        const first=Math.min(...(previous.records??[]).map(row=>row.event?.seq??Infinity));
        if(!Number.isSafeInteger(first)||first<=lastCursor.current+1)break;
        previous=await rpc('events',{sessionId:id,throughSeq:page.cursor,beforeSeq:first});
        const nextFirst=Math.min(...(previous.records??[]).map(row=>row.event?.seq??Infinity));
        if(!Number.isSafeInteger(nextFirst)||nextFirst>=first)throw Error(t('历史分页未推进，请重新打开会话核对','History pagination did not advance. Reopen the conversation and check again.'));
        combined=mergeSessionEvents(combined,previous.records);
        if(!mounted.current||session.current!==id)return;
      }
    }
    if(!mounted.current||session.current!==id)return;
    lastCursor.current=page.cursor;setState(status);setEvents(current=>mergeSessionEvents(replace?[]:current,combined));
    if(replace){setMore(Boolean(page.hasMore));setCut(page.cursor);}
  },[rpc]);
  const choose=async(id)=>{
    if(busy||id===session.current)return;
    setBusy(true);setError('');
    try{
      await writes.current;const stored=await call('nodeSessionDraftRead',{id:node.id,sessionId:id,configRevision:node.configRevision});
      if(!mounted.current)return;session.current=id;setSessionId(id);setEvents([]);setState(null);
      const next=stored.draft??fresh();draftRef.current=next;setDraft(next);setSkills([]);await refresh(id,true);
      rpc('skills',{sessionId:id}).then(result=>{if(mounted.current&&session.current===id)setSkills(result.skills??[]);}).catch(()=>{});
    }catch(e){setError(e.message);}finally{if(mounted.current)setBusy(false);}
  };
  useEffect(()=>{
    mounted.current=true;setError('');
    setCreationStateReady(false);
    rpc('list').then(result=>{if(mounted.current)setSessions(result.items??[]);}).catch(e=>mounted.current&&setError(`${t('无法读取服务器会话列表：','Could not read server conversations: ')}${e.message||e}`));
    rpc('catalog').then(result=>{if(mounted.current)setCatalog(result);}).catch(e=>mounted.current&&setError(`${t('无法读取工作区与助手列表：','Could not read workspaces and agents: ')}${e.message||e}`));
    rpc('models').then(result=>{if(mounted.current)setModels(result);}).catch(e=>mounted.current&&setError(`${t('无法读取服务器模型列表：','Could not read server models: ')}${e.message||e}`));
    readCreationState();
    return()=>{mounted.current=false;onSending?.(false);};
  },[rpc,readCreationState]);
  useEffect(()=>{
    if(!sessionId)return;let pending=false;
    const timer=setInterval(async()=>{
      if(pending||document.visibilityState==='hidden')return;pending=true;
      try{await refresh(sessionId);}catch(e){if(mounted.current)setError(`${t('连接中断，消息和草稿仍保留：','Connection interrupted; messages and draft are preserved: ')}${e.message}`);}finally{pending=false;}
    },3500);return()=>clearInterval(timer);
  },[sessionId,refresh]);
  const create=async(creator=false)=>{
    if(!creationStateReady)return;
    setBusy(true);setError('');
    try{
      createRequest.current??={requestId:crypto.randomUUID(),sessionId:crypto.randomUUID(),...(workspace?{workspaceId:workspace}:{}),...(creator?{agentPreset:'cordis'}:preset?{agentPreset:preset}:{})};
      await persistCreation({requestId:createRequest.current.requestId,text:JSON.stringify(createRequest.current),mode:'queue',pending:true});
      const result=await rpc('create',createRequest.current);
      const list=await rpc('list');setSessions(list.items??[]);
      if(result.status!=='accepted'){setError(t('新会话创建结果待核对，请刷新会话列表。不要重复创建。','The conversation creation result needs verification. Refresh the list; do not create it again.'));return;}
      await persistCreation(fresh());
      createRequest.current=null;session.current=result.sessionId;setSessionId(result.sessionId);
      const next=fresh();draftRef.current=next;setDraft(next);await refresh(result.sessionId,true);
      setSkills((await rpc('skills',{sessionId:result.sessionId}).catch(()=>({skills:[]}))).skills??[]);
      if(creator)await persist({...next,text:t('帮我创建一个 DSH 插件：','Help me create a DSH plugin:')});
    }catch(e){setError(`${t('新会话状态待核对：','Conversation creation needs verification: ')}${e.message}`);}finally{setBusy(false);}
  };
  const settle=async()=>{
    const next=fresh();await persist(next);await refresh(session.current);
  };
  const send=async()=>{
    if(!sessionId||!draft.text.trim()||busy||draft.pending)return;
    setBusy(true);onSending?.(true);setError('');
    try{
      const submitted={...draftRef.current,pending:true};await persist(submitted);
      const result=await rpc('send',{sessionId,requestId:submitted.requestId,mode:submitted.mode,content:[{type:'text',text:submitted.text}],clientTimeZone:Intl.DateTimeFormat().resolvedOptions().timeZone});
      if(result.status==='accepted')await settle();else setError(t('发送结果待核对。原文已保存，不会自动重复发送。','The send result needs verification. The original is saved and will not be sent again automatically.'));
    }catch(e){setError(`${t('发送结果待核对，先核对回执：','The send result needs verification. Check the receipt first: ')}${e.message}`);}finally{setBusy(false);onSending?.(false);}
  };
  const reconcile=async()=>{
    setBusy(true);setError('');try{
      const result=await rpc('status',{requestId:draft.requestId});
      if(result.request?.status==='accepted')await settle();else setError(t('尚未查到明确接收结果。请保留原文，稍后再核对；不会自动重发。','No confirmed receipt was found. Keep the original and check again later; it will not be resent automatically.'));
    }catch(e){setError(`${t('回执未确认：','Receipt not confirmed: ')}${e.message}`);}finally{setBusy(false);}
  };
  const older=async()=>{
    setBusy(true);try{const first=events[0]?.event?.seq;if(first==null)return;
      const page=await rpc('events',{sessionId,throughSeq:cut,beforeSeq:first});
      setEvents(current=>mergeSessionEvents(current,page.records));setMore(Boolean(page.hasMore));
    }catch(e){setError(e.message);}finally{setBusy(false);}
  };
  const reply=async args=>{setBusy(true);try{await rpc('respond',args);await refresh(sessionId);}catch(e){setError(`${t('决定未确认，请刷新：','The decision was not confirmed. Refresh and check: ')}${e.message}`);}finally{setBusy(false);}};
  return <section className="chat-panel" aria-label={t('服务器 AI 对话')}>
    <div className="session-notice"><strong>{node.name} · {t('服务器会话')}</strong><span>{t('由这台服务器运行 Agent、工具和模型；离线时可切换手机助手继续记录。')}</span></div>
    <div className="chat-session-controls"><select aria-label={t('服务器会话')} value={sessionId} disabled={busy} onChange={event=>choose(event.target.value)}>
      <option value="">{t('选择服务器会话','Choose a server conversation')}</option>{sessions.map(row=><option key={row.sessionId} value={row.sessionId}>{safeTitle(row)}{row.running?` · ${t('运行中','Running')}`:''}</option>)}</select>
      <button className="chip chat-icon-action" aria-label={t('刷新会话','Refresh conversations')} title={t('刷新会话','Refresh conversations')} disabled={busy} onClick={async()=>{try{setSessions((await rpc('list')).items??[]);}catch(e){setError(e.message);}}}>↻</button></div>
    <details className="remote-create"><summary>{t('新建会话','New conversation')}</summary><label>{t('工作区','Workspace')}<select value={workspace} disabled={busy} onChange={event=>setWorkspace(event.target.value)}><option value="">{t('服务端默认','Server default')}</option>{catalog.workspaces.map(row=><option key={row.id} value={row.id}>{row.title}</option>)}</select></label>
      <label>{t('助手','Agent')}<select value={preset} disabled={busy} onChange={event=>setPreset(event.target.value)}><option value="">{t('服务端默认','Server default')}</option>{catalog.presets.map(row=><option key={row.id} value={row.id} disabled={Boolean(row.broken)}>{row.name??row.id}</option>)}</select></label><button className="chip" disabled={busy||!creationStateReady} onClick={()=>create(false)}>{t(createRequest.current?'核对创建回执':'创建',createRequest.current?'Check creation receipt':'Create')}</button>{!creationStateReady&&<button className="text" disabled={busy} onClick={readCreationState}>{t('重试读取创建回执','Retry reading creation receipt')}</button>}{catalog.presets.some(row=>row.id==='cordis'&&!row.broken)&&<button className="chip" disabled={busy||!creationStateReady||Boolean(createRequest.current)} onClick={()=>create(true)}>{t('创建自己的插件','Create your own plugin')}</button>}</details>
    {sessionId&&<>
      <div className="chat-session-controls"><label>{t('切换本会话模型','Change model for this conversation')}<select aria-label={t('远程模型','Remote model')} defaultValue="" disabled={busy||state?.running} onChange={async event=>{if(!event.target.value)return;const [provider,model]=JSON.parse(event.target.value);setBusy(true);try{await rpc('selectModel',{sessionId,provider,model});setSuccess(t('本会话模型已更新','Conversation model updated'));}catch(e){setError(e.message);}finally{setBusy(false);}}}>
        <option value="">{t('沿用服务器会话配置','Use server conversation settings')}</option>{models.groups.map(group=><optgroup key={group.id} label={group.name}>{group.models.map(model=><option key={model.id} value={JSON.stringify([group.id,model.id])}>{model.name}</option>)}</optgroup>)}</select></label>
        {state?.running&&<button className="chip" disabled={busy} onClick={async()=>{setBusy(true);try{await rpc('cancel',{sessionId});await refresh(sessionId);}catch(e){setError(e.message);}finally{setBusy(false);}}}>{t('停止生成')}</button>}
      </div>
      <div className="conversation" role="log" aria-live="polite">{more&&<button className="text" disabled={busy} onClick={older}>{t('加载更早消息')}</button>}
        {events.map(row=>{const view=sessionEventPresentation(row);if(!view)return null;return <article className="turn" key={row.event.seq}>{view.role==='tool'?<details><summary>{view.label}</summary><pre>{view.text}</pre></details>:<div className={view.role==='user'?'user-message':'agent-message'}><MarkdownView markdown={view.text}/>{view.interrupted&&<small>{t('这次回答已中断')}</small>}</div>}</article>;})}
        {state?.running&&<p className="secondary">{t('服务器正在处理…')}</p>}
      </div>
      {(state?.interactions?.items??[]).map(item=><Interaction key={item.eventId} item={item} clientId={state.interactions.clientId} busy={busy} onReply={reply}/>)}
      {state?.interactionUnavailable&&state?.pendingInput?.length>0&&<p role="alert">{t('审批连接不可用，请在服务器网页处理待确认请求。','Approval connection is unavailable. Handle pending requests in the server web app.')}</p>}
      <div className="agent-composer">{skills.length>0&&<details><summary>{t('本会话技能','Session skills')} · {skills.length}</summary>{skills.map(skill=><div className="management-row" key={skill.name}><strong>/{skill.name}</strong><p className="secondary">{skill.description}</p><button className="chip" disabled={busy||draft.pending} onClick={()=>persist({...draftRef.current,text:`/${skill.name} ${draftRef.current.text}`})}>{t('加入待发送消息','Add to draft')}</button></div>)}</details>}<textarea maxLength={32000} aria-label={t('远程会话消息')} placeholder={t('发送给服务器助手…')} value={draft.text} disabled={busy||draft.pending} onChange={event=>persist({...draftRef.current,text:event.target.value})}/>
        <div className="chat-actions"><label>{t('发送方式')}<select value={draft.mode} disabled={busy||draft.pending} onChange={event=>persist({...draftRef.current,mode:event.target.value})}><option value="queue">{t('排队执行')}</option><option value="steer">{t('补充当前任务')}</option></select></label>
        {draft.pending?<button className="primary" disabled={busy} onClick={reconcile}>{t('核对发送回执')}</button>:<button className="primary" disabled={busy||!draft.text.trim()} onClick={send}>{t('发送')}</button>}</div>
      </div>
    </>}
    {feedback&&<p role={feedback.kind==='error'?'alert':'status'} className={feedback.kind==='error'?'error':'success-note'}>{feedback.text}</p>}
  </section>;
}
