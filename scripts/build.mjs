import {build} from 'esbuild';
import {mkdir,readFile,writeFile,copyFile} from 'node:fs/promises';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..');
for(const name of ['library','agent-tools','theme','workbench','personal-context','external']){
  const dir=resolve(root,'plugins',name),manifest=JSON.parse(await readFile(resolve(dir,'package.json'),'utf8'));
  await mkdir(resolve(dir,'lib'),{recursive:true});
  await build({entryPoints:[resolve(dir,'src/index.mjs')],outfile:resolve(dir,'lib/index.js'),bundle:true,platform:'node',format:'esm',packages:'external',target:'node24'});
  if(manifest.dsh?.client){
    const result=await build({entryPoints:[resolve(dir,'src/client.jsx')],bundle:true,write:false,platform:'browser',format:'cjs',external:['react','react-dom'],loader:{'.css':'text'},target:'chrome130'});
    const code=result.outputFiles[0].text;
    await writeFile(resolve(dir,'lib/client.js'),`window.__ModuleLoader__.load({id:${JSON.stringify(manifest.name)},factory:(require)=>{var module={exports:{}};var exports=module.exports;\n${code}\nreturn module.exports;}});\n`);
  }
  if(name==='theme')await copyFile(resolve(root,'assets/shiwen-mark.png'),resolve(dir,'lib/shiwen-mark.png'));
}
console.log('Built Shiwen DSH plugins.');
