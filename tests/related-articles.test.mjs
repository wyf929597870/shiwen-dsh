import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createStore} from '../plugins/library/legacy/store.mjs';
import Database from '../plugins/library/legacy/sqlite.mjs';
import {apply as workbench} from '../plugins/workbench/src/index.mjs';

test('素材反向关联只显示当前关联的有效文章，删除和恢复即时生效',t=>{
  const dir=mkdtempSync(join(tmpdir(),'shiwen-related-')),path=join(dir,'library.sqlite'),s=createStore(path);
  t.after(()=>{s.close();rmSync(dir,{recursive:true,force:true});});
  const material=s.save({kind:'freewrite',body:'素材'}),other=s.save({kind:'idea',body:'另一素材'});
  const a=s.save({kind:'article',title:'甲',body:'正文',sourceIds:[material.id]}),b=s.save({kind:'article',title:'乙',body:'正文',sourceIds:[material.id,other.id]}),unrelated=s.save({kind:'article',body:'无关'});
  const db=new Database(path);db.prepare('UPDATE records SET updated=? WHERE id=?').run('2020-01-01T00:00:00.000Z',a.id);db.prepare('UPDATE records SET updated=? WHERE id=?').run('2021-01-01T00:00:00.000Z',b.id);db.close();
  assert.deepEqual(s.relatedArticles({id:material.id}).map(x=>x.id),[b.id,a.id]);
  assert.deepEqual(Object.keys(s.relatedArticles({id:material.id})[0]).sort(),['created','id','stage','title','updated']);
  assert.deepEqual(s.get(b.id).sourceIds.sort(),[material.id,other.id].sort());
  assert.deepEqual(s.relatedArticles({id:unrelated.id}),[]);assert.deepEqual(s.relatedArticles({id:'missing'}),[]);
  const removed=s.remove({id:b.id,revision:b.revision});assert.deepEqual(s.relatedArticles({id:material.id}).map(x=>x.id),[a.id]);
  s.restoreRemoved(removed);assert.deepEqual(s.relatedArticles({id:material.id}).map(x=>x.id),[b.id,a.id]);
  const updated=s.save({id:a.id,revision:a.revision,sourceIds:[]});assert.deepEqual(updated.sourceIds,[]);assert.deepEqual(s.relatedArticles({id:material.id}).map(x=>x.id),[b.id]);
  const deletedMaterial=s.remove({id:material.id,revision:material.revision});assert.deepEqual(s.relatedArticles({id:material.id}),[]);s.restoreRemoved(deletedMaterial);assert.deepEqual(s.relatedArticles({id:material.id}).map(x=>x.id),[b.id]);
  for(const id of [undefined,null,42,'','  ','x'.repeat(101)])assert.throws(()=>s.relatedArticles({id}));
});

test('工作台关联文章 RPC 要求所有者并校验参数',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'shiwen-related-rpc-')),s=createStore(join(dir,'library.sqlite'));t.after(()=>{s.close();rmSync(dir,{recursive:true,force:true});});
  const material=s.save({kind:'idea',body:'素材'}),article=s.save({kind:'article',body:'文章',sourceIds:[material.id]});
  const browserPeer={id:'owner'};let route,peer=browserPeer;
  workbench({shiwenLibrary:s,effect:fn=>fn(),connection:{browserPeer,admit:()=>({peer}),fetch:{register:value=>{route=value;return()=>{};}}}});
  const rpc=async args=>{const response=await route.fetch(new Request('http://localhost/api/shiwen',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({method:'relatedArticles',args})}));return {status:response.status,...await response.json()};};
  assert.equal((await rpc({id:material.id})).result[0].id,article.id);assert.equal((await rpc({id:''})).status,400);
  peer={id:'other'};assert.equal((await rpc({id:material.id})).status,403);
});
