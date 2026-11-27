import {createExplorationSync} from './sync.mjs';
import {explorationSteps,stepsDDL} from './steps.mjs';
import {followupPassages,matchFollowup} from './followups.mjs';
import {markdownSegments} from '../../legacy/markdown.mjs';
import {dateKey} from '../../legacy/content.mjs';
import {createDiscovery,discoveryTables,discoveryDDL} from './discovery.mjs';
import {duplicateDecisions,duplicateTables,duplicatesDDL,similarQuestions} from './duplicates.mjs';
import {randomUUID} from 'node:crypto';
import {explorationTools} from '../../../../integration/exploration.mjs';
import {hash,fail} from '../assist/evidence.mjs';
import {eligibleForHome,locateSource,nextStatus,normalizedQuestion,periodKeys} from './rules.mjs';

export const explorationTables=['exploration_questions','exploration_evidence','exploration_discoveries','exploration_reviews',
  'exploration_responses','exploration_periods','exploration_events','exploration_receipts',...duplicateTables,...discoveryTables,'exploration_clues','exploration_steps'];
const parse=JSON.parse;
const json=JSON.stringify;
const schema=`
  CREATE TABLE IF NOT EXISTS exploration_questions(
    id TEXT PRIMARY KEY, type TEXT NOT NULL, original TEXT NOT NULL, normalized TEXT NOT NULL,
    wording TEXT, status TEXT NOT NULL, previous_status TEXT, revision INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS exploration_status ON exploration_questions(status);
  CREATE TABLE IF NOT EXISTS exploration_evidence(
    question TEXT NOT NULL REFERENCES exploration_questions(id),record TEXT NOT NULL,revision INTEGER NOT NULL,
    anchor TEXT NOT NULL,source TEXT NOT NULL,confirmed INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(question,anchor));
  CREATE INDEX IF NOT EXISTS exploration_source ON exploration_evidence(record,question);
  CREATE TABLE IF NOT EXISTS exploration_discoveries(
    id TEXT PRIMARY KEY,actor TEXT NOT NULL,item TEXT NOT NULL,question TEXT NOT NULL REFERENCES exploration_questions(id),
    sources TEXT NOT NULL,UNIQUE(actor,item));
  CREATE TABLE IF NOT EXISTS exploration_reviews(
    id TEXT PRIMARY KEY,actor TEXT NOT NULL,item TEXT NOT NULL,reason TEXT NOT NULL,payload TEXT NOT NULL,
    candidates TEXT NOT NULL,revision INTEGER NOT NULL,resolution TEXT,UNIQUE(actor,item));
  CREATE TABLE IF NOT EXISTS exploration_responses(
    question TEXT NOT NULL REFERENCES exploration_questions(id),record TEXT NOT NULL,PRIMARY KEY(question,record));
  CREATE TABLE IF NOT EXISTS exploration_clues(
    question TEXT NOT NULL REFERENCES exploration_questions(id),record TEXT NOT NULL,revision INTEGER NOT NULL,
    wording TEXT NOT NULL,passage TEXT NOT NULL,dismissed INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(question,record));
  CREATE INDEX IF NOT EXISTS exploration_clue_record ON exploration_clues(record);
  CREATE TABLE IF NOT EXISTS exploration_periods(
    period TEXT NOT NULL,period_key TEXT NOT NULL,pins TEXT NOT NULL,auto TEXT NOT NULL,
    revision INTEGER NOT NULL,batch INTEGER NOT NULL,PRIMARY KEY(period,period_key));
  CREATE TABLE IF NOT EXISTS exploration_events(
    seq INTEGER PRIMARY KEY AUTOINCREMENT,kind TEXT NOT NULL,target TEXT NOT NULL,payload TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS exploration_receipts(
    actor TEXT NOT NULL,id TEXT NOT NULL,fingerprint TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(actor,id));
  CREATE TRIGGER IF NOT EXISTS exploration_record_changed AFTER UPDATE OF revision,deleted ON records
  WHEN (OLD.revision<>NEW.revision OR OLD.deleted<>NEW.deleted)
    AND EXISTS(SELECT 1 FROM exploration_evidence WHERE record=NEW.id)
  BEGIN INSERT INTO exploration_events(kind,target,payload) VALUES('source_changed',NEW.id,
    json_object('revision',NEW.revision,'deleted',NEW.deleted)); END;
`;
const anchor=s=>hash([s.recordId,s.revision,s.scope,s.field,s.excerptIndex,s.start,s.end,s.annotationId,s.annotationRevision,s.originalVersionId]);
// Preserve independent provenance rows, but compare the position in the cited text.
const position=s=>s.field==='annotation'?anchor(s):hash([s.recordId,s.revision,s.scope,s.field,s.excerptIndex,s.start,s.end]);
const recordSet=sources=>new Set(sources.map(s=>s.recordId));
const limits={day:2,week:10};

