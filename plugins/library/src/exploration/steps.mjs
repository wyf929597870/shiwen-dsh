import {fail} from '../assist/evidence.mjs';
import {markdownSegments} from '../../legacy/markdown.mjs';

export const stepsDDL=`
 CREATE TABLE IF NOT EXISTS exploration_steps(
   question TEXT NOT NULL REFERENCES exploration_questions(id), id TEXT NOT NULL UNIQUE,
   data TEXT NOT NULL, created INTEGER NOT NULL, selected INTEGER NOT NULL, PRIMARY KEY(question,id));
 CREATE INDEX IF NOT EXISTS exploration_selected_steps ON exploration_steps(selected) WHERE selected>0;`;

export function explorationSteps({get,all,run,api,members,canonical}){
  function read(family,responses){
    const records=new Map(responses.map(r=>[r.recordId,r]));
    const rows=all('SELECT id,data,selected,created FROM exploration_steps WHERE question IN (SELECT value FROM json_each(?)) ORDER BY created,id',family);
    const steps=rows.map(({data,...row})=>{
      const step={...row,...JSON.parse(data)};
      if(step.responseId && records.get(step.responseId)?.revision!==step.responseRevision)delete step.quote;
      return step;
    });
    const nextStep=steps.filter(s=>s.selected).sort((a,b)=>b.selected-a.selected||a.id.localeCompare(b.id))[0]??null;
    return {steps,nextStep};
  }

  // Read just the selected rows when projecting the home feed, including merged questions.
  function choices(day){
    const due=[],later=new Set(),seen=new Set();
    const selected=all("SELECT question,json_extract(data,'$.reviewDay') AS day FROM exploration_steps WHERE selected>0 ORDER BY selected DESC,id");
    for(const r of selected){
      const id=canonical(r.question);
      if(seen.has(id))continue;
      seen.add(id);
      if(r.day && r.day>day)later.add(id);else due.push(id);
    }
    return {due,later};
  }

  function change(q,a){
    if(q.status!=='accepted'&&!(q.status==='pending'&&a.action==='add'&&a.accept))fail('revision_conflict','请先收下或继续探索这个问题');
    const family=JSON.stringify(members(q.id));
    const lookup=id=>get('SELECT * FROM exploration_steps WHERE id=? AND question IN (SELECT value FROM json_each(?))',id,family);
    const parent=a.parentId&&lookup(a.parentId);
    if(a.parentId&&!parent)fail('target_changed','这一步所属的探索分支已变化');
    const selected=Date.now();
    const clear=()=>run('UPDATE exploration_steps SET selected=0 WHERE selected>0 AND question IN (SELECT value FROM json_each(?))',family);
    if(a.action!=='add'){
      const target=lookup(a.stepId);
      if(!target||a.action==='pause'&&!target.selected)fail('target_changed','当前下一步已变化');
      if(a.action==='select'&&completed(target))fail('target_changed','这次尝试已有结果，请从结果继续');
      clear();
      if(a.action==='select')run('UPDATE exploration_steps SET selected=? WHERE id=?',selected,a.stepId);
      return;
    }
    function completed(step){
      return JSON.parse(step.data).kind==='trial' && get("SELECT 1 FROM exploration_steps WHERE question IN (SELECT value FROM json_each(?)) AND json_extract(data,'$.kind')='result' AND json_extract(data,'$.parentId')=?",family,step.id);
    }
    if(get('SELECT 1 FROM exploration_steps WHERE id=?',a.stepId))fail('revision_conflict','这一步已经存在');
    if(a.kind==='result'&&(!parent||JSON.parse(parent.data).kind!=='trial'||completed(parent)))fail('target_changed','请选择尚未记结果的尝试');
    let owner=parent?.question??q.id;
    if(a.responseId){
      const link=get('SELECT question FROM exploration_responses WHERE record=? AND question IN (SELECT value FROM json_each(?)) ORDER BY question LIMIT 1',a.responseId,family);
      const record=link&&api.get(a.responseId);
      if(!record||record.deleted||record.revision!==a.responseRevision ||
        a.quote&&!markdownSegments(record.doc,record.origin).some(s=>s.origin==='personal'&&s.text.includes(a.quote)))fail('source_changed','回应原文已变化，请重新选择');
      owner=link.question;
    }
    const data={kind:a.kind,text:a.text};
    for(const key of ['parentId','responseId','responseRevision','quote','observation','reviewDay','takeaway'])if(a[key]!==undefined)data[key]=a[key];
    clear();
    run('INSERT INTO exploration_steps(question,id,data,created,selected) VALUES(?,?,?,?,?)',owner,a.stepId,JSON.stringify(data),selected,selected);
  }
  return {read,choices,change};
}
