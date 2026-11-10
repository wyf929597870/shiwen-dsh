import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createStore} from '../plugins/library/legacy/store.mjs';
import {decodeReadingNote,encodeReadingNote,validateReadingNote} from '../plugins/library/legacy/reading-note.mjs';
import {reviewGoalDays} from '../plugins/workbench/src/review-goals.mjs';
import {mobileReadingNotes,readingSources} from '../plugins/workbench/src/reading/adapters.mjs';
import {record as recordSchema,protocolVersion} from '../contracts/mobile/v1/schema.mjs';
const input=(patch={})=>({requestId:randomUUID(),book:'测试书目',day:'2026-11-10',reflection:'我的感想',chapter:'第三章',page:'20',excerpts:[{text:'书中的摘录不算我的原创',page:'21'},{text:'另一段原文',page:'22'}],...patch});
function store(t){const dir=mkdtempSync(join(tmpdir(),'shiwen-reading-test-')),s=createStore(join(dir,'library.sqlite'));t.after(()=>{s.close();rmSync(dir,{recursive:true,force:true});});return s;}
test('separate dated notes preserve excerpts, personal counts, retry identity and edit CAS',t=>{
 const s=store(t),first=input(),a=s.readingNoteSave(first),b=s.readingNoteSave(input());
 assert.notEqual(a.id,b.id);assert.equal(s.readingNoteList().records.length,2);assert.equal(s.readingNoteSave(first).id,a.id);
 assert.throws(()=>s.readingNoteSave({...first,reflection:'不同内容'}),/请求编号/);
 assert.equal(a.contentDay,'2026-11-10');assert.equal(a.markdown,'我的感想');assert.equal(decodeReadingNote(a.annotation).excerpts.length,2);
 let report=s.reviewPreview({period:'month',month:'2026-11',now:'2026-11-10T12:00:00Z'});
 assert.equal(report.personalOriginalCharacters,8);assert.equal(reviewGoalDays(report).find(x=>x.day==='2026-11-10').goals.notes.value,8);
 const edit=input({id:a.id,revision:a.revision,day:'2026-11-09',reflection:'新感想'}),updated=s.readingNoteSave(edit);
 assert.equal(updated.contentDay,'2026-11-09');assert.equal(s.readingNoteSave(edit).revision,updated.revision);
 assert.throws(()=>s.readingNoteSave(input({id:a.id,revision:a.revision})),/已被更新/);
 const before=s.reviewPreview({period:'1',now:new Date().toISOString()}).observedEdits;
 s.readingNoteSave(input({id:a.id,revision:updated.revision,day:'2026-11-09',reflection:'新感想',excerpts:[{text:'仅修改摘录，不产生个人写作增量'}]}));
 assert.deepEqual(s.reviewPreview({period:'1',now:new Date().toISOString()}).observedEdits,before);
 const old=s.save({kind:'reference',title:'读书笔记',body:'历史混合内容'});assert.equal(s.readingNoteList().records.length,2);assert.equal(s.get(old.id).kind,'reference');
});
test('note dates and metadata survive portable bootstrap; only personal notes are listed',t=>{
 const s=store(t),note=s.readingNoteSave(input());s.saveDsh({kind:'reading_note',body:'AI整理',origin:'ai',title:'测试书目',day:'2026-11-10',sessionId:'test',messageId:'ai',role:'assistant',operationId:'ai'});
 assert.equal(s.readingNoteList().records.length,1);
 const sync=s.mobileSync(),deviceId=randomUUID(),identity=sync.identity({protocolVersion,deviceId}),snapshot=sync.bootstrapBegin({libraryId:identity.libraryId,epoch:identity.epoch,deviceId});
 const records=sync.bootstrapPage({snapshotId:snapshot.snapshotId,entityType:'records'}).items;
 const portable=records.find(r=>r.id===note.id);recordSchema.parse(portable);
 assert.equal(portable.contentDay,'2026-11-10');assert.equal(portable.markdown,'我的感想');assert.equal(portable.annotation,note.annotation);
 const restored=store(t);restored.restoreBackup(s.exportBackup());
 const copy=restored.readingNoteList().records.find(r=>r.id===note.id);
 assert.equal(copy.contentDay,note.contentDay);assert.equal(copy.markdown,note.markdown);assert.equal(copy.annotation,note.annotation);
});
test('metadata rejects invalid dates and excessive excerpts without inventing authorship',()=>{
 assert.throws(()=>validateReadingNote(input({day:'2026-02-30'})),/日期/);
 assert.throws(()=>validateReadingNote(input({book:'  '})),/书名/);
 assert.throws(()=>validateReadingNote(input({reflection:' '})),/感想/);
 assert.throws(()=>encodeReadingNote({excerpts:[{text:'甲'.repeat(9000)},{text:'乙'.repeat(2000)}]}),/过长/);
 assert.equal(decodeReadingNote('普通备注'),null);
 assert.equal(decodeReadingNote(encodeReadingNote({excerpts:[{text:''},{text:'引用',page:'3'}]})).excerpts.length,1);
});
test('mobile pagination and retry payload retain stable note identity and separated excerpts',async()=>{
 const calls=[],pending={input:input(),requestId:randomUUID(),recordId:randomUUID(),generation:1};
 const request=async(method,args)=>{calls.push({method,args});if(method==='recordRead')return {id:args.id,kind:'reading_note',origin:'personal',markdown:'完整感想',annotation:encodeReadingNote({excerpts:[{text:'原文'}]}),sources:[{text:'完整感想',origin:'personal'}]};if(method==='recordList')return args.cursor?{items:[{id:'2',origin:'personal'}]}:{items:[{id:'1',origin:'personal'},{id:'ai',origin:'ai'}],nextCursor:'2'};return {record:{id:args.record?.id??args.id,...args.record}};};
 const api=mobileReadingNotes(request,'library');const listed=(await api.list()).records;assert.equal(listed.length,2);assert.equal(listed[0].markdown,'完整感想');assert.equal(decodeReadingNote(listed[0].annotation).excerpts[0].text,'原文');
 await api.save(pending);await api.save(pending);assert.deepEqual(calls.at(-1),calls.at(-2));
 assert.equal(calls.at(-1).args.record.markdown,'我的感想');assert.equal(decodeReadingNote(calls.at(-1).args.record.annotation).excerpts.length,2);
 const baseline={markdown:'甲乙',sources:[{text:'甲',origin:'personal'},{text:'乙',origin:'ai'}]};
 assert.deepEqual(readingSources(baseline,'甲乙丙'),[...baseline.sources,{text:'丙',origin:'personal'}]);
});
