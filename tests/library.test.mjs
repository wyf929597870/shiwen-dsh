import test from 'node:test';
import {count,changes} from '../plugins/library/legacy/content.mjs';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {createStore} from '../plugins/library/legacy/store.mjs';
import {plainDoc} from '../plugins/library/legacy/content.mjs';

test('library image references do not inflate writing counts',()=>{
 const image='![说明](attachment:01234567-89ab-cdef-0123-456789abcdef)';
 assert.equal(count(image),0);
 assert.deepEqual(changes('原文','原文'+image),{added:0,removed:0});
 assert.deepEqual(changes('原文'+image,'原文补'+image),{added:1,removed:0});
 assert.ok(count('```\n'+image+'\n```')>0);
 assert.ok(count('`'+image+'`')>0);
});

test('workbench image staging commits atomically and retries safely',t=>{
 const dir=mkdtempSync(join(tmpdir(),'shiwen-workbench-image-')),store=createStore(join(dir,'library.sqlite'));
 t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
 const data=Buffer.from('89504e470d0a1a0a00010203','hex').toString('base64'),image=store.stageWorkbenchImage({name:'image.png',data});
 const input={kind:'reference',title:'image',doc:plainDoc(`![图](attachment:${image.id})`,'personal')};
 const saved=store.saveWorkbenchMarkdown(input,[image.id],'operation-1');
 assert.equal(store.attachments({record:saved.id}).length,1);
 assert.equal(store.saveWorkbenchMarkdown(input,[image.id],'operation-1').id,saved.id);
 assert.throws(()=>store.saveWorkbenchMarkdown({...input,title:'different'},[image.id],'operation-1'),/不同内容/);
 const next=store.stageWorkbenchImage({name:'pending.png',data});
 const draft={body:`![图](attachment:${next.id})`,stagedImages:[next.id]};
 store.workbenchDraft({slot:'library',value:draft,revision:1});
 assert.throws(()=>store.workbenchDraft({slot:'library',value:{body:'stale'},revision:0}),/更新/);
 const restored=createStore(join(dir,'restored.sqlite'));t.after(()=>restored.close());restored.restoreBackup(store.exportBackup());
 assert.deepEqual(restored.workbenchDraft({slot:'library'}).value,draft);
 const pending={kind:'reference',title:'pending',doc:plainDoc(`![图](attachment:${next.id})`,'personal')};
 assert.equal(restored.attachments({record:restored.saveWorkbenchMarkdown(pending,[next.id],'operation-2').id}).length,1);
 const broken=JSON.parse(store.exportBackup());broken.payload.tables.workbench_image_stages=[];
 broken.sha256=createHash('sha256').update(JSON.stringify(broken.payload)).digest('hex');
 assert.throws(()=>restored.restoreBackup(JSON.stringify(broken)),/草稿图片缺失/);
});

