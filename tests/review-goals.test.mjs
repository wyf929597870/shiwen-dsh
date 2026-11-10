import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseJournalGoals,reviewGoalDays,goalSummary} from '../plugins/workbench/src/review-goals.mjs';
import {createStore} from '../plugins/library/legacy/store.mjs';
const table=rows=>'## 事项打卡\n\n| 项目 | 状态 |\n| --- | --- |\n'+rows.map(r=>'| '+r.join(' | ')+' |').join('\n');

test('legacy checks, blanks and missing goals stay distinct; quantities are never inferred from checks',()=>{
 for(const check of ['✓','√','✔','✅','☑','[x]']){
  const g=parseJournalGoals(table([['看书',check],['运动',''],['公众号',check]]));
  assert.equal(g.reading.completed,true);assert.equal(g.reading.value,null);
  assert.equal(g.exercise.recorded,true);assert.equal(g.exercise.completed,false);assert.equal(g.exercise.value,null);
  assert.equal(g.notes,undefined);assert.equal(g.publication.completed,true);
 }
});
test('minutes, hours, explicit zero and character counts have distinct units',()=>{
 const g=parseJournalGoals(table([['阅读','**✅ 1 小时 20 分钟**'],['运动','0 分钟'],['读书感想','1200 字'],['自由书写','-30 字']]));
 assert.equal(g.reading.value,80);assert.equal(g.exercise.value,0);assert.equal(g.exercise.completed,false);assert.equal(g.notes.value,1200);assert.equal(g.freewrite.value,null);
 assert.equal(parseJournalGoals(table([['阅读','30']])).reading.value,null);
 assert.equal(parseJournalGoals(table([['阅读','计划 30 分钟']])).reading.value,null);
 assert.equal(parseJournalGoals('| 项目 | 状态 | 分钟 |\n|---|---|---|\n|运动|✓|45|').exercise.value,45);
});
test('only explicit checklist facts are parsed; file titles and sections do not define record categories',()=>{
 const example='```md\n'+table([['阅读','100 分钟']])+'\n```';assert.equal(parseJournalGoals(example).reading,undefined);
 const g=parseJournalGoals(table([['自由书写','✓'],['日记','✓']])+'\n\n## 日记\n甲乙\n### 自由书写\n丙丁戊\n## 读书感想\n己庚');
 assert.equal(g.journal.value,null);assert.equal(g.freewrite.value,null);assert.equal(g.notes,undefined);
 assert.equal(parseJournalGoals(table([['日记','✓']])).journal.value,null);
 assert.equal(parseJournalGoals(table([['日记','✓']])+'\n\n今天晴。').journal.value,null);
 assert.equal(parseJournalGoals(table([['读书笔记','900 字']])+'\n\n## 读书笔记\n甲乙').notes.value,900);
 const titled={daily:[{day:'2026-11-01'}],records:[{id:'n',kind:'reference',title:'读书笔记：示例',contentDay:'2026-11-01',characters:99}]};
 assert.equal(reviewGoalDays(titled)[0].goals.notes,undefined);
});
test('journal and freewriting counts come only from their own files, independent of checklist numbers, headings and record order',()=>{
 const journal={id:'j',kind:'journal',contentDay:'2026-11-01',goalMarkdown:table([['自由书写','9999 字'],['日记','8888 字']])+'\n\n## 自由书写\n不能当成另一个文件的字数',characters:50};
 const freewrite={id:'f',kind:'freewrite',contentDay:'2026-11-01',characters:100};
 const another={...freewrite,id:'f2',characters:30};
 const later={...freewrite,id:'f3',contentDay:'2026-11-02',characters:20};
 const preview={daily:[{day:'2026-11-01'},{day:'2026-11-02'}],records:[freewrite,journal,another,freewrite,later]};
 for(const records of [preview.records,[...preview.records].reverse()]){
  const days=reviewGoalDays({...preview,records});
  assert.equal(days[0].goals.journal.value,50);assert.equal(days[0].goals.freewrite.value,130);
  assert.equal(days[1].goals.freewrite.value,20);assert.equal(days[1].goals.journal,undefined);
 }
 const checkOnly=reviewGoalDays({...preview,records:[journal]})[0].goals.freewrite;
 assert.equal(checkOnly.value,null);assert.equal(checkOnly.completed,true);
});
test('summary excludes check-only/missing days from numerical average and includes explicit zero',()=>{
 const days=[{goals:{reading:{value:30,completed:true,recorded:true}}},{goals:{reading:{value:0,completed:false,recorded:true}}},{goals:{reading:{value:null,completed:true,recorded:true}}},{goals:{}}];
 assert.deepEqual(goalSummary(days,'reading'),{total:30,numericDays:2,average:15,completedDays:2,recordedDays:3,checkOnlyDays:1});
 assert.equal(goalSummary([{goals:{reading:{value:null,completed:true,recorded:true}}}],'reading').total,null);
});
test('reserved reading notes sum independent files and replace checklist quantities regardless of order',()=>{
 const records=[
  {id:'j',kind:'journal',contentDay:'2026-11-01',characters:20,goalMarkdown:table([['读书感想','999 字']])},
  {id:'n1',kind:'reading_note',contentDay:'2026-11-01',characters:12},
  {id:'n2',kind:'reading_note',contentDay:'2026-11-01',characters:8},
  {id:'old',kind:'reference',title:'读书笔记',contentDay:'2026-11-01',characters:1000},
  {id:'check',kind:'journal',contentDay:'2026-11-02',characters:10,goalMarkdown:table([['读书笔记','✓']])},
 ];
 const daily=[{day:'2026-11-01'},{day:'2026-11-02'}];
 for(const rows of [records,[...records].reverse(),[...records,records[1]]]){
  const days=reviewGoalDays({daily,records:rows});
  assert.equal(days[0].goals.notes.value,20);
  assert.equal(days[1].goals.notes.value,null);
  assert.equal(days[1].goals.notes.completed,true);
  assert.equal(goalSummary(days,'notes').total,20);
 }
 assert.equal(reviewGoalDays({daily,records:[records[0]]})[0].goals.notes.value,999);
 assert.equal(reviewGoalDays({daily,records:[records[0],{...records[1],characters:0}]})[0].goals.notes.value,0);
});
test('reading note category persists and uses existing personal totals without migrating references',t=>{
 const dir=mkdtempSync(join(tmpdir(),'shiwen-reading-notes-')),s=createStore(join(dir,'db.sqlite'));t.after(()=>{s.close();rmSync(dir,{recursive:true,force:true});});
 const save=(id,kind,origin='personal')=>s.saveDsh({kind,origin,day:'2026-11-01',body:'甲乙丙',title:'读书笔记',sessionId:'notes',messageId:id,role:'user',operationId:id});
 const old=save('old','reference'),note=save('new','reading_note');
 save('external','reading_note','external');save('ai','reading_note','ai');
 const args={period:'month',month:'2026-11',now:'2026-11-10T12:00:00Z',timeZone:'Asia/Shanghai'};
 let report=s.reviewPreview(args);
 assert.equal(report.personalOriginalCharacters,6);assert.equal(reviewGoalDays(report)[0].goals.notes.value,3);
 assert.equal(s.get(old.id).kind,'reference');assert.equal(s.searchRecords({kind:'reading_note'}).total,3);
 const edited=s.updateRecord({id:note.id,revision:note.revision,body:'甲乙'});
 report=s.reviewPreview(args);assert.equal(reviewGoalDays(report)[0].goals.notes.value,2);
 s.remove({id:note.id,revision:edited.revision});report=s.reviewPreview(args);
 assert.equal(report.personalOriginalCharacters,3);assert.equal(reviewGoalDays(report)[0].goals.notes,undefined);
});
test('review payload follows content date, edits, deletion and personal origin without changing existing totals',t=>{
 const dir=mkdtempSync(join(tmpdir(),'shiwen-review-goals-')),s=createStore(join(dir,'db.sqlite'));t.after(()=>{s.close();rmSync(dir,{recursive:true,force:true});});
 const args={period:'month',month:'2026-11',now:'2026-11-10T12:00:00Z',timeZone:'Asia/Shanghai'};
 const r=s.saveDsh({kind:'journal',origin:'personal',day:'2026-11-01',body:table([['看书','✓']]),sessionId:'test',messageId:'j',role:'user',operationId:'j'});
 s.saveDsh({kind:'reference',origin:'external',day:'2026-11-01',body:table([['看书','999 分钟']]),sessionId:'test',messageId:'e',role:'user',operationId:'e'});
 let report=s.reviewPreview(args);assert.equal(report.records.length,1);assert.equal(report.personalOriginalCharacters,report.records[0].characters);assert.equal(reviewGoalDays(report)[0].goals.reading.value,null);
 const edited=s.updateRecord({id:r.id,revision:r.revision,body:table([['看书','30 分钟']])});
 report=s.reviewPreview(args);assert.equal(reviewGoalDays(report)[0].goals.reading.value,30);assert.equal(reviewGoalDays(report)[9].goals.reading,undefined);
 s.remove({id:r.id,revision:edited.revision});assert.equal(s.reviewPreview(args).records.length,0);
});

