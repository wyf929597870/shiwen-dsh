import {dailyPicks} from './feed.mjs';
import {randomUUID} from 'node:crypto';
import {assistTools} from '../../../../integration/recommendations.mjs';
import {analyze,clean,fail,hash,resolveQuote} from './evidence.mjs';
import {dateKey} from '../../legacy/content.mjs';
import {validDay} from '../../legacy/wiki-import.mjs';

function monday(date=new Date()){
 const d=new Date(date);d.setDate(d.getDate()-(d.getDay()+6)%7);return dateKey(d);
}
const uuid=()=>randomUUID();
const page=(items,cursor=0)=>({items:items.slice(cursor,cursor+20),nextCursor:cursor+20<items.length?cursor+20:null});
const checkRev=(actual,wanted)=>{if(actual!==wanted)fail('revision_conflict','内容已更新，请重新读取',actual);};
function newCard(item,week,actor=''){
 return {...item,cardId:uuid(),cardRevision:1,week,actor,targets:{decisions:[],drafts:[],themes:[]},savedForLater:false,updatedAt:new Date().toISOString()};
}
export function createAssistStore(db,api){
 db.exec(`CREATE TABLE IF NOT EXISTS assist_data(library TEXT NOT NULL,kind TEXT NOT NULL,id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(library,kind,id))`);
 const lib=()=>api.themeContext().libraryId;
 const find=(kind,id)=>JSON.parse(db.prepare('SELECT value FROM assist_data WHERE library=? AND kind=? AND id=?').get(lib(),kind,id)?.value??'null');
 const all=kind=>db.prepare('SELECT value FROM assist_data WHERE library=? AND kind=? ORDER BY rowid DESC').all(lib(),kind).map(r=>JSON.parse(r.value));
 const put=(kind,id,value)=>{db.prepare('INSERT INTO assist_data VALUES(?,?,?,?) ON CONFLICT(library,kind,id) DO UPDATE SET value=excluded.value').run(lib(),kind,id,JSON.stringify(value));return value;};
 const settings=()=>find('settings','weekly')??{enabled:false,revision:1};
 const events=()=>all('feedback');
 const hasSkip=(card,week)=>events().some(f=>f.active&&f.action==='skip'&&f.cardId===card.cardId&&f.week===week);
 const weekData=week=>find('week',week)??{published:[],scanned:{},opened:false};
 const manual=new Map(),jobs=new Map(),requests=new Map();
 const lifetime=30*60*1000;
 function purge(){
  const before=Date.now()-lifetime;
  for(const [id,job] of jobs)if(job.at<before&&job.status!=='pending')jobs.delete(id);
  for(const [key,id] of requests)if(!jobs.has(id))requests.delete(key);
  for(const [key,card] of manual)if(card.at<before)manual.delete(key);
 }
 function start(actor,key,args,work){
  purge();const fingerprint=hash(args),requestKey=JSON.stringify([lib(),actor,key]),prev=jobs.get(requests.get(requestKey));
  if(prev){if(prev.fingerprint!==fingerprint)fail('request_conflict','请求编号已用于不同内容');return {jobId:prev.jobId};}
  const job={jobId:uuid(),actor,libraryId:lib(),fingerprint,at:Date.now(),status:'pending'};
  requests.set(requestKey,job.jobId);jobs.set(job.jobId,job);
  Promise.resolve().then(()=>work(job)).then(value=>Object.assign(job,{status:'ready',value}),e=>Object.assign(job,{status:'failed',code:e.code??'analysis_failed',message:e.message})).finally(()=>{job.at=Date.now();});
  return {jobId:job.jobId};
 }
 function resolveCard(a,actor){
  if(a.cardId){const card=find('card',a.cardId);if(!card)fail('card_missing','推荐不存在');return card;}
  const card=manual.get(a.resultId);
  if(!card||card.at<Date.now()-lifetime||card.actor!==actor||card.libraryId!==lib())fail('result_expired','结果已过期，请重新分析');
  return structuredClone(card);
 }
 function relationEvidence(card,relation){
  return hash([relation.type,...relation.quoteIds.map(id=>{const q=card.quotes.find(q=>q.quoteId===id);return q?hash([q.recordId,q.field,clean(q.text)]):id;}).sort()]);
 }
 function safeRelations(card,quotes){
  const valid=new Set(quotes.filter(q=>!q.unavailable).map(q=>q.quoteId));
  const rejected=events().filter(f=>f.active&&f.action==='reject_relation');
  return card.relations.filter(r=>!rejected.some(f=>f.relationId===r.relationId||f.evidenceHash===relationEvidence(card,r))&&r.quoteIds.every(id=>valid.has(id))&&
    (r.type!=='outcome'||(quotes.find(q=>q.quoteId===r.quoteIds[0])?.contentDay&&quotes.find(q=>q.quoteId===r.quoteIds[0]).contentDay<quotes.find(q=>q.quoteId===r.quoteIds.at(-1))?.contentDay)));
 }
 function detail(card,scopes,day=dateKey(new Date())){
  const quotes=card.quotes.map(q=>resolveQuote(api,q)??{quoteId:q.quoteId,recordId:q.recordId,unavailable:true});
  const relations=safeRelations(card,quotes);
  const change=card.dailyChange;
  let todayUpdate=null;
  if(change?.day===day&&relations.length){
   const supported=new Set(relations.flatMap(r=>r.quoteIds));
   const quoteIds=change.quoteIds.filter(id=>supported.has(id));
   if(change.kind==='created'||quoteIds.length)todayUpdate={day,kind:change.kind,quoteIds};
  }
  const targets=structuredClone(card.targets);
  for(const target of [...targets.drafts,...targets.decisions]){const r=api.get(target.id);target.removed=!r||!!r.deleted;if(!target.removed){target.title=r.title;target.revision=r.revision;}}
  for(const target of targets.themes){
   const t=db.prepare('SELECT title FROM themes WHERE id=?').get(target.themeId);target.removed=!t;if(t)target.title=t.title;
   for(const i of target.items)i.removed=!db.prepare('SELECT id FROM theme_members WHERE id=? AND theme_id=?').get(i.memberId,target.themeId);
  }
  const availableActions=['read','discuss'];if(scopes.includes('update')){availableActions.push('add_to_theme');if(!card.actor)availableActions.push('feedback');}if(scopes.includes('create'))availableActions.push('save_decision','create_draft');
  return {libraryId:lib(),cardId:card.cardId,cardRevision:card.cardRevision,...(card.actor?{resultId:card.cardId,resultVersion:card.cardRevision}:{}),todayUpdate,newQuoteIds:card.newQuoteIds??[],state:{savedForLater:card.savedForLater,skipped:hasSkip(card,monday())},scene:card.scene,question:card.question,reason:relations.length?(relations.at(-1).reason??card.reason):'原关联已撤下或来源已变化。',followup:relations.length?(relations.at(-1).followup??card.followup):'',quotes,relations,targets,savedForLater:card.savedForLater,availableActions};
 }
 function persist(card){
  card.cardRevision++;if(card.actor)manual.set(card.cardId,card);else put('card',card.cardId,card);
 }
 function summaries(cards,scopes,day){
  return cards.map(card=>{const d=detail(card,scopes,day);return {todayUpdate:d.todayUpdate,cardId:d.cardId,cardRevision:d.cardRevision,scene:d.scene,question:d.question,reason:d.reason,quoteCount:d.quotes.length,valid:!!d.relations.length};});
 }
 function libraryWrite(actor,name,a,fn){
  const key=hash([actor,a.requestId]),fingerprint=hash([name,a]);
  return db.transaction(()=>{
   const prior=find('receipt',key);
   if(prior){if(prior.fingerprint!==fingerprint)fail('request_conflict','请求编号已用于不同内容');return prior.response;}
   const response=fn();
   put('receipt',key,{fingerprint,response});return response;
  })();
 }
 function feedback(card,a){
  const action=a.action;
  if(action==='save_later'||action==='remove_later'){
   const next=action==='save_later';if(card.savedForLater!==next){card.savedForLater=next;persist(card);}
   return {savedForLater:next,cardRevision:card.cardRevision};
  }
  let f;
  if(action==='undo'){
   f=find('feedback',a.feedbackId??'');
   if(!f||f.cardId!==card.cardId)fail('feedback_missing','找不到这次反馈');
   if(f.active){f.active=false;persist(card);}
  }else{
   const relation=action==='reject_relation'?card.relations.find(r=>r.relationId===a.relationId):null;
   if(action==='reject_relation'&&(!relation||hash([...relation.quoteIds].sort())!==hash([...(a.quoteIds??[])].sort())))fail('revision_conflict','关联已变化');
   f={feedbackId:uuid(),cardId:card.cardId,question:card.question,week:monday(),at:new Date().toISOString(),action,active:true,relationId:relation?.relationId,quoteIds:relation?.quoteIds,evidenceHash:relation?relationEvidence(card,relation):undefined,reason:a.reason};
   persist(card);
  }
  put('feedback',f.feedbackId,f);return {...f,cardRevision:card.cardRevision};
 }
 function business(card,name,a,scopes){
  if(name==='shiwen_recommendation_feedback')return feedback(card,a);
  const selected=[...new Set(a.quoteIds??[])].map(id=>{
   const q=card.quotes.find(x=>x.quoteId===id);if(!q)fail('source_changed','引用不属于当前结果');return {id,q:resolveQuote(api,q)};
  });
  if(name==='shiwen_assist_add_to_theme'){
   if(Boolean(a.newThemeTitle)===Boolean(a.themeId))fail('invalid_request','请选择一个已有或新主题');
   let theme=a.themeId?api.themeRead({id:a.themeId}):null;
   if(theme)checkRev(theme.revision,a.themeRevision);
   if(!theme&&selected.some(x=>x.q))theme=api.themeRead({id:api.themeSave({title:a.newThemeTitle}).id});
   const items=[];
   for(const {id,q} of selected){
    if(!q){items.push({quoteId:id,status:'source_changed'});continue;}
    let member=theme.members.find(m=>m.sourceRecordId===q.recordId&&m.field===q.field&&m.location.start===q.start&&m.location.end===q.end&&(m.location.excerptIndex??null)===q.excerptIndex&&m.quote===q.text);
    const status=member?'already_present':'added';
    if(!member){const receipt=api.themeMemberAdd({themeId:theme.id,revision:theme.revision,sourceRecordId:q.recordId,sourceRevision:q.sourceRevision,field:q.field,excerptIndex:q.excerptIndex,start:q.start,end:q.end,quote:q.text},{receiptOnly:true});member={id:receipt.memberId};theme=api.themeRead({id:theme.id});}
    items.push({quoteId:id,status,memberId:member.id});
   }
   if(theme){let target=card.targets.themes.find(t=>t.themeId===theme.id);if(!target){target={themeId:theme.id,items:[]};card.targets.themes.push(target);}
    for(const item of items.filter(i=>i.memberId))if(!target.items.some(i=>i.memberId===item.memberId))target.items.push(item);
    persist(card);}
   return {created:!!theme&&!a.themeId,themeId:theme?.id,themeRevision:theme?.revision,cardRevision:card.cardRevision,items};
  }
  if(name==='shiwen_assist_save_decision'){
   if(validDay(a.day)!==a.day)fail('invalid_request','日期无效');
   const record=api.save({kind:'idea',body:a.body,origin:'personal',reason:'保存确认的决定'},{archive:true,inTransaction:true,beforeSync:r=>db.prepare('INSERT INTO record_dates VALUES(?,?,?)').run(r.id,a.day,'用户确认的决定日期')});
   card.targets.decisions.push({id:record.id});persist(card);return {recordId:record.id,revision:record.revision,day:a.day,cardRevision:card.cardRevision};
  }
  if(name!=='shiwen_assist_create_draft')throw Error('未知操作');
  const old=card.targets.drafts.map(t=>api.get(t.id)).find(r=>r&&!r.deleted);
  if(old&&a.mode==='first')return {status:'existing',articleId:old.id,title:old.title,revision:old.revision,cardRevision:card.cardRevision};
  if(selected.some(x=>!x.q))fail('source_changed','来源已更新，请重新选择引文');
  const quotes=selected.map(x=>x.q);
  const body=quotes.map(q=>'> '+q.text+'\n>\n> — '+[q.contentDay,q.title,q.chapter,q.page].filter(Boolean).join(' · ').replace(/[\r\n]+/g,' ')).join('\n\n')+(card.followup?'\n\n待补：'+card.followup:'');
  const record=api.save({kind:'article',origin:'ai',title:a.title,body,stage:'draft',sourceIds:[...new Set(quotes.map(q=>q.recordId))],reason:'从推荐起草'},{archive:true,inTransaction:true});
  card.targets.drafts.push({id:record.id});persist(card);return {status:'created',articleId:record.id,revision:record.revision,title:record.title,cardRevision:card.cardRevision};
 }
 function call(name,raw,actor='desktop',scopes=['read','create','update']){
  const def=assistTools[name];if(!def)throw Error('未知工具');
  const a=def.schema.parse(raw);
  if(!scopes.includes('read')||!scopes.includes(def.permission)||(a.enabled!==undefined&&!scopes.includes('update'))||(a.newThemeTitle&&!scopes.includes('create')))fail('permission_denied','当前凭据权限不足');
  if(a.expectedLibraryId&&a.expectedLibraryId!==lib())fail('library_changed','资料库已切换，请重新打开');
  purge();
  switch(name){
   case 'shiwen_recommendation_settings':{
    const old=settings();
    if(a.enabled===undefined)return {...old,libraryId:lib(),week:api.exploration.keys().week,timezone:api.exploration.timezone(),poolBased:true};
    if(!a.expectedLibraryId||!a.requestId||!a.revision)fail('invalid_request','缺少库、版本或请求编号');
    return libraryWrite(actor,name,a,()=>{checkRev(settings().revision,a.revision);const next=put('settings','weekly',{enabled:a.enabled,revision:a.revision+1,timezone:api.exploration.timezone()});api.exploration.sync.settingsChanged(next);return next;});
   }
   case 'shiwen_recommendation_refresh':{
    // Schedule synchronously while the authenticated caller still owns this operation.
    const result=api.exploration.arrange(actor,a,settings().enabled);
    return start(actor,'refresh:'+a.requestId,a,()=>result);
   }
   case 'shiwen_assist_analyze':return start(actor,'analyze:'+a.callId,a,async()=>{
    const result=await analyze(api,a);
    if(lib()!==a.expectedLibraryId)fail('library_changed','资料库已切换，请重新分析');
    const items=result.items.map(item=>{const c=newCard(item,null,actor);c.libraryId=a.expectedLibraryId;c.at=Date.now();manual.set(c.cardId,c);return detail(c,scopes);});
    return {...result,items};
   });
   case 'shiwen_assist_result':{
    if(a.jobId.startsWith('explore-'))return api.exploration.discovery.result(a.jobId,actor);
    const j=jobs.get(a.jobId);if(!j||j.actor!==actor||j.libraryId!==lib())fail('result_expired','任务不存在或已过期');const result=j.value?.items?{...j.value,candidates:j.value.candidates.map(q=>resolveQuote(api,q)).filter(Boolean),items:j.value.items.map(i=>manual.get(i.resultId)).filter(Boolean).map(c=>detail(c,scopes))}:j.value;
    return {status:j.status,...(j.progress?{progress:{...j.progress}}:{}),result,code:j.code,message:j.message};
   }
   case 'shiwen_recommendation_list':{
    if(['week','daily'].includes(a.view)){
     const feed=api.exploration.feed(a,settings().enabled);
     const changed=weekData(feed.week).published.map(id=>find('card',id)).filter(c=>c?.dailyChange?.day===feed.day&&!hasSkip(c,feed.week));
     feed.todayCount=summaries(changed,scopes,feed.day).filter(c=>c.todayUpdate).length;
     return feed;
    }
    const now=new Date(),week=monday(now),day=dateKey(now);
    const tomorrow=new Date(now);tomorrow.setHours(24,0,0,0);
    const ids=weekData(week).published;
    const cards=a.view==='later'?all('card').filter(c=>c.savedForLater):ids.map(id=>find('card',id)).filter(c=>c&&!hasSkip(c,week)&&(a.view!=='today'||c.dailyChange?.day===day));
    const items=summaries(cards,scopes,day).filter(c=>a.view==='later'||c.valid);
    const today=items.filter(c=>c.todayUpdate);
    const daily=dailyPicks(items,day);
    const result={...page(a.view==='daily'?daily:a.view==='today'?today:items,a.cursor),libraryId:lib(),week,day,nextDayAt:tomorrow.getTime(),todayCount:today.length};
    if(a.view==='week'&&!a.cursor){
     result.daily=daily;
     if(a.includeDetails)result.details=[...new Set([...result.items.slice(0,10),...daily].map(c=>c.cardId))].map(id=>detail(find('card',id),scopes,day));
    }
    return result;
   }
   case 'shiwen_recommendation_read':if(api.exploration.has(a.cardId))return api.exploration.card(a.cardId);return detail(resolveCard(a,actor),scopes);
   case 'shiwen_theme_read':{const {members,...t}=api.themeRead({id:a.themeId});return {...t,libraryId:lib(),...page(members,a.cursor)};}
   case 'shiwen_recommendation_feedback_list':return {...page(events().filter(f=>(!a.cardId||f.cardId===a.cardId)&&(!a.action||f.action===a.action)).map(f=>({...f,cardRevision:find('card',f.cardId)?.cardRevision})),a.cursor),libraryId:lib()};
   default:return libraryWrite(actor,name,a,()=>{const card=resolveCard(a,actor);checkRev(card.cardRevision,a.cardRevision??a.resultVersion);return business(card,name,a,scopes);});
  }
 }
 return {call};
}
