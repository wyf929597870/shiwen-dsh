import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createStore} from '../plugins/library/legacy/store.mjs';
import Database from '../plugins/library/legacy/sqlite.mjs';
import {dateKey} from '../plugins/library/legacy/content.mjs';

test('列表与查询按内容日期、创建时间倒序，未知日期置底，筛选分页不改变顺序',t=>{
 const dir=mkdtempSync(join(tmpdir(),'shiwen-order-')),path=join(dir,'library.sqlite');
 const store=createStore(path),db=new Database(path);
 t.after(()=>{db.close();store.close();rmSync(dir,{recursive:true,force:true});});
 function add(title,created,{day,imported=false,kind='journal'}={}){
  const row=store.save({kind,title,body:'排序验证'});
  db.prepare('UPDATE records SET created=?,updated=? WHERE id=?').run(created,created,row.id);
  if(imported)db.prepare('INSERT INTO imports VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(row.id,'fixture',title,'hash',day,'test',4,null,'{}','[]','2026-12-01T00:00:00Z');
  else if(day!==undefined)store.updateRecord({id:row.id,revision:row.revision,day:day??''});
  return row.id;
 }
 const old=add('旧日记刚修改','2026-11-10T00:00:00Z',{day:'2026-09-01'});
 const sameEarly=add('同日先创建','2026-11-01T01:00:00Z',{day:'2026-10-10'});
 const sameLate=add('同日后创建','2026-11-02T01:00:00Z',{day:'2026-10-10',imported:true});
 const newest=add('最新内容','2026-09-01T00:00:00Z',{day:'2026-11-05'});
 const natural=add('无单独日期的新记录','2026-10-20T12:00:00Z');
 const unknownImported=add('导入日期未知','2026-11-20T00:00:00Z',{day:null,imported:true});
 const unknownDated=add('手动清空日期','2026-11-21T00:00:00Z',{day:null});
 const article=add('文章','2026-11-22T00:00:00Z',{day:'2026-10-15',kind:'article'});
 const removed=add('已删除','2026-12-01T00:00:00Z');
 store.remove({id:removed,revision:store.get(removed).revision});
 for(const id of [old,unknownImported])store.updateRecord({id,revision:store.get(id).revision,annotation:'最近修改'});
 const expected=[newest,natural,article,sameLate,sameEarly,old,unknownDated,unknownImported];
 assert.deepEqual(store.snapshot().records.map(r=>r.id),expected);
 assert.deepEqual(store.searchRecords({query:'排序验证'}).items.map(r=>r.id),expected);
 assert.equal(store.get(natural).contentDay,dateKey('2026-10-20T12:00:00Z'));
 assert.equal(store.snapshot().records.find(r=>r.id===unknownImported).contentDay,null);
 assert.equal(store.get(unknownDated).contentDay,null);
 const filtered=expected.filter(id=>id!==article);
 assert.deepEqual(store.snapshot().records.filter(r=>r.kind==='journal').map(r=>r.id),filtered);
 const pages=[];let offset=0;
 do{const page=store.searchRecords({query:'排序验证',kind:'journal',offset,limit:2});pages.push(...page.items.map(r=>r.id));offset=page.nextOffset;}while(offset!==null);
 assert.deepEqual(pages,filtered);
 assert.deepEqual(store.searchRecords({start:'2026-10-01',end:'2026-10-31'}).items.map(r=>r.id),[natural,article,sameLate,sameEarly]);
 // Changing the content date, unlike editing text, must change the position.
 store.updateRecord({id:old,revision:store.get(old).revision,day:'2026-12-01'});
 assert.equal(store.snapshot().records[0].id,old);
 assert.equal(store.searchRecords().items[0].id,old);
});