test('DSH 原消息归档保留日期、来源和幂等操作，不计入编辑增量',t=>{
  const dir=mkdtempSync(join(tmpdir(),'shiwen-dsh-test-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const store=createStore(join(dir,'a.sqlite'));t.after(()=>store.close());
  const args={kind:'journal',title:'那一天',body:'这是我的原话',origin:'personal',day:'2026-11-01',sessionId:'session-1',messageId:'message-1',role:'user',operationId:'dsh:one'};
  const saved=store.saveDsh(args),again=store.saveDsh(args);
  assert.equal(saved.id,again.id);assert.equal(again.dateInfo.day,args.day);assert.equal(store.snapshot().records.length,1);
  assert.deepEqual(store.dshSources({id:saved.id}).map(row=>({...row})),[{session_id:args.sessionId,message_id:args.messageId,role:'user',excerpt:args.body}]);
  const review=store.review({period:'month',month:'2026-11',now:'2026-11-05T03:00:00Z',timeZone:'Asia/Shanghai'});
  assert.equal(review.totals.added,0);assert.equal(review.totals.personalRecords,1);
  assert.throws(()=>store.saveDsh({...args,operationId:'dsh:bad',day:'2026-02-30'}),/日期/);
  assert.equal(store.snapshot().records.length,1);
});

test('备份恢复保留 DSH 来源；旧版备份仍可导入',t=>{
  const dir=mkdtempSync(join(tmpdir(),'shiwen-dsh-backup-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const source=createStore(join(dir,'source.sqlite')),target=createStore(join(dir,'target.sqlite'));t.after(()=>{source.close();target.close();});
  const saved=source.saveDsh({kind:'idea',body:'历史消息',origin:'personal',day:null,sessionId:'s',messageId:'m',role:'user',operationId:'dsh:a'});
  const backup=source.exportBackup();assert.equal(JSON.parse(backup).payload.schema,15);
  target.restoreBackup(backup);assert.equal(target.get(saved.id).body,'历史消息');assert.equal(target.dshSources({id:saved.id})[0].message_id,'m');
});

test('schema 7 backup migrates records with the new sync defaults',t=>{
  const dir=mkdtempSync(join(tmpdir(),'shiwen-dsh-backup-v7-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const source=createStore(join(dir,'source.sqlite')),target=createStore(join(dir,'target.sqlite'));t.after(()=>{source.close();target.close();});
  const saved=source.save({kind:'idea',body:'旧备份正文'}),wrapped=JSON.parse(source.exportBackup());
  wrapped.payload.schema=7;for(const row of wrapped.payload.tables.records){delete row.processing;delete row.created_by_device;}
  for(const table of ['sync_changes','sync_activities','sync_receipts'])delete wrapped.payload.tables[table];
  wrapped.sha256=createHash('sha256').update(JSON.stringify(wrapped.payload)).digest('hex');
  target.restoreBackup(JSON.stringify(wrapped));assert.equal(target.get(saved.id).body,'旧备份正文');
  assert.equal(target.get(saved.id).processing,'unknown');assert.equal(target.get(saved.id).created_by_device,null);
});

test('迁移保持源库并拒绝覆盖目标，原有记录与历史会话可追溯',async t=>{
 const {inspectLegacy,migrateLegacy}=await import('../plugins/library/src/migrate.mjs');
 const dir=mkdtempSync(join(tmpdir(),'shiwen-dsh-migration-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const from=join(dir,'old.sqlite'),to=join(dir,'new.sqlite');const old=createStore(from);const record=old.save({kind:'journal',title:'旧日记',body:'旧正文'});old.addMessage({thread:'global',role:'user',body:'历史对话'});old.close();
 const before=inspectLegacy(from);assert.equal(before.records[0].count,1);assert.equal(before.messages,1);
 const result=await migrateLegacy({source:from,target:to});assert.equal(result.messages,1);assert.deepEqual(inspectLegacy(from),before);
 const migrated=createStore(to);assert.equal(migrated.get(record.id).body,'旧正文');assert.equal(migrated.messages({thread:'global'})[0].body,'历史对话');migrated.close();
 await assert.rejects(()=>migrateLegacy({source:from,target:to}),/目标资料库已存在/);assert.deepEqual(inspectLegacy(from),before);
});

test('应用内导入仅写入空资料库，失败时不覆盖已存在内容',async t=>{
 const {importLegacyToStore}=await import('../plugins/library/src/migrate.mjs');
 const dir=mkdtempSync(join(tmpdir(),'shiwen-dsh-import-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const old=createStore(join(dir,'old.sqlite')),target=createStore(join(dir,'target.sqlite')),blocked=createStore(join(dir,'blocked.sqlite'));t.after(()=>{old.close();target.close();blocked.close();});
 const original=old.save({kind:'idea',body:'保留来源'}),existing=blocked.save({kind:'journal',body:'目标中的文字'});
 await importLegacyToStore({source:join(dir,'old.sqlite'),store:target,scratch:dir});assert.equal(target.get(original.id).body,'保留来源');
 await assert.rejects(()=>importLegacyToStore({source:join(dir,'old.sqlite'),store:blocked,scratch:dir}),/已有内容/);assert.equal(blocked.get(existing.id).body,'目标中的文字');assert.equal(old.get(original.id).body,'保留来源');
});
