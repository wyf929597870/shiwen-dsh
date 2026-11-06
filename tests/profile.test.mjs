import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,realpath,rm,unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setupProfile} from '../scripts/profile.mjs';
const names=['library','agent-tools','theme','workbench','personal-context','external'];
test('安装位置改变后重定位已登记的拾文插件，保留用户插件和偏好',async()=>{
 const base=await mkdtemp(join(tmpdir(),'shiwen-profile-'));
 try{
  const root=join(base,'dev'),home=join(base,'data/dsh'),pluginRoot=join(base,'installed/plugins');
  for(const name of names){await mkdir(join(root,'plugins',name),{recursive:true});await mkdir(join(pluginRoot,name),{recursive:true});}
  const {profile}=await setupProfile({root,home});
  const file=join(profile,'package.json'),original=JSON.parse(await readFile(file,'utf8'));
  original.dependencies['custom-plugin']='1.2.3';await writeFile(file,JSON.stringify(original));
  const patch=join(profile,'cordis.patch.yml');await writeFile(patch,'# user preference\n[]\n');
  await rm(root,{recursive:true});
  for(let run=0;run<2;run++)await setupProfile({root:base,home,pluginRoot,relocate:true});
  for(const name of names)assert.equal(await realpath(join(profile,'node_modules/@shiwen/dsh-'+name)),join(pluginRoot,name));
  assert.equal(JSON.parse(await readFile(file,'utf8')).dependencies['custom-plugin'],'1.2.3');
  assert.equal(await readFile(patch,'utf8'),'# user preference\n[]\n');
 }finally{await rm(base,{recursive:true,force:true});}
});
test('插件目录出现非托管文件时停止，不覆盖用户内容',async()=>{
 const base=await mkdtemp(join(tmpdir(),'shiwen-profile-conflict-'));
 try{
  const home=join(base,'data/dsh');for(const name of names)await mkdir(join(base,'plugins',name),{recursive:true});
  const {profile}=await setupProfile({root:base,home});
  const destination=join(profile,'node_modules/@shiwen/dsh-library');await unlink(destination);await writeFile(destination,'keep');
  await assert.rejects(setupProfile({root:base,home,relocate:true}),/冲突/);
  assert.equal(await readFile(destination,'utf8'),'keep');
 }finally{await rm(base,{recursive:true,force:true});}
});