test('goal file counts exactly reuse reviewPreview totals, content dates and provenance through edits and deletion',t=>{
 const dir=mkdtempSync(join(tmpdir(),'shiwen-goal-counts-')),s=createStore(join(dir,'db.sqlite'));t.after(()=>{s.close();rmSync(dir,{recursive:true,force:true});});
 const args={period:'month',month:'2026-11',now:'2026-11-10T12:00:00Z',timeZone:'Asia/Shanghai'};
 const save=(id,kind,body,origin='personal',day='2026-11-01')=>s.saveDsh({kind,body,origin,day,title:id,sessionId:'counts',messageId:id,role:'user',operationId:id});
 save('journal','journal',table([['自由书写','✓'],['日记','9999 字']])+'\n\n## 日记\n甲乙\n## 自由书写\n同名标题仍属于日记');
 const first=save('first','freewrite','甲 乙\n😀 ![图](attachment:12345678-1234-4234-8234-123456789abc)');
 const second=save('second','freewrite','丙丁');
 save('other-day','freewrite','戊','personal','2026-11-02');
 save('external','freewrite','不属于个人原文','external');
 save('ai','freewrite','不属于个人原文','ai');
 save('undated','freewrite','日期待确认','personal',null);
 const check=()=>{
  const report=s.reviewPreview(args),days=reviewGoalDays(report);
  for(const day of days)for(const kind of ['journal','freewrite']){
   const rows=report.records.filter(r=>r.kind===kind&&r.contentDay===day.day);
   if(rows.length)assert.equal(day.goals[kind].value,rows.reduce((n,r)=>n+r.characters,0));
  }
  assert.equal(report.personalOriginalCharacters,days.reduce((n,d)=>n+(d.goals.journal?.value??0)+(d.goals.freewrite?.value??0),0));
  return days;
 };
 assert.equal(check()[0].goals.freewrite.value,5);
 const edited=s.updateRecord({id:first.id,revision:first.revision,body:'甲乙丙丁'});
 assert.equal(check()[0].goals.freewrite.value,6);
 s.remove({id:second.id,revision:second.revision});assert.equal(check()[0].goals.freewrite.value,4);
 s.remove({id:first.id,revision:edited.revision});const completion=check()[0].goals.freewrite;assert.equal(completion.completed,true);assert.equal(completion.value,null);
});
