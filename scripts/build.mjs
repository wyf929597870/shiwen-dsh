import {build} from 'esbuild';
import {mkdir,readFile,writeFile,copyFile} from 'node:fs/promises';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..');
const product=JSON.parse(await readFile(resolve(root,'package.json'),'utf8'));
const define={__SHIWEN_VERSION__:JSON.stringify(product.version)};
const outputArg=process.argv.indexOf('--out-dir');
const outputRoot=outputArg<0?resolve(root,'plugins'):resolve(process.argv[outputArg+1]);
for(const name of ['library','agent-tools','theme','workbench','personal-context','external']){
  const dir=resolve(root,'plugins',name),manifest=JSON.parse(await readFile(resolve(dir,'package.json'),'utf8'));
  const out=resolve(outputRoot,name);
  await mkdir(resolve(out,'lib'),{recursive:true});
  if(out!==dir)await copyFile(resolve(dir,'package.json'),resolve(out,'package.json'));
  await build({entryPoints:[resolve(dir,'src/index.mjs')],outfile:resolve(out,'lib/index.js'),bundle:true,define,platform:'node',format:'esm',packages:'external',target:'node24'});
  if(manifest.dsh?.client){
    const result=await build({entryPoints:[resolve(dir,'src/client.jsx')],bundle:true,define,write:false,platform:'browser',format:'cjs',external:['react','react-dom'],loader:{'.css':'text'},target:'chrome130'});
    const code=result.outputFiles[0].text;
    await writeFile(resolve(out,'lib/client.js'),`window.__ModuleLoader__.load({id:${JSON.stringify(manifest.name)},factory:(require)=>{var module={exports:{}};var exports=module.exports;\n${code}\nreturn module.exports;}});\n`);
  }
  if(name==='theme')await copyFile(resolve(root,'assets/shiwen-mark.png'),resolve(out,'lib/shiwen-mark.png'));
}
console.log('Built Shiwen DSH plugins.');
