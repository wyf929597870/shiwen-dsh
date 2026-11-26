import {randomUUID} from 'node:crypto';
import {fail,hash} from '../assist/evidence.mjs';

export const duplicateTables=['exploration_aliases','exploration_pairs','exploration_decisions'];
export const duplicatesDDL=`
 CREATE TABLE IF NOT EXISTS exploration_aliases(child TEXT PRIMARY KEY,parent TEXT NOT NULL,decision TEXT UNIQUE NOT NULL);
 CREATE INDEX IF NOT EXISTS exploration_alias_parent ON exploration_aliases(parent);
 CREATE TABLE IF NOT EXISTS exploration_pairs(left_id TEXT NOT NULL,right_id TEXT NOT NULL,basis TEXT NOT NULL,
   records TEXT NOT NULL,state TEXT NOT NULL,PRIMARY KEY(left_id,right_id,basis));
 CREATE TABLE IF NOT EXISTS exploration_decisions(id TEXT PRIMARY KEY,action TEXT NOT NULL,source TEXT NOT NULL,
   target TEXT NOT NULL,actor TEXT NOT NULL,data TEXT NOT NULL,undone TEXT);`;

function grams(text){
  const chars=[...text.normalize('NFKC').toLowerCase().replace(/[\s\p{P}]/gu,'')];
  return new Set(chars.slice(1).map((c,i)=>chars[i]+c));
}
export function similarQuestions(a,b){
  if(a===b)return true;
  if((a.match(/[\d.]+/g)??[]).join('|')!==(b.match(/[\d.]+/g)??[]).join('|'))return false;
  const x=grams(a),y=grams(b);
  let common=0;for(const gram of x)if(y.has(gram))common++;
  return common>=2&&2*common/(x.size+y.size)>=0.36;
}

export function duplicateDecisions({get,all,run,row,event,keys,periodState,savePeriod}){
  function canonical(id){
    return get(`WITH RECURSIVE chain(id) AS (VALUES(?) UNION SELECT parent FROM exploration_aliases JOIN chain ON child=chain.id)
      SELECT id FROM chain WHERE NOT EXISTS(SELECT 1 FROM exploration_aliases WHERE child=chain.id)`,id)?.id??id;
  }
  function members(id){
    return all(`WITH RECURSIVE family(id) AS (VALUES(?) UNION SELECT child FROM exploration_aliases JOIN family ON parent=family.id)
      SELECT id FROM family`,id).map(r=>r.id);
  }
  function mark(id,target,records){
    if(id===target)return;
    const [left,right]=[id,target].sort(),ids=[...new Set(records)].sort();
    const basis=hash([left,right,row(left).normalized,row(right).normalized,ids]);
    run("INSERT OR IGNORE INTO exploration_pairs VALUES(?,?,?,?,'pending')",left,right,basis,JSON.stringify(ids));
  }
  function matches(id){
    return all(`SELECT * FROM exploration_pairs WHERE state='pending' AND (left_id=? OR right_id=?)`,id,id).flatMap(pair=>{
      const other=pair.left_id===id?pair.right_id:pair.left_id;
      if(canonical(other)!==other||canonical(id)===other)return [];
      const q=row(other);
      return [{questionId:other,text:q.wording??q.original,originalText:q.original,revision:q.revision,
        evidenceFingerprint:pair.basis,recordIds:JSON.parse(pair.records)}];
    });
  }
  function parents(id){
    return all(`SELECT d.id AS decisionId,q.id AS questionId,q.original AS text,q.revision
      FROM exploration_aliases a JOIN exploration_decisions d ON d.id=a.decision
      JOIN exploration_questions q ON q.id=a.child WHERE a.parent=?`,id).map(r=>({...r}));
  }
  function change(a,actor){
    const from=row(a.questionId),to=row(a.targetQuestionId);
    if(!to||!from||from.id===to.id)fail('invalid_target','请选择两个不同的问题');
    if(from.revision!==a.expectedRevision||to.revision!==a.expectedTargetRevision)
      fail('revision_conflict','问题已变化，请重新核对',to.revision);
    if(canonical(to.id)!==to.id)fail('target_changed','保留题已合并，请重新读取');
    const decisionId=actor.startsWith('bound:')?hash([actor,a.requestId]):randomUUID();
    let data={};
    if(a.action==='undo_merge'){
      const prior=get('SELECT * FROM exploration_decisions WHERE id=? AND action=?',a.decisionId,'merge');
      if(!prior||prior.undone||prior.source!==from.id||prior.target!==to.id||canonical(from.id)!==to.id)fail('revision_conflict','这次合并已经变化');
      const before=JSON.parse(prior.data);
      run('DELETE FROM exploration_aliases WHERE child=? AND decision=?',from.id,prior.id);
      run('UPDATE exploration_questions SET status=? WHERE id=?',before.status,from.id);
      run('UPDATE exploration_decisions SET undone=? WHERE id=?',decisionId,prior.id);
      data={originalDecisionId:prior.id,pendingPlacements:[]};
      for(const item of before.periods){
        if(keys()[item.period]!==item.key)continue;
        const p=periodState(item.period,item.key);
        if(p.revision!==item.afterRevision||p.batch!==item.afterBatch){data.pendingPlacements.push(item);continue;}
        savePeriod(item.period,item.key,{...p,pins:item.pins,auto:item.auto,revision:p.revision+1,batch:p.batch+1});
      }
      // Evidence and responses kept their owning ID; newer writes to the target stay there.
    }else{
      if(canonical(from.id)!==from.id)fail('target_changed','原问题已合并');
      const [left,right]=[from.id,to.id].sort();
      if(a.action==='keep_separate'){
        const changed=run("UPDATE exploration_pairs SET state='separate' WHERE left_id=? AND right_id=? AND basis=? AND state='pending'",left,right,a.evidenceFingerprint);
        if(!changed.changes)fail('revision_conflict','比对依据已变化');
        data={evidenceFingerprint:a.evidenceFingerprint};
      }else{
        data={status:from.status,periods:[]};
        run('INSERT INTO exploration_aliases VALUES(?,?,?)',from.id,to.id,decisionId);
        run("UPDATE exploration_questions SET status='merged' WHERE id=?",from.id);
        for(const [period,key] of Object.entries(keys())){
          const p=periodState(period,key);
          if(!p.pins.includes(from.id)&&!p.auto.includes(from.id))continue;
          const replace=ids=>[...new Set(ids.flatMap(id=>id!==from.id?[id]:to.status==='accepted'?[to.id]:[]))];
          const pins=replace(p.pins),auto=replace(p.auto).filter(id=>!pins.includes(id));
          const revision=p.revision+1,batch=p.batch+1;
          data.periods.push({period,key,pins:p.pins,auto:p.auto,afterRevision:revision,afterBatch:batch});
          savePeriod(period,key,{pins,auto,revision,batch});
        }
      }
    }
    run('INSERT INTO exploration_decisions VALUES(?,?,?,?,?,?,NULL)',decisionId,a.action,from.id,to.id,actor,JSON.stringify(data));
    run('UPDATE exploration_questions SET revision=revision+1 WHERE id IN (?,?)',from.id,to.id);
    event(a.action,from.id,{decisionId,targetQuestionId:to.id,...data});
    return {decisionId,canonicalId:a.action==='merge'?to.id:from.id,mergedFrom:a.action==='merge'?from.id:undefined,...data};
  }
  return {canonical,members,mark,matches,parents,change};
}
