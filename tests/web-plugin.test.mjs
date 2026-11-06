import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {libraryPaths,apply} from '../plugins/library/src/index.mjs';
import {setupWebProfile} from '../scripts/web-profile.mjs';
test('Web 插件按 profile 隔离资料，显式配置优先，兼容桌面资料目录',()=>{
 const ctx={get:()=>({home:'/synthetic/dsh',name:'web'})};
 assert.equal(libraryPaths(ctx,{},{}).library,'/synthetic/dsh/shiwen/web/library');
 assert.equal(libraryPaths(ctx,{}, {SHIWEN_DATA_DIR:'/synthetic/desktop/library'}).library,'/synthetic/desktop/library');
 assert.equal(libraryPaths(ctx,{dataDir:'/synthetic/custom/library'},{SHIWEN_DATA_DIR:'/synthetic/desktop/library'}).root,'/synthetic/custom');
 assert.notEqual(libraryPaths(ctx,{},{}).library,libraryPaths({get:()=>({home:'/synthetic/dsh',name:'desktop'})},{},{}).library);
});
test('插件关闭及重载保留资料，不依赖桌面环境变量',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'shiwen-plugin-reload-'));let store,dispose;
 const ctx={get:()=>({home:dir,name:'web'}),provide:(_name,value)=>store=value,effect:fn=>dispose=fn()};
 try{
  apply(ctx,{dataDir:join(dir,'library')});
  const row=store.saveDsh({kind:'journal',body:'插件重载保留原文',origin:'personal',sourceExcerpt:'插件重载保留原文',sessionId:'test',messageId:'m1',role:'user',operationId:'op1'});
  dispose();apply(ctx,{dataDir:join(dir,'library')});assert.equal(store.get(row.id).body,'插件重载保留原文');
 }finally{dispose?.();await rm(dir,{recursive:true,force:true});}
});
test('Web profile 重复启动保留自定义配置且不接管已有非拾文 profile',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'shiwen-web-profile-'));
 try{
  const bundle=join(dir,'bundle');await mkdir(bundle);
  const profile=await setupWebProfile({home:dir,bundle,theme:false,persona:false});
  const path=join(profile,'cordis.patch.yml');const custom='[{"id":"locale","config":{"preference":"en"}}]\n';
  await writeFile(path,custom);await setupWebProfile({home:dir,bundle});assert.equal(await readFile(path,'utf8'),custom);
  await writeFile(join(profile,'package.json'),JSON.stringify({name:'other',dsh:{profile:{bundles:['other']}}}));
  await assert.rejects(()=>setupWebProfile({home:dir,bundle}),/不属于拾文/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
