import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import Database from '../plugins/library/legacy/sqlite.mjs';
import {tmpdir} from 'node:os';
import {createStore} from '../plugins/library/legacy/store.mjs';
import {apply} from '../plugins/agent-tools/src/index.mjs';
import {readingNoteDraft} from '../plugins/library/legacy/reading-note.mjs';
import {reviewGoalDays,goalSummary} from '../plugins/workbench/src/review-goals.mjs';
const setup=t=>{const dir=mkdtempSync(join(tmpdir(),'shiwen-note-tools-')),store=createStore(join(dir,'library.sqlite'));t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});const credential=store.externalClientCreate({name:'test',scopes:['create','read','update','delete']});return {store,dir,call:(name,args)=>store.externalCall(store.externalAuthenticate(credential.token),name,args)};};
const note={requestId:'note',kind:'reading_note',origin:'personal',title:'测试书',body:'我的感想',day:'2026-11-10',readingNote:{chapter:'第一章',page:'12',excerpts:[{text:'这段摘录不应进入写作统计',page:'12'}]}};

test('MCP reading-note CRUD shares editor format, preserves metadata and retries atomically',t=>{
 const {store,call}=setup(t),saved=call('shiwen_save',note);
 assert.deepEqual(call('shiwen_save',note),saved);
 assert.equal(store.snapshot().records.length,1);
 assert.equal(readingNoteDraft(store.get(saved.id)).reflection,note.body);
 assert.deepEqual(readingNoteDraft(store.get(saved.id)).excerpts,note.readingNote.excerpts);
 assert.equal(call('shiwen_search',{kind:'reading_note',query:'测试书'}).total,1);
 const read=call('shiwen_read',{id:saved.id});assert.equal(read.body,note.body);assert.equal(read.readingNote.chapter,'第一章');
 const update={id:saved.id,revision:read.revision,requestId:'metadata',readingNote:{page:'13'}};
 const changed=call('shiwen_update',update);assert.equal(changed.readingNote.page,'13');assert.deepEqual(changed.readingNote.excerpts,note.readingNote.excerpts);
 assert.deepEqual(call('shiwen_update',update),changed);
 assert.equal(call('shiwen_read',{id:saved.id}).body,note.body);
 assert.throws(()=>call('shiwen_update',{...update,requestId:'stale',readingNote:{chapter:'错误'}}),/更新/);
 assert.throws(()=>call('shiwen_update',{...update,requestId:'oversized',revision:changed.revision,readingNote:{excerpts:[{text:'x'.repeat(9000)},{text:'y'.repeat(9000)}]}}),/过长/);
 assert.equal(store.get(saved.id).revision,changed.revision);
 const cleared=call('shiwen_update',{id:saved.id,revision:changed.revision,requestId:'clear',readingNote:{excerpts:[]}});
 assert.deepEqual(cleared.readingNote.excerpts,[]);assert.equal(cleared.readingNote.chapter,'第一章');
 assert.notEqual(call('shiwen_save',{...note,requestId:'second'}).id,saved.id);
 const deleted=call('shiwen_delete',{id:saved.id,revision:cleared.revision,requestId:'delete'});assert.equal(call('shiwen_search',{kind:'reading_note'}).total,1);
 call('shiwen_restore',{id:saved.id,revision:deleted.revision,requestId:'restore'});assert.equal(call('shiwen_search',{kind:'reading_note'}).total,2);
});

test('tool Review matches the panel and does not leak journal bodies or double count excerpts/checklists',t=>{
 const {store,call}=setup(t);call('shiwen_save',note);
 call('shiwen_save',{requestId:'journal',kind:'journal',origin:'personal',day:note.day,body:'私人日记\n\n| 项目 | 状态 |\n|---|---|\n| 阅读 | ✓ |\n| 运动 | 30 分钟 |\n| 读书笔记 | 999 字 |\n| 自由书写 | 999 字 |'});
 call('shiwen_save',{requestId:'free',kind:'freewrite',origin:'personal',day:note.day,body:'自由书写'});
 call('shiwen_save',{...note,requestId:'ai',origin:'ai',body:'AI感想'});
 const report=call('shiwen_review',{period:'1',day:note.day}),panel=store.reviewPreview({period:'1',now:note.day+'T12:00:00'}),days=reviewGoalDays(panel);
 assert.equal(report.originals.personalOriginalCharacters,panel.personalOriginalCharacters);
 assert.deepEqual(report.goals.summary.notes,goalSummary(days,'notes'));
 assert.equal(report.goals.summary.notes.total,4);assert.equal(report.goals.summary.freewrite.total,4);
 assert.equal(report.goals.summary.reading.total,null);assert.equal(report.goals.summary.reading.checkOnlyDays,1);
 assert.equal(report.goals.summary.exercise.total,30);assert.equal(report.goals.daily[0].day,note.day);
 assert.ok(!JSON.stringify(report).includes('私人日记'));assert.ok(!JSON.stringify(report).includes(note.readingNote.excerpts[0].text));
 assert.throws(()=>call('shiwen_review',{period:'7',day:note.day}),/period/);
 assert.throws(()=>call('shiwen_review',{period:'1',day:'2026-02-30'}),/日期/);
 assert.equal(call('shiwen_review',{period:'month',month:'2026-11'}).goals.summary.notes.total,4);
});

