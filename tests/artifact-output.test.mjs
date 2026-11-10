import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {artifactOutput,sha256} from '../scripts/artifact-output.mjs';
async function setup(t){const root=await mkdtemp(join(tmpdir(),'shiwen-artifacts-'));t.after(()=>rm(root,{recursive:true,force:true}));return root;}
test('successful package replaces old package/checksum only in its own platform and channel',async t=>{
 const root=await setup(t);
 for(const path of ['release/linux','release/android','debug/linux']){await mkdir(join(root,path),{recursive:true});await writeFile(join(root,path,'old.apk'),'previous');}
 await writeFile(join(root,'release/linux','old.apk.sha256'),'old checksum');
 const out=await artifactOutput({root,platform:'linux'}),input=join(out.directory,'new.deb');await writeFile(input,'new verified package');
 await out.publish([input]);await out.dispose();
 assert.deepEqual((await readdir(join(root,'release/linux'))).sort(),['new.deb','new.deb.sha256']);
 assert.equal(await readFile(join(root,'release/linux/new.deb.sha256'),'utf8'),await sha256(join(root,'release/linux/new.deb'))+'  new.deb\n');
 assert.equal(await readFile(join(root,'release/android/old.apk'),'utf8'),'previous');
 assert.equal(await readFile(join(root,'debug/linux/old.apk'),'utf8'),'previous');
 assert.deepEqual((await readdir(join(root,'release'))).sort(),['android','linux']);
});
test('failed build or empty artifact retains the last good package',async t=>{
 const root=await setup(t);await mkdir(join(root,'release/android'),{recursive:true});await writeFile(join(root,'release/android/old.apk'),'last good');
 const out=await artifactOutput({root,platform:'android'}),empty=join(out.directory,'empty.apk');await writeFile(empty,'');
 await assert.rejects(out.publish([empty]),/Invalid artifact/);await out.dispose();
 assert.equal(await readFile(join(root,'release/android/old.apk'),'utf8'),'last good');
 const cancelled=await artifactOutput({root,platform:'android'});await cancelled.dispose();
 assert.deepEqual(await readdir(join(root,'release/android')),['old.apk']);
});
test('custom output paths, symlink destinations and concurrent publishers are rejected',async t=>{
 const root=await setup(t);
 await assert.rejects(artifactOutput({root,platform:'linux',args:['--out-dir',join(root,'release/date')]}),/custom version/);
 const out=await artifactOutput({root,platform:'linux'});
 await assert.rejects(artifactOutput({root,platform:'linux'}),{code:'EEXIST'});await out.dispose();
 await mkdir(join(root,'unrelated'));await symlink(join(root,'unrelated'),join(root,'release/linux'),'dir');
 await assert.rejects(artifactOutput({root,platform:'linux'}),/Unsafe/);
 assert.deepEqual(await readdir(join(root,'unrelated')),[]);
});
