import {dailyPicks,rereadCandidates} from '../../plugins/library/src/assist/feed.mjs';
import {analyze,cachedPassages,clean,eligible,hash,resolveQuote} from '../../plugins/library/src/assist/evidence.mjs';

const dayOf=d=>[d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-');
function calendar(){
  const now=new Date(),monday=new Date(now),tomorrow=new Date(now);
  monday.setDate(now.getDate()-(now.getDay()+6)%7);tomorrow.setHours(24,0,0,0);
  return {day:dayOf(now),week:dayOf(monday),nextDayAt:tomorrow.getTime()};
}
function source(row){
  const segments=row.sourceSpans??row.sources??[];
  const exact=segments.map(s=>s.text).join('')===row.markdown;
  return {...row,sourceSpans:exact?segments:segments.length?[]:[{text:row.markdown,origin:row.origin}],updated:row.updated??row.updatedAt};
}
const freshState=()=>({version:0,enabled:false,revision:1,week:'',published:[],scanned:{},later:[],feedback:[],recent:[],opened:false});
const page=(items,cursor=0)=>({items:items.slice(cursor,cursor+20),nextCursor:cursor+20<items.length?cursor+20:null});

// One runtime per open library. The native database owns settings, cards and scan checkpoints.
export function phoneRecommendations(call,libraryId){
  const native=(method,args={})=>call(method,{...args,libraryId});
  const get=async key=>(await native('phoneRecData',{key})).value;
  const state=async()=>await get('state')??freshState();
  const card=id=>get('card-'+id);
  const jobs=new Map();let pending=null;
  async function commit(s,updated,receipt){
    const expected=s.version;
    await native('phoneRecCommit',{expected,state:{...s,version:expected+1},...(updated?{card:updated}:{}),...(receipt?{receipt}:{})});
    s.version++;
  }
  async function detail(c,day){
    if(!c)throw Error('推荐不存在');
    const records=new Map();
    for(const id of new Set(c.quotes.map(q=>q.recordId))){
      try{records.set(id,source(await native('recordRead',{id})));}catch(e){
        if(!/不存在|已删除|NOT_FOUND|RECORD_UNKNOWN|record not found|移入回收站/i.test(e.message))throw e;
      }
    }
    const quotes=c.quotes.map(q=>resolveQuote({get:id=>records.get(id)},q)??{...q,unavailable:true});
    const available=new Set(quotes.filter(q=>!q.unavailable).map(q=>q.quoteId));
    const relations=c.relations.filter(r=>!c.rejected?.includes(r.relationId)&&r.quoteIds.every(id=>available.has(id)));
    const supported=new Set(relations.flatMap(r=>r.quoteIds));
    const change=c.dailyChange,ids=change?.quoteIds.filter(id=>supported.has(id))??[];
    const todayUpdate=change?.day===day&&relations.length&&(change.kind==='created'||ids.length)?{...change,quoteIds:ids}:null;
    return {...c,reason:relations.at(-1)?.reason??'原关联已撤下或来源已变化。',followup:relations.at(-1)?.followup??'',targets:c.targets??{themes:[],decisions:[],drafts:[]},state:{savedForLater:!!c.savedForLater,skipped:c.skippedWeek===calendar().week},quotes,relations,todayUpdate,quoteCount:quotes.length,libraryId};
  }
  async function refresh(revision,week,progress,receipt){
    const assert=s=>{if(!s.enabled||s.revision!==revision||week!==calendar().week)throw Error('推荐设置或周次已变更');};
    const initial=await state();assert(initial);
    if(initial.week!==week){
      Object.assign(initial,{week,opened:false,published:[],scanned:{},inProgress:[]});
      await commit(initial);
    }
    const records=new Map();let after='';
    for(;;){
      const {rows}=await native('phoneRecSources',{after});
      if(!rows.length)break;
      for(const row of rows)records.set(row.id,source(row));
      after=rows.at(-1).id;
    }
    const rows=[...records.values()].filter(eligible),readPassages=cachedPassages();
    const seeds=rows.filter(r=>Date.parse(r.updated)>=Date.now()-7*86400000).sort((a,b)=>b.updated.localeCompare(a.updated))
      .map(row=>({row,fp:hash(readPassages(row).map(q=>[q.field,clean(q.text)]))})).filter(x=>initial.scanned[x.row.id]!==x.fp);
    progress.total=seeds.length;
    const cap=initial.opened?2:10,changed=new Set(initial.inProgress??[]);
    const previous=await Promise.all(initial.recent.slice(0,24).map(card));
    const known=new Map(previous.filter(Boolean).map(c=>[c.cardId,c]));
    const api={get:id=>records.get(id),generateAssist:async(instruction,input)=>(await native('phoneRecAnalyze',{instruction,input,revision})).text};
    let malformed=0,consecutive=0,modelFailure;
    for(const {row,fp} of seeds){
      if(changed.size>=cap)break;
      assert(await state());
      const prior=[...known.values()].sort((a,b)=>Number(b.quotes.some(q=>q.recordId===row.id))-Number(a.quotes.some(q=>q.recordId===row.id))).slice(0,24).map(c=>({id:c.cardId,question:c.question}));
      const result=await analyze(api,{scene:'weekly',question:row.title,mode:'analyze'},{seed:row,rows,readPassages,prior,limit:1});
      if(result.modelErrorCode==='model_format'){progress.checked++;malformed++;if(++consecutive===3)break;continue;}
      if(result.modelError){modelFailure=result.modelError;break;}
      consecutive=0;
      await publish(result.items[0],row,fp);progress.checked++;
    }
    async function publish(item,row,fp){
      if(item&&(await detail(item,calendar().day)).quotes.some(q=>q.unavailable))item=null;
      const s=await state();assert(s);if(row)s.scanned[row.id]=fp;
      let updated;
      if(item){
        const id=item.existingCardId??(item.scene==='revisit'?hash(['revisit',item.quotes[0].recordId]):hash(clean(item.question))),old=await card(id);
        const additions=item.quotes.filter(q=>!old?.quotes.some(prev=>prev.recordId===q.recordId&&prev.field===q.field&&clean(prev.text)===clean(q.text)));
        if(additions.length&&(!old||item.addsEvidence)&&old?.skippedWeek!==week){
          const quotes=[...(old?.quotes??[]),...additions];
          const remap=qid=>{
            const q=item.quotes.find(x=>x.quoteId===qid);
            return quotes.find(x=>x.recordId===q.recordId&&x.field===q.field&&clean(x.text)===clean(q.text))?.quoteId??qid;
          };
          const relations=[...(old?.relations??[]),...item.relations.filter(r=>!old?.relations.some(prev=>prev.relationId===r.relationId)).map(r=>({...r,quoteIds:r.quoteIds.map(remap)}))];
          const day=calendar().day,previous=old?.dailyChange?.day===day?old.dailyChange:null;
          updated={...old,...item,targets:old?.targets??{decisions:[],drafts:[],themes:[]},cardId:id,cardRevision:(old?.cardRevision??0)+1,quotes,relations,savedForLater:s.later.includes(id),week,
            dailyChange:(initial.opened||old)?{day,kind:old?(previous?.kind??'evidence'):'created',quoteIds:[...new Set([...(previous?.quoteIds??[]),...additions.map(q=>q.quoteId)])]}:null};
          known.set(id,updated);changed.add(id);s.inProgress=[...changed];
          s.published=[...changed,...s.published.filter(x=>!changed.has(x))];
          s.recent=[id,...s.recent.filter(x=>x!==id)].slice(0,24);
        }
      }
      await commit(s,updated);if(updated)progress.version++;return updated;
    }
    if(malformed&&changed.size<cap)modelFailure??=malformed+' 条模型回复格式有误，已核对的卡片已保存，可重试。';
    const batch=await state();assert(batch);
    const visible=new Set(),used=new Set(),seen=new Set(),covered=new Set(),backlog=[];
    for(const id of new Set([...batch.published,...batch.recent])){
      const c=await card(id);if(!c)continue;
      for(const q of c.quotes){used.add(q.recordId);seen.add(clean(q.text));}
      if(c.skippedWeek===week||!(await detail(c,calendar().day)).relations.length)continue;
      if(batch.published.includes(id)){
        visible.add(id);if(c.scene!=='revisit')for(const q of c.quotes)covered.add(q.recordId);
      }
      backlog.push(c);
    }
    const redundant=new Set(backlog.filter(c=>c.scene==='revisit'&&covered.has(c.quotes[0]?.recordId)).map(c=>c.cardId));
    for(const id of redundant)visible.delete(id);
    batch.published=batch.published.filter(id=>!redundant.has(id));
    for(const c of backlog){
      if(visible.size>=7)break;
      if(!visible.has(c.cardId)&&!redundant.has(c.cardId)&&c.skippedWeek!==c.week){batch.published.push(c.cardId);visible.add(c.cardId);}
    }
    await commit(batch);
    const scannedOpening=[...changed];
    for(const item of rereadCandidates(rows,used,readPassages,seen)){
      if(visible.size>=7&&(!initial.opened||changed.size>=2))break;
      const c=await publish(item);if(c)visible.add(c.cardId);
    }
    if(modelFailure){const s=await state();assert(s);s.inProgress=scannedOpening;await commit(s);throw Error(modelFailure);}
    const s=await state();assert(s);s.opened=true;s.inProgress=[];const result={week,libraryId,changed:changed.size};
    await commit(s,null,{...receipt,result});return result;
  }
  return async function rpc(method,a={}){
    if(a.expectedLibraryId&&a.expectedLibraryId!==libraryId)throw Error('资料库已切换');
    const {week,day,nextDayAt}=calendar();
    if(method==='shiwen_assist_result'){
      const job=jobs.get(a.jobId);if(!job)throw Object.assign(Error('任务已失效，请重试'),{code:'result_expired'});
      return {...job,progress:{...job.progress}};
    }
    const receipt=a.requestId?{key:'receipt-'+a.requestId,fingerprint:hash([method,a])}:null;
    const saved=receipt?await get(receipt.key):null;
    if(saved&&saved.fingerprint!==receipt.fingerprint)throw Error('请求编号冲突');
    if(saved&&method!=='shiwen_recommendation_refresh')return saved.result;
    const s=await state();
    switch(method){
      case 'shiwen_recommendation_settings':
        if(a.enabled!==undefined){
          if(s.revision!==a.revision)throw Error('设置已更新，请重试');
          s.enabled=a.enabled;s.revision++;await commit(s,null,{...receipt,result:{libraryId,week,enabled:s.enabled,revision:s.revision}});
        }
        return {libraryId,week,enabled:s.enabled,revision:s.revision};
      case 'shiwen_recommendation_refresh':{
        if(saved){
          const jobId=a.requestId;jobs.set(jobId,{status:'ready',progress:{checked:0,total:0,version:0},result:saved.result});return {jobId};
        }
        if(!s.enabled)throw Error('请先开启推荐');
        if(pending&&pending.week===week&&pending.revision===s.revision)return {jobId:pending.id};
        const jobId=crypto.randomUUID(),job={status:'pending',progress:{checked:0,total:0,version:0}};
        for(const [id,old] of jobs)if(old.status!=='pending')jobs.delete(id);
        jobs.set(jobId,job);pending={id:jobId,week,revision:s.revision};
        refresh(s.revision,week,job.progress,receipt).then(result=>Object.assign(job,{result,status:'ready'}),e=>Object.assign(job,{status:'failed',message:e.message})).finally(()=>{if(pending?.id===jobId)pending=null;});
        return {jobId};
      }
      case 'shiwen_recommendation_list':{
        const later=a.view==='later',ids=later?s.later:s.week===week?s.published:[];
        const list=[];
        for(const id of ids){
          const raw=await card(id);if(!raw||(!later&&raw.skippedWeek===week)||(a.view==='today'&&raw.dailyChange?.day!==day))continue;
          const c=await detail(raw,day);
          if(later||c.relations.length)list.push({cardId:id,cardRevision:c.cardRevision,question:c.question,scene:c.scene,reason:c.reason,quoteCount:c.quoteCount,todayUpdate:c.todayUpdate});
        }
        const today=list.filter(c=>c.todayUpdate);
        const daily=dailyPicks(list,day);
        return {...page(a.view==='daily'?daily:a.view==='today'?today:list,a.cursor),week,day,nextDayAt,libraryId,todayCount:today.length,...(a.view==='week'||!a.view?{daily}:{})};
      }
      case 'themeList':return (await native('workspaceThemes',{method,args:a})).result;
      case 'shiwen_assist_save_decision':
      case 'shiwen_assist_add_to_theme':
      case 'shiwen_assist_create_draft':{
        const current=await detail(await card(a.cardId),day);
        const quotes=(a.quoteIds??[]).map(id=>{
          const q=current.quotes.find(x=>x.quoteId===id&&!x.unavailable);
          if(!q)throw Error('原文已变化，请重新选择引文');return q;
        });
        return native('phoneRecAction',{method,args:a,quotes});
      }
      case 'shiwen_recommendation_read':return detail(await card(a.cardId),day);
      case 'shiwen_recommendation_feedback_list':{
        const result=page(s.feedback,a.cursor);
        for(const f of result.items)f.cardRevision=(await card(f.cardId))?.cardRevision;
        return result;
      }
      case 'shiwen_recommendation_feedback':{
        const c=await card(a.cardId);
        if(!c||c.cardRevision!==a.cardRevision)throw Error('卡片已更新，请重新打开');
        if(a.action==='save_later'||a.action==='remove_later'){
          c.savedForLater=a.action==='save_later';s.later=s.later.filter(id=>id!==c.cardId);if(c.savedForLater)s.later.unshift(c.cardId);
        }else if(a.action==='skip'){
          c.skippedWeek=week;s.feedback.unshift({feedbackId:crypto.randomUUID(),cardId:c.cardId,action:'skip',question:c.question,at:new Date().toISOString(),week,active:true});
        }else if(a.action==='reject_relation'){
          const relation=c.relations.find(r=>r.relationId===a.relationId);
          if(!relation||hash([...relation.quoteIds].sort())!==hash([...a.quoteIds].sort()))throw Error('关联已变化');
          c.rejected=[...new Set([...(c.rejected??[]),a.relationId])];
          s.feedback.unshift({feedbackId:crypto.randomUUID(),cardId:c.cardId,action:a.action,relationId:a.relationId,question:c.question,at:new Date().toISOString(),week,active:true});
        }else if(a.action==='undo'){
          const f=s.feedback.find(f=>f.feedbackId===a.feedbackId&&f.cardId===c.cardId&&f.active);if(!f)throw Error('反馈已变化');
          f.active=false;
          if(f.action==='reject_relation'&&!s.feedback.some(x=>x.active&&x.cardId===c.cardId&&x.relationId===f.relationId))c.rejected=c.rejected.filter(id=>id!==f.relationId);
          if(f.action==='skip'&&!s.feedback.some(x=>x.action==='skip'&&x.cardId===c.cardId&&x.week===c.skippedWeek&&x.active))delete c.skippedWeek;
        }else throw Error('未知反馈操作');
        c.cardRevision++;for(const f of s.feedback)if(f.cardId===c.cardId)f.cardRevision=c.cardRevision;
        const result={cardRevision:c.cardRevision,savedForLater:c.savedForLater};await commit(s,c,{...receipt,result});return result;
      }
      default:throw Error('未知推荐操作');
    }
  };
}

// A replica only reads the cache for the current PC and binding epoch. Mutations
// always go to the PC and never become a second, divergent local card history.
export function mobileRecommendationRpc(call,libraryId,role,binding={}){
  if(role==='standalone')return phoneRecommendations(call,libraryId);
  const remote=async(method,args)=>(await call('workspaceRemote',{libraryId,method,args})).result;
  const scoped=Boolean(binding.serverId&&binding.epoch);
  const cache=async(snapshot)=> (await call('phoneRecSnapshot',{libraryId,serverId:binding.serverId,epoch:binding.epoch,...(snapshot?{snapshot}:{})})).value;
  let settings;
  async function offline(method,a,stored){
    if(!scoped)throw Error('请先连接已绑定的电脑，同步推荐');
    const snapshot=stored??await cache();
    if(!snapshot)throw Error('手机还没有保存这台电脑的推荐，请先连接电脑并打开首页');
    if(method==='shiwen_recommendation_settings'&&a.enabled===undefined)return {...snapshot.settings,offline:true};
    if(method==='shiwen_recommendation_list'){
      const list=snapshot.list;
      if(!list)throw Error('尚无离线推荐，请先连接电脑');
      const {day,nextDayAt}=calendar();
      const weekly=list.items.map(c=>c.todayUpdate?.day===day?c:{...c,todayUpdate:null});
      const today=weekly.filter(c=>c.todayUpdate);
      const daily=list.day===day?list.daily:dailyPicks(weekly,day);
      const items=a.view==='today'?today:a.view==='daily'?daily:weekly;
      if(!['week','today','daily',undefined].includes(a.view))throw Error('连接电脑后可查看此列表');
      return {...list,items,daily,day,todayCount:today.length,cachedDay:list.day,offline:true,nextCursor:null,nextDayAt};
    }
    if(method==='shiwen_recommendation_read'){
      const card=snapshot.details?.find(c=>c.cardId===a.cardId);
      if(!card)throw Error('这张卡的详情尚未保存，请连接电脑后查看');
      return {...card,offline:true};
    }
    throw Error('此操作需要连接电脑');
  }
  return async(method,a={})=>{
    if(a.expectedLibraryId&&a.expectedLibraryId!==libraryId)throw Error('资料库已切换');
    if(['offline','no-network','service-error'].includes(binding.state))return offline(method,a);
    if(['identity-mismatch','login-required'].includes(binding.state))throw Error('请重新连接并验证资料库的电脑');
    const stamp=Date.now(),home=method==='shiwen_recommendation_list'&&(!a.view||a.view==='week')&&!a.cursor;
    const readOnly=method==='shiwen_recommendation_read'||method==='shiwen_recommendation_settings'&&a.enabled===undefined||method==='shiwen_recommendation_list';
    if(binding.state==='unbound')return offline(method,a);
    if(binding.state==='unknown'&&scoped&&readOnly){
      const stored=await cache();if(stored)return offline(method,a,stored);
    }
    let result;
    try{
      try{result=await remote(method,home&&scoped?{...a,includeDetails:true}:a);}
      catch(e){
        if(!home||!scoped||!/unrecognized.key|unknown.*includeDetails|includeDetails.*unknown/i.test(e.message))throw e;
        result=await remote(method,a);
      }
    }
    catch(error){
      if(scoped&&readOnly&&/offline|ENETUNREACH|ECONNREFUSED|unexpected end of stream|network is unreachable|failed to connect|connection refused|timeout|timed out|unable to resolve host|离线|无法连接|无法访问|网络未连接/i.test(error.message))return offline(method,a);
      throw error;
    }
    if(method==='shiwen_recommendation_settings'){
      settings={...result,libraryId,week:result.week??calendar().week};
      if(scoped&&!settings.enabled)await cache({stamp,settings,list:null,details:[]});
    }
    if(home){
      const daily=result.daily??dailyPicks(result.items,result.day);
      const {details:included,...list}=result;
      if(scoped&&settings?.enabled){
        const items=list.items.slice(0,10);
        const ids=[...new Set([...items,...daily].map(c=>c.cardId))];
        // Older desktops return only summaries, so fetch their visible evidence separately.
        const details=included??await Promise.all(ids.map(cardId=>remote('shiwen_recommendation_read',{expectedLibraryId:libraryId,cardId})));
        await cache({stamp,settings,list:{...list,items,daily,nextCursor:null},details});
      }
      return {...list,daily};
    }
    return result;
  };
}
