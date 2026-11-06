import {execFileSync} from 'node:child_process';
import {existsSync,mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';

const root=resolve(import.meta.dirname,'..');
const git=(cwd,args,options={})=>execFileSync('git',['-C',cwd,...args],{encoding:'utf8',...options});

// Refuse to reset existing checkouts: developer changes must never be discarded.
export function setupUpstream({target,repository,commit,patch,checkOnly=false}){
 if(!existsSync(target)){
  if(checkOnly)throw Error('Upstream checkout missing. Run npm run upstream:prepare.');
  execFileSync('git',['clone','--no-checkout',repository,target],{stdio:'inherit'});
  git(target,['checkout','--detach',commit]);
 }
 const head=git(target,['rev-parse','HEAD']).trim();
 if(head!==commit)throw Error(`Upstream revision differs from the lock: ${head}. Existing checkout was not changed.`);
 if(git(target,['diff','--cached','--name-only']).trim())throw Error('Upstream has staged changes. Existing checkout was not changed.');
 if(git(target,['ls-files','--others','--exclude-standard']).trim())throw Error('Upstream has untracked source files. Existing checkout was not changed.');
 const diff=git(target,['diff','--binary','--no-ext-diff','--no-color','HEAD']);
 if(diff===patch)return 'already prepared';
 if(diff)throw Error('Upstream changes differ from the recorded patch. Existing checkout was not changed.');
 if(checkOnly)throw Error('Upstream patch not applied. Run npm run upstream:prepare.');
 git(target,['apply','--check','-'],{input:patch});
 git(target,['apply','-'],{input:patch});
 return 'prepared';
}

export function checkPatch({target,commit,patch}){
 // A disposable index verifies applicability without changing any checkout files.
 const temp=mkdtempSync(join(tmpdir(),'shiwen-patch-check-'));
 try{
  const env={...process.env,GIT_INDEX_FILE:join(temp,'index')};
  git(target,['read-tree',commit],{env});
  git(target,['apply','--cached','--check','-'],{env,input:patch});
 }finally{rmSync(temp,{recursive:true,force:true});}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{
  if(process.argv.slice(2).some(arg=>arg!=='--check'))throw Error('Usage: node scripts/setup-upstream.mjs [--check]');
  const lock=JSON.parse(readFileSync(join(root,'upstream.lock.json'),'utf8'));
  const patches=lock.patches.map(item=>{
   const bytes=readFileSync(join(root,item.path));
   if(createHash('sha256').update(bytes).digest('hex')!==item.sha256)throw Error(`Patch checksum mismatch: ${item.path}`);
   return bytes.toString('utf8');
  });
  const options={target:join(root,'upstream/dsh'),repository:lock.repository,commit:lock.commit,patch:patches.join(''),checkOnly:process.argv.includes('--check')};
  console.log(`DSH ${lock.version}: ${setupUpstream(options)} (${lock.commit}).`);
  checkPatch(options);
  console.log('Recorded patch applies cleanly to the pinned upstream.');
 }catch(error){console.error(error.message);process.exitCode=1;}
}
