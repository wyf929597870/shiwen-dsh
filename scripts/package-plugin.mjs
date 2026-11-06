import {cp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
const root=resolve(import.meta.dirname,'..');
export async function preparePlugin({build=true}={}){
 if(build)execFileSync(process.execPath,[join(root,'scripts/build.mjs')],{cwd:root,stdio:'inherit'});
 const dest=join(root,'dist','dsh-shiwen');
 await rm(dest,{recursive:true,force:true});await mkdir(dest,{recursive:true});
 for(const file of ['package.json','cordis.patch.yml','appearance.patch.yml','README.md'])await cp(join(root,'bundle',file),join(dest,file));
 for(const file of ['LICENSE','THIRD_PARTY_NOTICES.md','licenses','integration','skills'])await cp(join(root,file),join(dest,file),{recursive:true});
 for(const name of ['library','agent-tools','theme','workbench','personal-context','external']){
  const target=join(dest,'plugins',name);await mkdir(target,{recursive:true});
  const manifest=JSON.parse(await readFile(join(root,'plugins',name,'package.json'),'utf8'));
  // The outer bundle supplies third-party dependencies; DSH resolves shared host peers.
  if(name==='library')manifest.peerDependencies={'@deepseek-ai/schemastery':'~3.18.6-alpha.2'};
  if(name==='agent-tools')manifest.peerDependencies={'@deepseek-ai/dsh-tools':'0.2.2-alpha.3'};
  await writeFile(join(target,'package.json'),JSON.stringify(manifest,null,2)+'\n');
  await cp(join(root,'plugins',name,'lib'),join(target,'lib'),{recursive:true});
 }
 return dest;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const dest=await preparePlugin();
 const out=join(root,'release');await mkdir(out,{recursive:true});
 execFileSync(process.platform==='win32'?'npm.cmd':'npm',['pack','--ignore-scripts','--pack-destination',out],{cwd:dest,stdio:'inherit',shell:process.platform==='win32'});
}