test('reading metadata validates kind/book/limits and leaves unknown dates and old annotations intact',t=>{
 const {store,call}=setup(t);
 for(const extra of [{title:''},{kind:'idea'},{readingNote:{unexpected:'bad'}},{annotation:'other'}])assert.throws(()=>call('shiwen_save',{...note,...extra}));
 assert.equal(store.snapshot().records.length,0);
 const undated=call('shiwen_save',{...note,day:null});assert.equal(undated.day,null);
 const old=store.save({kind:'reading_note',title:'历史混杂',body:'旧感想',annotation:'不是结构化备注'});
 assert.equal(call('shiwen_read',{id:old.id}).readingNote,null);
 assert.throws(()=>call('shiwen_update',{requestId:'old',id:old.id,revision:old.revision,readingNote:{page:'1'}}),/核对/);
 assert.equal(store.get(old.id).annotation,'不是结构化备注');
});

test('desktop Agent saves separated reflections, returns metadata, and preserves it on updates/retries',async t=>{
 const {store}=setup(t),tools=new Map();
 const events=[{type:'user/message',data:{id:'u',source:{kind:'user'},content:[{type:'text',text:'我的感想；原文：书中摘录'}]}}];
 apply({shiwenLibrary:store,sessionQuery:{observeSession:async()=>({events,[Symbol.dispose](){}})},systemPrompt:{section:()=>()=>{}},tools:{register:tool=>{tools.set(tool.name,tool);return()=>{};}},effect:fn=>fn()});
 const exec={agent:{session:{id:'s'}},signal:new AbortController().signal,callId:'save'};
 const args={kind:'reading_note',title:'测试书',body:'我的感想',mode:'organized',origin:'personal',sourceMessageId:'u',day:note.day,readingNote:{excerpts:[{text:'书中摘录'}]}};
 const saved=await tools.get('shiwen_save').execute(args,exec);assert.equal(store.get(saved.id).body,'我的感想');assert.equal(saved.readingNote.excerpts[0].text,'书中摘录');
 assert.deepEqual(await tools.get('shiwen_save').execute(args,exec),saved);
 const update={id:saved.id,revision:saved.revision,readingNote:{chapter:'第二章'}};
 const changed=await tools.get('shiwen_update').execute(update,{...exec,callId:'update'});
 assert.deepEqual(await tools.get('shiwen_update').execute(update,{...exec,callId:'update'}),changed);
 const read=await tools.get('shiwen_read').execute({id:saved.id},exec);assert.equal(read.readingNote.chapter,'第二章');assert.equal(read.body,'我的感想');
 const report=await tools.get('shiwen_review').execute({period:'1',day:note.day},exec);assert.equal(report.goals.summary.notes.total,4);
});

test('pre-upgrade update receipts remain replayable without the new optional metadata field',t=>{
 const {store,dir}=setup(t),record=store.save({kind:'idea',title:'旧标题',body:'原文'});
 const args={id:record.id,revision:record.revision,title:'新标题'},operationId='pre-upgrade';
 const updated=store.updateRecord(args,{operationId});
 const oldFields=['id','revision','kind','title','body','day','url','annotation','stage','sourceIds'];
 const fingerprint=createHash('sha256').update(JSON.stringify(['personal',...oldFields.map(key=>[key,args[key]])])).digest('hex');
 const db=new Database(join(dir,'library.sqlite'));
 try{db.prepare('UPDATE operations SET result=? WHERE id=?').run(JSON.stringify({fingerprint,record:updated}),operationId);}finally{db.close();}
 assert.deepEqual(store.updateRecord(args,{operationId}),updated);
 assert.equal(store.get(record.id).revision,updated.revision);
});
