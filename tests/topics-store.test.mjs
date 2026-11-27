import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createStore} from '../plugins/library/legacy/store.mjs';
import Database from '../plugins/library/legacy/sqlite.mjs';
import {apply as workbench} from '../plugins/workbench/src/index.mjs';
function isolated(t){const dir=mkdtempSync(join(tmpdir(),'shiwen-topics-')),path=join(dir,'library.sqlite'),store=createStore(path);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});return {store,path};}
function sign(backup){backup.sha256=createHash('sha256').update(JSON.stringify(backup.payload)).digest('hex');return JSON.stringify(backup);}
test('主题片段校验、定位、并发与删除恢复',t=>{
 const {store:s}=isolated(t),r=s.save({kind:'freewrite',body:'甲😀选段乙'}),topic=s.themeSave({title:'主题',summary:'说明'});
 assert.throws(()=>s.themeMemberAdd({themeId:topic.id,revision:1,sourceRecordId:r.id,sourceRevision:r.revision+1,field:'body'}),/来源已更新/);
 assert.throws(()=>s.themeMemberAdd({themeId:topic.id,revision:1,sourceRecordId:r.id,sourceRevision:r.revision,field:'body',start:1,end:3,quote:'选段'}),/不一致/);
 let result=s.themeMemberAdd({themeId:topic.id,revision:1,sourceRecordId:r.id,sourceRevision:r.revision,field:'body',start:3,end:5,quote:'选段'});let m=result.members[0];assert.equal(result.revision,2);assert.equal(m.location.status,'current');assert.deepEqual(s.recordThemes({id:r.id}).map(x=>x.id),[topic.id]);
 assert.throws(()=>s.themeSave({id:topic.id,revision:1,title:'覆盖',summary:''}),/更新/);assert.throws(()=>s.themeMemberRemove({themeId:topic.id,revision:1,memberId:m.id}),/更新/);
 let newer=s.updateRecord({id:r.id,revision:r.revision,body:'新增甲😀选段乙'});m=s.themeRead({id:topic.id}).members[0];assert.equal(m.location.status,'moved');assert.equal(m.location.start,5);
 newer=s.updateRecord({id:r.id,revision:newer.revision,body:'内容变化'});assert.equal(s.themeRead({id:topic.id}).members[0].location.status,'changed');
 const removed=s.remove({id:r.id,revision:newer.revision});assert.equal(s.themeRead({id:topic.id}).members[0].location.status,'deleted');s.restoreRemoved(removed);assert.equal(s.themeRead({id:topic.id}).members[0].quote,'选段');
 result=s.themeMemberRemove({themeId:topic.id,revision:2,memberId:m.id});assert.equal(result.revision,3);assert.deepEqual(result.members,[]);assert.deepEqual(s.recordThemes({id:r.id}),[]);s.themeDelete({id:topic.id,revision:3});assert.deepEqual(s.themeList(),[]);
});
test('完整备份主题校验、原库重映射和旧备份兼容',t=>{
 const {store:s}=isolated(t),{store:dest,path}=isolated(t),r=s.save({kind:'idea',body:'备份原文'}),topic=s.themeSave({title:'备份主题',summary:''});s.themeMemberAdd({themeId:topic.id,revision:1,sourceRecordId:r.id,sourceRevision:r.revision,field:'body'});
 const raw=s.exportBackup(),backup=JSON.parse(raw),targetId=JSON.parse(dest.exportBackup()).payload.libraryId;assert.equal(backup.payload.schema,21);assert.throws(()=>s.restoreBackup(raw,{requireEmpty:true}),/已有内容/);
 dest.restoreBackup(raw);assert.equal(dest.themeRead({id:topic.id}).members[0].location.status,'current');assert.notEqual(dest.themeRead({id:topic.id}).members[0].sourceLibraryId,backup.payload.libraryId);
 const invalid=JSON.parse(raw);invalid.payload.tables.theme_members[0].theme_id='missing';assert.throws(()=>dest.restoreBackup(sign(invalid)),/主题成员/);assert.equal(dest.themeRead({id:topic.id}).members.length,1);
 const other=JSON.parse(raw);other.payload.tables.theme_members[0].source_library_id='another-library';dest.restoreBackup(sign(other));assert.equal(dest.themeRead({id:topic.id}).members[0].location.status,'library_mismatch');
 const collision=JSON.parse(raw);collision.payload.tables.theme_members[0].source_library_id=targetId;dest.restoreBackup(sign(collision));assert.equal(dest.themeRead({id:topic.id}).members[0].sourceLibraryId,targetId);assert.equal(dest.themeRead({id:topic.id}).members[0].location.status,'library_mismatch');assert.deepEqual(dest.recordThemes({id:r.id}),[]);const again=dest.exportBackup();dest.restoreBackup(again);assert.equal(dest.themeRead({id:topic.id}).members[0].location.status,'library_mismatch');
 const old=JSON.parse(raw);old.payload.schema=15;delete old.payload.libraryId;delete old.payload.tables.themes;delete old.payload.tables.theme_members;dest.restoreBackup(sign(old));assert.deepEqual(dest.themeList(),[]);
 const future=JSON.parse(raw);future.payload.schema=22;assert.throws(()=>dest.restoreBackup(sign(future)),/备份格式/);
 const db=new Database(path);assert.equal(db.prepare("PRAGMA foreign_key_list(theme_members)").all().some(x=>x.table==='records'),false);db.close();
});
test('主题 RPC 限制 owner 并可读写',async t=>{
 const {store:s}=isolated(t);let route,peer={};const owner={};workbench({shiwenLibrary:s,effect:fn=>fn(),connection:{browserPeer:owner,admit:()=>({peer}),fetch:{register:value=>{route=value;return()=>{};}}}});
 const rpc=async(method,args)=>{const response=await route.fetch(new Request('http://localhost/api/shiwen',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({method,args})}));return {status:response.status,...await response.json()};};
 assert.equal((await rpc('themeList',{})).status,403);assert.equal((await rpc('themeContext',{})).status,403);peer=owner;const libraryId=(await rpc('themeContext',{})).result.libraryId;assert.equal(libraryId,JSON.parse(s.exportBackup()).payload.libraryId);assert.equal((await rpc('themeSave',{title:'主题',summary:''})).status,400);assert.equal((await rpc('themeSave',{title:'主题',summary:'',expectedLibraryId:'other'})).status,400);const made=await rpc('themeSave',{title:'主题',summary:'',expectedLibraryId:libraryId});assert.equal(made.status,200);assert.equal((await rpc('themeRead',{id:made.result.id})).result.title,'主题');assert.equal((await rpc('themeDelete',{id:made.result.id,revision:99,expectedLibraryId:libraryId})).status,400);
});
test('旧版多摘录按内容定位，重复片段保守标记歧义',t=>{
 const {store:s,path}=isolated(t),r=s.save({kind:'reading_note',title:'书',body:'感想',readingNote:{excerpts:[{text:'第一段',page:''}]} }),topic=s.themeSave({title:'摘录',summary:''});
 // Construct an old multi-excerpt record without going through the current single-excerpt editor.
 const db=new Database(path);db.prepare('UPDATE records SET annotation=? WHERE id=?').run(JSON.stringify({schema:'shiwen.reading-note.v1',chapter:'',page:'',excerpts:[{text:'第一段',page:''},{text:'甲选段乙',page:''}]}),r.id);db.close();
 let theme=s.themeMemberAdd({themeId:topic.id,revision:1,sourceRecordId:r.id,sourceRevision:r.revision,field:'excerpt',excerptIndex:1,quote:'选段',start:1,end:3});assert.equal(theme.members[0].location.excerptIndex,1);
 const editDb=new Database(path);editDb.prepare('UPDATE records SET annotation=? WHERE id=?').run(JSON.stringify({schema:'shiwen.reading-note.v1',chapter:'',page:'',excerpts:[{text:'甲选段乙',page:''},{text:'第一段',page:''}]}),r.id);editDb.close();
 let location=s.themeRead({id:topic.id}).members[0].location;assert.equal(location.status,'moved');assert.equal(location.excerptIndex,0);
 const ambiguousDb=new Database(path);ambiguousDb.prepare('UPDATE records SET annotation=? WHERE id=?').run(JSON.stringify({schema:'shiwen.reading-note.v1',chapter:'',page:'',excerpts:[{text:'甲选段乙',page:''},{text:'甲选段乙',page:''}]}),r.id);ambiguousDb.close();
 location=s.themeRead({id:topic.id}).members[0].location;assert.equal(location.status,'ambiguous');assert.equal(location.start,null);
});
test('原文和读书笔记响应携带读取时的资料库身份，切库后拒绝旧身份写入',async t=>{
 const {store:s,path}=isolated(t),record=s.save({kind:'freewrite',body:'旧原文'}),note=s.readingNoteSave({book:'书',reflection:'感想',day:'2026-11-01',excerpts:[],requestId:'note'});
 const owner={},foreign={};let peer=owner,route;workbench({shiwenLibrary:s,effect:fn=>fn(),connection:{browserPeer:owner,admit:()=>({peer}),fetch:{register:value=>{route=value;return()=>{};}}}});
 const rpc=async(method,args={})=>{const response=await route.fetch(new Request('http://localhost/api/shiwen',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({method,args})}));return {status:response.status,...await response.json()};};
 const original=(await rpc('readMarkdown',{id:record.id})).result,notes=(await rpc('readingNoteList')).result,libraryId=(await rpc('themeContext')).result.libraryId;
 assert.equal(original.sourceLibraryId,libraryId);assert.equal(notes.records.find(row=>row.id===note.id).sourceLibraryId,libraryId);assert.equal(s.get(record.id).sourceLibraryId,undefined);assert.equal(s.readingNoteList().records[0].sourceLibraryId,undefined);
 peer=foreign;assert.equal((await rpc('readMarkdown',{id:record.id})).result.sourceLibraryId,undefined);assert.equal((await rpc('readingNoteList')).status,403);peer=owner;
 const db=new Database(path);db.prepare("UPDATE meta SET value=? WHERE key='sync_library_id'").run('new-library');db.close();
 assert.equal((await rpc('readMarkdown',{id:record.id})).result.sourceLibraryId,'new-library');assert.equal((await rpc('themeSave',{title:'旧页面',summary:'',expectedLibraryId:original.sourceLibraryId})).status,400);assert.deepEqual(s.themeList(),[]);
});
