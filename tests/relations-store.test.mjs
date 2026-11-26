import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createStore} from '../plugins/library/legacy/store.mjs';
import Database from '../plugins/library/legacy/sqlite.mjs';
function make(t){const dir=mkdtempSync(join(tmpdir(),'shiwen-relations-')),path=join(dir,'library.sqlite'),s=createStore(path);t.after(()=>{s.close();rmSync(dir,{recursive:true,force:true});});return {s,path};}
const sign=b=>{b.sha256=createHash('sha256').update(JSON.stringify(b.payload)).digest('hex');return JSON.stringify(b);};
test('分组关系、双向去重及删除恢复',t=>{
 const {s}=make(t),lib=s.themeContext().libraryId,a=s.save({kind:'idea',body:'素材'}),b=s.save({kind:'article',body:'文章',sourceIds:[a.id]}),c=s.save({kind:'freewrite',body:'手动关系'}),theme=s.themeSave({title:'主题'});
 s.themeMemberAdd({themeId:theme.id,revision:1,sourceRecordId:a.id,sourceRevision:a.revision,field:'body'});
 let view=s.recordRelationAdd({id:a.id,relatedId:b.id,expectedLibraryId:lib});assert.deepEqual(view.articles.map(r=>r.id),[b.id]);assert.deepEqual(view.related.map(r=>r.id),[b.id]);assert.equal(view.themes[0].id,theme.id);
 view=s.recordRelationAdd({id:b.id,relatedId:a.id,expectedLibraryId:lib});assert.deepEqual(view.sources.map(r=>r.id),[a.id]);assert.deepEqual(view.related.map(r=>r.id),[a.id]);
 s.recordRelationAdd({id:a.id,relatedId:c.id,expectedLibraryId:lib});assert.equal(s.recordNeighborhood({id:a.id}).related.length,2);assert.throws(()=>s.recordRelationAdd({id:a.id,relatedId:a.id,expectedLibraryId:lib}),/同一条/);assert.throws(()=>s.recordRelationAdd({id:a.id,relatedId:c.id,expectedLibraryId:'wrong'}),/切换/);
 const deleted=s.remove({id:b.id,revision:b.revision});view=s.recordNeighborhood({id:a.id});assert.deepEqual(view.articles,[]);assert.deepEqual(view.related.map(r=>r.id),[c.id]);s.restoreRemoved(deleted);assert.equal(s.recordNeighborhood({id:a.id}).related.length,2);
 s.recordRelationRemove({id:b.id,relatedId:a.id,expectedLibraryId:lib});assert.deepEqual(s.recordNeighborhood({id:b.id}).related,[]);assert.deepEqual(s.recordNeighborhood({id:b.id}).sources.map(r=>r.id),[a.id]);
});
test('备份迁移与目标库身份碰撞保护',t=>{
 const {s}=make(t),{s:target,path}=make(t),a=s.save({kind:'idea',body:'甲'}),b=s.save({kind:'idea',body:'乙'}),lib=s.themeContext().libraryId,targetId=target.themeContext().libraryId;s.recordRelationAdd({id:a.id,relatedId:b.id,expectedLibraryId:lib});
 const raw=s.exportBackup(),backup=JSON.parse(raw);assert.equal(backup.payload.schema,19);target.restoreBackup(raw);assert.deepEqual(target.recordNeighborhood({id:a.id}).related.map(x=>x.id),[b.id]);
 const collision=JSON.parse(raw);collision.payload.tables.record_relations[0].library_id=targetId;collision.payload.tables.record_relations.push({...collision.payload.tables.record_relations[0],blocked:1});target.restoreBackup(sign(collision));assert.deepEqual(target.recordNeighborhood({id:a.id}).related,[]);let stored=JSON.parse(target.exportBackup()).payload.tables.record_relations;assert.equal(stored.length,1);assert.equal(stored[0].library_id,targetId);assert.equal(stored[0].blocked,1);target.restoreBackup(target.exportBackup());assert.deepEqual(target.recordNeighborhood({id:a.id}).related,[]);
 const old=JSON.parse(raw);old.payload.schema=16;delete old.payload.tables.record_relations;target.restoreBackup(sign(old));assert.deepEqual(target.recordNeighborhood({id:a.id}).related,[]);
 const invalid=JSON.parse(raw);invalid.payload.tables.record_relations[0].right_id=invalid.payload.tables.record_relations[0].left_id;assert.throws(()=>target.restoreBackup(sign(invalid)),/关系无效/);assert.deepEqual(target.recordNeighborhood({id:a.id}).related,[]);
 const db=new Database(path);assert.equal(db.prepare('PRAGMA foreign_key_list(record_relations)').all().length,0);db.close();
});