export function createExplorationStore(db,api){
  db.transaction(()=>{
    const version=db.prepare("SELECT value FROM meta WHERE key='exploration_schema'").get()?.value;
    if(version&&version!=='1')throw Error('探索池数据版本不受支持');
    db.exec(schema+duplicatesDDL+discoveryDDL+stepsDDL);
    if(!db.prepare('PRAGMA table_info(exploration_responses)').all().some(c=>c.name==='passage')){
      db.exec("ALTER TABLE exploration_responses ADD COLUMN passage TEXT");
      for(const action of ['INSERT','UPDATE','DELETE'])db.exec('DROP TRIGGER IF EXISTS stream_exploration_responses_'+action);
    }
    if(!db.prepare('PRAGMA table_info(exploration_responses)').all().some(c=>c.name==='linked_at')){
      db.exec('ALTER TABLE exploration_responses ADD COLUMN linked_at INTEGER NOT NULL DEFAULT 0');
      for(const action of ['INSERT','UPDATE','DELETE'])db.exec('DROP TRIGGER IF EXISTS stream_exploration_responses_'+action);
    }
    if(!db.prepare('PRAGMA table_info(exploration_periods)').all().some(c=>c.name==='seen')){
      db.exec("ALTER TABLE exploration_periods ADD COLUMN seen TEXT NOT NULL DEFAULT '[]'");
      for(const action of ['INSERT','UPDATE','DELETE'])db.exec('DROP TRIGGER IF EXISTS stream_exploration_periods_'+action);
    }
    db.prepare("INSERT OR IGNORE INTO meta VALUES('exploration_schema','1')").run();
    db.prepare("INSERT OR IGNORE INTO meta VALUES('exploration_timezone',?)").run(Intl.DateTimeFormat().resolvedOptions().timeZone);
  })();
  const lib=()=>api.themeContext().libraryId;
  const get=(sql,...args)=>db.prepare(sql).get(...args);
  const all=(sql,...args)=>db.prepare(sql).all(...args);
  const run=(sql,...args)=>db.prepare(sql).run(...args);
  const row=id=>get('SELECT * FROM exploration_questions WHERE id=?',id);
  const event=(kind,target,value)=>run('INSERT INTO exploration_events(kind,target,payload) VALUES(?,?,?)',kind,target,json(value));
  const timezone=()=>get("SELECT value FROM meta WHERE key='exploration_timezone'").value;
  const keys=(now=new Date())=>periodKeys(now,timezone());
  const checkLibrary=id=>{if(id!==lib())fail('library_changed','资料库已切换，请重新读取');};
  const duplicates=duplicateDecisions({get,all,run,row,event,keys,periodState,savePeriod});
  const steps=explorationSteps({get,all,run,api,members:duplicates.members,canonical:duplicates.canonical});
  function checkQuestion(args){
    const q=row(args.questionId);
    if(!q)fail('question_missing','问题不存在');
    if(duplicates.canonical(q.id)!==q.id)fail('target_changed','问题已合并，请重新核对目标');
    if(q.revision!==args.expectedRevision)fail('revision_conflict','问题已更新，请重新读取',q.revision);
    return q;
  }
  function receipt(actor,method,args,fn){
    return db.transaction(()=>{
      checkLibrary(args.expectedLibraryId);
      const fingerprint=hash([method,args]);
      const previous=get('SELECT * FROM exploration_receipts WHERE actor=? AND id=?',actor,args.requestId);
      if(previous){
        if(previous.fingerprint!==fingerprint)fail('request_conflict','请求编号已用于不同内容');
        return parse(previous.result);
      }
      const result=fn();
      run('INSERT INTO exploration_receipts VALUES(?,?,?,?)',actor,args.requestId,fingerprint,json(result));
      return result;
    })();
  }
  function sourcesFor(id,live=true){
    const rows=live?all(`SELECT e.source,e.confirmed FROM exploration_evidence e JOIN records r ON r.id=e.record
      WHERE e.question IN (SELECT value FROM json_each(?)) AND r.deleted=0 AND r.revision=e.revision
        AND (json_extract(e.source,'$.annotationId') IS NULL OR EXISTS(
          SELECT 1 FROM records ann JOIN annotation_relations rel ON rel.record_id=ann.id
          JOIN records parent ON parent.id=rel.original_id WHERE parent.deleted=0 AND ann.deleted=0
          AND ann.id=json_extract(e.source,'$.annotationId') AND ann.revision=json_extract(e.source,'$.annotationRevision')
          AND rel.version_id=json_extract(e.source,'$.originalVersionId'))) ORDER BY e.rowid`,json(duplicates.members(id))):
      all('SELECT source,confirmed FROM exploration_evidence WHERE question=? ORDER BY rowid',id);
    const sources=new Map();
    for(const r of rows){const s=parse(r.source),key=position(s);if(r.confirmed||!sources.has(key))sources.set(key,r.confirmed?{...s,personal:true,confirmed:true}:s);}
    return [...sources.values()];
  }
  function periodState(period,key){
    const p=get('SELECT * FROM exploration_periods WHERE period=? AND period_key=?',period,key);
    return p?{pins:parse(p.pins),auto:parse(p.auto),seen:parse(p.seen),revision:p.revision,batch:p.batch}:{pins:[],auto:[],seen:[],revision:0,batch:0};
  }
  function savePeriod(period,key,p){
    const previous=periodState(period,key);
    const added=p.auto.filter(id=>!previous.auto.includes(id));
    const seen=(p.seen??previous.seen).filter(id=>!added.includes(id));
    run('INSERT OR REPLACE INTO exploration_periods(period,period_key,pins,auto,revision,batch,seen) VALUES(?,?,?,?,?,?,?)',
      period,key,json(p.pins),json(p.auto),p.revision,p.batch,json([...seen,...added]));
    event('period',key,{period,revision:p.revision,batch:p.batch});
  }
  function responsesFor(family){
    const responseRows=all(`SELECT r.id AS recordId,r.revision,r.title,r.kind,r.created,e.passage,e.linked_at AS linkedAt,
      CASE WHEN i.record IS NOT NULL THEN i.day WHEN d.record IS NOT NULL THEN d.day ELSE '' END AS day,
      (SELECT substr(trim(json_extract(value,'$.text')),1,180) FROM sync_record_sources ss,json_each(ss.sources)
        WHERE ss.record_id=r.id AND json_extract(value,'$.origin')='personal' AND trim(json_extract(value,'$.text'))<>'' LIMIT 1) AS preview
      FROM exploration_responses e JOIN records r ON r.id=e.record LEFT JOIN imports i ON i.record=r.id
      LEFT JOIN record_dates d ON d.record=r.id WHERE e.question IN (SELECT value FROM json_each(?)) AND r.deleted=0`,family);
    const ordered=responseRows.map(({passage,day,preview,...r})=>{
      const citation=passage?parse(passage):null;
      const valid=citation?.revision===r.revision;
      if(!valid && preview==null){
        const old=get('SELECT doc,origin FROM records WHERE id=?',r.recordId);
        preview=markdownSegments(parse(old.doc),old.origin).find(s=>s.origin==='personal'&&s.text.trim())?.text.trim().slice(0,180);
      }
      return {...r,contentDay:day===''?dateKey(r.created):day,preview:valid?citation.quote.slice(0,180):preview??'',
        ...(valid?{passage:citation}:{})};
    }).sort((a,b)=>b.linkedAt-a.linkedAt||(b.contentDay??'').localeCompare(a.contentDay??'')||b.created.localeCompare(a.created)||a.recordId.localeCompare(b.recordId));
    const distinct=new Map();
    for(const response of ordered)if(!distinct.has(response.recordId))distinct.set(response.recordId,response);
    return [...distinct.values()];
  }
  function detail(q){
    if(!q)fail('question_missing','问题不存在');
    q=row(duplicates.canonical(q.id));
    const dates=keys(),sources=sourcesFor(q.id);
    const family=json(duplicates.members(q.id));
    const responses=responsesFor(family);
    const clues=q.status==='accepted'&&sources.length?pendingClues(q,family):[];
    return {libraryId:lib(),questionId:q.id,type:q.type,originalText:q.original,text:q.wording??q.original,
      status:q.status,revision:q.revision,sources,responses,clues,...steps.read(family,responses),possibleDuplicates:duplicates.matches(q.id),mergedQuestions:duplicates.parents(q.id),placements:Object.fromEntries(Object.entries(dates).map(([period,key])=>{
        const p=periodState(period,key);
        return [period,{key,revision:p.revision,pinned:p.pins.includes(q.id)}];
      }))};
  }
  function pendingClues(q,family=json(duplicates.members(q.id))){
    return all(`SELECT c.passage FROM exploration_clues c JOIN records r ON r.id=c.record
      WHERE c.question IN (SELECT value FROM json_each(?)) AND c.dismissed=0 AND c.wording=?
      AND r.deleted=0 AND r.revision=c.revision AND NOT EXISTS (SELECT 1 FROM exploration_responses e
        WHERE e.question IN (SELECT value FROM json_each(?)) AND e.record=c.record)
      AND NOT EXISTS (SELECT 1 FROM exploration_evidence e WHERE e.question IN (SELECT value FROM json_each(?)) AND e.record=c.record)
      ORDER BY json_extract(c.passage,'$.contentDay') DESC,r.created DESC,r.id LIMIT 3`,
      family,q.wording??q.original,family,family).map(c=>parse(c.passage));
  }
  function discoverFollowups(record){
    const passages=followupPassages(record);
    if(!passages.length||!record.contentDay)return;
    const matches=[];
    for(const q of all("SELECT * FROM exploration_questions WHERE status='accepted' ORDER BY id")){
      const wording=q.wording??q.original,sources=sourcesFor(q.id);
      if(!sources.length||sources.some(s=>s.recordId===record.id)||!sources.some(s=>s.contentDay && (s.contentDay<record.contentDay ||
        s.contentDay===record.contentDay && get('SELECT created FROM records WHERE id=?',s.recordId).created<record.created)))continue;
      const family=json(duplicates.members(q.id));
      if(get('SELECT 1 FROM exploration_responses WHERE question IN (SELECT value FROM json_each(?)) AND record=?',family,record.id))continue;
      const context=[responsesFor(family)[0]?.preview,...sources.filter(s=>s.personal).map(s=>s.quote)].filter(Boolean).join(' ');
      const match=matchFollowup(passages,wording,context);
      if(match)matches.push({...match,q,wording});
    }
    for(const {q,wording,locator} of matches.sort((a,b)=>b.score-a.score).slice(0,3)){
      const passage={...locateSource(record,locator),created:record.created};
      if(!passage.personal||passage.scope!=='passage')continue;
      run(`INSERT INTO exploration_clues(question,record,revision,wording,passage) VALUES(?,?,?,?,?)
        ON CONFLICT(question,record) DO UPDATE SET revision=excluded.revision,wording=excluded.wording,passage=excluded.passage
        WHERE dismissed=0 AND (revision<>excluded.revision OR wording<>excluded.wording OR passage<>excluded.passage)`,
        q.id,record.id,record.revision,wording,json(passage));
    }
  }
  function pendingReview(actor,item,reason,candidates){
    const old=get('SELECT * FROM exploration_reviews WHERE actor=? AND item=?',actor,item.externalItemId);
    const id=old?.id??randomUUID();
    run(`INSERT INTO exploration_reviews VALUES(?,?,?,?,?,?,1,NULL) ON CONFLICT(actor,item) DO UPDATE SET
      payload=excluded.payload,candidates=excluded.candidates,reason=excluded.reason,resolution=NULL,revision=exploration_reviews.revision+1
      WHERE payload<>excluded.payload OR candidates<>excluded.candidates OR reason<>excluded.reason`,id,actor,item.externalItemId,reason,json(item),json(candidates));
    return {externalItemId:item.externalItemId,status:'needs_review',reason,reviewItemId:id,candidates};
  }
  function putSuggestion(actor,item){
    const {externalItemId,type,text}=item;
    if(item.sources.some(s=>!s.recordId)){
      const prior=get('SELECT payload,resolution FROM exploration_reviews WHERE actor=? AND item=?',actor,externalItemId);
      if(prior?.resolution&&prior.payload===json(item)){
        const solved=parse(prior.resolution);
        return {...solved,status:'existing',sources:sourcesFor(solved.questionId)};
      }
      return pendingReview(actor,item,'source_unmapped',[]);
    }
    const sources=[],changed=new Set();
    for(const source of item.sources){
      const record=api.get(source.recordId);
      if(!record||record.deleted||record.revision!==source.revision){changed.add(source.recordId);continue;}
      const annotation=source.annotationId?api.get(source.annotationId):record.kind==='ai_annotation'?record:null;
      const original=annotation?.annotationOf;
      if(source.annotationId||annotation){
        if(!original||annotation.deleted||source.annotationId&&annotation.revision!==source.annotationRevision||
          source.originalVersionId&&source.originalVersionId!==original.versionId||
          ![original.recordId,annotation.id].includes(record.id)||api.get(original.recordId)?.deleted){
          changed.add(source.annotationId??record.id);continue;
        }
      }
      const citeAnnotation=annotation&&source.field==='annotation';
      const located=locateSource(citeAnnotation?annotation:record,source);
      sources.push({...located,recordId:record.id,revision:record.revision,...(annotation?{
        annotationId:annotation.id,annotationRevision:annotation.revision,originalVersionId:original.versionId
      }:{})});
    }
    if(changed.size)return {externalItemId,status:'source_changed',recordIds:[...changed]};
    const normalized=normalizedQuestion(text),records=recordSet(sources);
    const known=get('SELECT * FROM exploration_discoveries WHERE actor=? AND item=?',actor,externalItemId);
    let target=known&&row(known.question);
    if(target&&(target.type!==type||target.normalized!==normalized))return pendingReview(actor,item,'revised_discovery',[target.id]);
    if(known){
      const previous=parse(known.sources),aligned=sources.some(s=>previous.some(p=>p.recordId===s.recordId));
      const contradicts=sources.some(s=>s.scope==='passage'&&previous.some(p=>p.recordId===s.recordId&&p.revision===s.revision&&p.scope==='passage')&&
        !previous.some(p=>position(p)===position(s)));
      if(!aligned||contradicts)return pendingReview(actor,item,'revised_discovery',[target.id]);
    }
    let related=[];
    if(!known){
      const candidates=all(`SELECT DISTINCT q.* FROM exploration_questions q JOIN exploration_evidence e ON q.id=e.question
        WHERE q.normalized=? AND q.type=? AND e.record IN (SELECT value FROM json_each(?))`,normalized,type,json([...records]));
      const exact=candidates.filter(q=>{
        const prior=sourcesFor(q.id,false),oldRecords=recordSet(prior);
        const sharedPassage=sources.some(s=>s.scope==='passage'&&prior.some(p=>position(p)===position(s)));
        const compatible=sources.every(s=>s.scope==='record'||!prior.some(p=>p.recordId===s.recordId&&p.scope==='passage')||
          prior.some(p=>position(p)===position(s)));
        return compatible&&(sharedPassage||(records.size===oldRecords.size&&[...records].every(r=>oldRecords.has(r))));
      });
      if(exact.length===1)target=exact[0];
      else{
        related=all(`SELECT DISTINCT q.* FROM exploration_questions q JOIN exploration_evidence e ON q.id=e.question
          WHERE q.type=? AND e.record IN (SELECT value FROM json_each(?))`,type,json([...records])).filter(q=>
          similarQuestions(q.normalized,normalized)||q.id===item.relatedQuestionId);
      }
    }
    const questionId=target?.id??(actor.startsWith('bound:')?hash(['phone-question',actor,externalItemId]):randomUUID());
    if(!target)run('INSERT INTO exploration_questions VALUES(?,?,?,?,NULL,?,NULL,1)',questionId,type,text,normalized,'pending');
    if(!known)run('INSERT INTO exploration_discoveries VALUES(?,?,?,?,?)',randomUUID(),actor,externalItemId,questionId,json(sources));
    let added=0;
    for(const source of sources)added+=run('INSERT OR IGNORE INTO exploration_evidence(question,record,revision,anchor,source) VALUES(?,?,?,?,?)',
      questionId,source.recordId,source.revision,anchor(source),json(source)).changes;
    if(target&&added)run('UPDATE exploration_questions SET revision=revision+1 WHERE id=?',questionId);
    if(!known||added)event('discovery',questionId,{actor,externalItemId});
    const current=duplicates.canonical(questionId);
    for(const other of related){
      const shared=sourcesFor(other.id,false).map(s=>s.recordId).filter(id=>records.has(id));
      duplicates.mark(current,duplicates.canonical(other.id),shared);
    }
    const matches=duplicates.matches(current);
    if(matches.length){
      const pending=pendingReview(actor,item,'possible_duplicate',matches.map(q=>q.questionId));
      return {...pending,questionId:current,sources,matches};
    }
    return {externalItemId,status:target?'existing':'created',questionId:current,sources};
  }
  function reviewDetail(r){
    if(!r)fail('review_missing','待核对项不存在');
    return {reviewItemId:r.id,reason:r.reason,revision:r.revision,discovery:parse(r.payload),
      candidates:parse(r.candidates),resolution:r.resolution?parse(r.resolution):null};
  }
  function resolveSource(a,actor){
    const r=get('SELECT * FROM exploration_reviews WHERE id=?',a.reviewItemId);
    if(!r||r.reason!=='source_unmapped')fail('review_missing','来源待核对项不存在');
    if(r.revision!==a.expectedReviewRevision||r.resolution)fail('revision_conflict','核对项已更新',r.revision);
    const item=parse(r.payload),mapped=new Map(a.mappings.map(m=>[m.externalSourceId,{recordId:m.recordId,revision:m.revision}]));
    const required=new Set(item.sources.map(s=>s.externalSourceId).filter(Boolean));
    if(mapped.size!==a.mappings.length||mapped.size!==required.size||[...required].some(id=>!mapped.has(id)))throw Error('请核对全部未映射来源');
    const result=putSuggestion(r.actor,{...item,sources:item.sources.map(s=>s.externalSourceId?mapped.get(s.externalSourceId):s)});
    if(result.status==='source_changed'||result.status==='needs_review')return result;
    const resolution={...result,decisionId:randomUUID()};
    run('UPDATE exploration_reviews SET resolution=?,revision=revision+1 WHERE id=?',json(resolution),r.id);
    event('source_resolved',r.id,{actor,decisionId:resolution.decisionId,questionId:resolution.questionId});
    return resolution;
  }
  function list(a){
    if(a.view==='reviews'||a.reason){
      const data=all('SELECT * FROM exploration_reviews WHERE resolution IS NULL AND (? IS NULL OR reason=?) ORDER BY rowid LIMIT 21 OFFSET ?',a.reason??null,a.reason??null,a.cursor??0);
      return {items:data.slice(0,20).map(reviewDetail),
        nextCursor:data.length>20?(a.cursor??0)+20:null};
    }
    const states={raw:['pending'],accepted:['accepted','observing','answered'],skipped:['skipped'],all:['pending','accepted','observing','answered','skipped']};
    const data=all(`SELECT q.* FROM exploration_questions q WHERE status IN (SELECT value FROM json_each(?))
      AND (? IS NULL OR type=?) AND (? IS NULL OR EXISTS(SELECT 1 FROM exploration_evidence e WHERE e.question=q.id AND record=?))
      ORDER BY q.rowid DESC LIMIT 21 OFFSET ?`,json(states[a.view]),a.type??null,a.type??null,a.recordId??null,a.recordId??null,a.cursor??0);
    return {items:data.slice(0,20).map(detail),nextCursor:data.length>20?(a.cursor??0)+20:null};
  }
  function review(a,actor){
    if(['merge','undo_merge','keep_separate'].includes(a.action)){
      const result=duplicates.change(a,actor);
      for(const id of [a.questionId,a.targetQuestionId]){
        if(duplicates.matches(id).length&&duplicates.canonical(id)===id)continue;
        run(`UPDATE exploration_reviews SET resolution=?,revision=revision+1 WHERE reason='possible_duplicate' AND resolution IS NULL
          AND EXISTS(SELECT 1 FROM exploration_discoveries d WHERE d.question=? AND d.actor=exploration_reviews.actor AND d.item=exploration_reviews.item)`,json({decisionId:result.decisionId,questionId:duplicates.canonical(id)}),id);
      }
      return {...detail(row(result.canonicalId)),...result};
    }
    const q=checkQuestion(a);
    if(a.action==='dismiss_clue'){
      const family=json(duplicates.members(q.id));
      if(!pendingClues(q,family).some(p=>p.recordId===a.recordId&&p.revision===a.sourceRevision))fail('source_changed','这条后续线索已变化');
      run('UPDATE exploration_clues SET dismissed=1 WHERE question IN (SELECT value FROM json_each(?)) AND record=? AND revision=?',family,a.recordId,a.sourceRevision);
    }else if(a.action==='confirm_personal_context'){
      const valid=sourcesFor(q.id).find(s=>s.recordId===a.recordId&&s.revision===a.sourceRevision&&s.scope==='record'&&s.hasPersonal);
      if(!valid)fail('source_changed','未找到这个版本的个人感想');
      run('UPDATE exploration_evidence SET confirmed=1 WHERE question IN (SELECT value FROM json_each(?)) AND anchor=?',json(duplicates.members(q.id)),anchor(valid));
    }else{
      if(a.action==='rewrite'&&!a.text)throw Error('请输入新的问法');
      const state=nextStatus(q,a.action);
      run('UPDATE exploration_questions SET status=?,previous_status=?,wording=COALESCE(?,wording) WHERE id=?',state,
        q.status==='skipped'?q.previous_status:q.status,['rewrite','accept'].includes(a.action)?a.text??null:null,q.id);
      if(state!=='accepted')removePlacements(q.id);
    }
    run('UPDATE exploration_questions SET revision=revision+1 WHERE id=?',q.id);
    const decisionId=randomUUID();
    event('review',q.id,{decisionId,actor,action:a.action,previousStatus:q.status});
    return {...detail(row(q.id)),decisionId};
  }
  function removePlacements(id){
    for(const [period,key] of Object.entries(keys())){
      const p=periodState(period,key);
      if(!p.pins.includes(id)&&!p.auto.includes(id))continue;
      if(p.pins.includes(id))p.revision++;
      p.pins=p.pins.filter(q=>q!==id);p.auto=p.auto.filter(q=>q!==id);p.batch++;
      savePeriod(period,key,p);
    }
  }
  function place(a,actor){
    const q=checkQuestion(a),key=keys()[a.period],p=periodState(a.period,key);
    if(a.periodKey!==key||a.expectedPlacementRevision!==p.revision)fail('revision_conflict','安排已变化，请重新读取',p.revision);
    if(a.action==='unpin'){p.pins=p.pins.filter(id=>id!==q.id);p.auto=p.auto.filter(id=>id!==q.id);p.seen=p.seen.filter(id=>id!==q.id);}
    else{
      if(!sourcesFor(q.id).length)fail('source_changed','当前没有有效来源');
      if(q.status!=='accepted'&&(!a.accept||q.status!=='pending'))throw Error('请先收下这个问题');
      p.pins=p.pins.filter(id=>eligibleForHome(row(id)?.status,sourcesFor(id),true));
      if(!p.pins.includes(q.id)){
        if(p.pins.length>=limits[a.period]){
          if(a.action!=='replace'||!p.pins.includes(a.replaceQuestionId))return {status:'full',replaceable:p.pins};
          p.pins[p.pins.indexOf(a.replaceQuestionId)]=q.id;
        }else p.pins.push(q.id);
      }
      if(q.status!=='accepted')review({...a,action:'accept'},actor);
    }
    p.revision++;p.batch++;savePeriod(a.period,key,p);
    return detail(row(q.id));
  }
  function respond(a){
    const q=checkQuestion(a);
    let record=api.get(a.responseRecordId);
    if(a.body!==undefined){
      if(record)fail('revision_conflict','回应记录 ID 已存在');
      record=api.save({id:a.responseRecordId,kind:'freewrite',origin:'personal',body:a.body},{inTransaction:true,allowCreateWithId:true});
    }else if(!record||record.deleted||record.revision!==a.sourceRevision||record.origin!=='personal')fail('source_changed','回应记录已变化');
    let passage=null;
    if(a.passage){
      if(a.body!==undefined||a.passage.recordId!==record.id||a.passage.revision!==record.revision)fail('source_changed','回应选段版本已变化');
      passage=locateSource(record,a.passage);
      if(passage.scope!=='passage'||!passage.personal)fail('source_changed','请选择能定位的个人原句');
    }
    const already=all('SELECT 1 FROM exploration_responses WHERE question IN (SELECT value FROM json_each(?)) AND record=? LIMIT 1',json(duplicates.members(q.id)),record.id).length;
    if(!already&&run('INSERT INTO exploration_responses(question,record,passage,linked_at) VALUES(?,?,?,?)',q.id,record.id,passage?json(passage):null,Date.now()).changes){
      run('UPDATE exploration_questions SET revision=revision+1 WHERE id=?',q.id);
      event('response',q.id,{recordId:record.id});
    }
    return detail(row(q.id));
  }
  function call(name,raw,actor='desktop',scopes=['read','create','update']){
    const def=explorationTools[name],a=def.schema.parse(raw);
    if(!scopes.includes('read')||!scopes.includes(def.permission)||(name==='shiwen_exploration_respond'&&a.body!==undefined&&!scopes.includes('create')))
      fail('permission_denied','当前凭据权限不足');
    checkLibrary(a.expectedLibraryId);
    if(name==='shiwen_exploration_list')return list(a);
    if(name==='shiwen_exploration_read')return a.reviewItemId?reviewDetail(get('SELECT * FROM exploration_reviews WHERE id=?',a.reviewItemId)):detail(row(a.questionId));
    if(name==='shiwen_exploration_settings'&&a.enabled===undefined&&a.model===undefined)return discovery.settings();
    if(name==='shiwen_exploration_settings'&&(!scopes.includes('update')||!a.requestId||a.expectedRevision===undefined))fail('permission_denied','修改整理设置需要更新权限和版本');
    return receipt(actor,name,a,()=>{
      switch(name){
        case 'shiwen_exploration_settings':return discovery.configure(a);
        case 'shiwen_exploration_import':return discovery.start(a.mode,actor);
        case 'shiwen_exploration_suggest':return {requestId:a.requestId,items:a.suggestions.map(item=>putSuggestion(actor,item))};
        case 'shiwen_exploration_step':{
          const q=checkQuestion(a);
          steps.change(q,a);
          if(q.status==='pending')run("UPDATE exploration_questions SET status='accepted',previous_status='pending' WHERE id=?",q.id);
          run('UPDATE exploration_questions SET revision=revision+1 WHERE id=?',q.id);
          return detail(row(q.id));
        }
        case 'shiwen_exploration_review':return a.action==='resolve_source'?resolveSource(a,actor):review(a,actor);
        case 'shiwen_exploration_place':return place(a,actor);
        case 'shiwen_exploration_respond':return respond(a);
        default:throw Error('未知探索操作');
      }
    });
  }
  const discovery=createDiscovery({db,api,lib,putSuggestion,discoverFollowups});
  function valid(ids,manual=false){
    return ids.filter(id=>eligibleForHome(row(id)?.status,sourcesFor(id),manual));
  }
  function arrange(actor,a,enabled){
    return receipt(actor,'shiwen_recommendation_refresh',a,()=>{
      const candidates=enabled?valid(all("SELECT id FROM exploration_questions WHERE status='accepted' ORDER BY (type='follow_up') DESC,rowid").map(q=>q.id)):[];
      const withClues=new Set(candidates.filter(id=>pendingClues(row(id)).length));
      let changed=0;
      const dates=keys(),week=periodState('week',dates.week);
      const fillingWeek=valid(week.auto).length+valid(week.pins,true).length<7;
      // A new opening fills a short week first. Once established the two
      // sections share a budget of two changed automatic slots.
      let budget=fillingWeek?Infinity:2;
      for(const period of ['week','day']){
        const key=dates[period],p=periodState(period,key),pins=valid(p.pins,true);
        const retained=valid(p.auto).filter(id=>!pins.includes(id));
        const capacity=limits[period]-pins.length;
        const order=new Map(p.seen.map((id,n)=>[id,n]));
        const others=candidates.filter(id=>!pins.includes(id)&&!retained.includes(id)).sort((a,b)=>Number(withClues.has(b))-Number(withClues.has(a))||(order.get(a)??-1)-(order.get(b)??-1));
        const initial=period==='week'?Math.min(7-pins.length,capacity):capacity;
        const slots=fillingWeek?Math.max(0,initial-retained.length):Math.min(1,capacity-retained.length);
        const add=others.slice(0,Math.min(Math.max(0,slots),budget));
        const next=retained.slice(0,capacity);
        if(!fillingWeek&&slots<=0&&next.length&&others.length&&budget>0){
          // Move one oldest automatic card out while retaining the other positions.
          next.shift();add.push(others[0]);
        }
        p.auto=[...next,...add];budget-=add.length;
        if(json(p.auto)!==json(periodState(period,key).auto)){
          changed+=add.length;p.batch++;savePeriod(period,key,p);
        }
      }
      return {changed};
    });
  }
  function card(id){
    const q=detail(row(id));
    return {...q,cardId:id,cardRevision:q.revision,question:q.text,scene:q.type,
      todayUpdate:null,reason:q.sources[0]?.title??'',quoteCount:q.sources.length,valid:q.status==='accepted'&&q.sources.length>0,
      quotes:q.sources.map(s=>({...s,quoteId:anchor(s),text:s.quote??'',sourceRevision:s.revision})),relations:[],
      targets:{decisions:[],themes:[],drafts:[]},availableActions:['read'],state:{skipped:q.status==='skipped'}};
  }
  function feed(a,enabled){
    const now=new Date(),{day,week}=keys(now);
    const {due,later}=steps.choices(day);
    const resume=valid(due,true);
    function ids(period,key){
      const p=periodState(period,key);
      const automatic=enabled?valid(p.auto).filter(id=>!later.has(id)):[];
      return [...new Set([...valid(p.pins,true),...resume,...automatic])];
    }
    const daily=ids('day',day).slice(0,2),weekly=[...new Set([...ids('week',week),...(enabled?valid(periodState('week',week).seen).filter(id=>!later.has(id)):[])])];
    const from=a.cursor??0,selected=a.view==='daily'?daily:weekly;
    const items=selected.slice(from,from+20).map(id=>({...card(id),alsoToday:daily.includes(id)}));
    // Day boundaries can fall at a different UTC offset after a DST change.
    let lo=now.getTime(),hi=lo+26*3600000;
    while(hi-lo>1000){const mid=Math.floor((lo+hi)/2);if(keys(mid).day===day)lo=mid;else hi=mid;}
    return {libraryId:lib(),day,week,items,nextCursor:from+20<selected.length?from+20:null,
      nextDayAt:hi,daily:daily.map(card),todayCount:0,
      batchVersion:periodState(a.view==='daily'?'day':'week',a.view==='daily'?day:week).batch,
      ...(a.includeDetails?{details:[...new Set([...daily,...weekly.slice(0,10)])].map(card)}:{})};
  }
  const sync=createExplorationSync(db,api,call,duplicates.canonical);
  return {call,sync,discovery,putSuggestion,arrange,feed,card,timezone,keys,has:id=>!!row(id)};
}
