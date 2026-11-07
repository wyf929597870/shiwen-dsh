import {build} from 'esbuild';
import {mkdir,copyFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..'),out=resolve(root,'preview-dist');
await mkdir(out,{recursive:true});
await build({entryPoints:[resolve(root,'preview/main.jsx')],bundle:true,format:'esm',outfile:resolve(out,'app.js'),target:'chrome100',jsx:'automatic',plugins:[{name:'preview-bridge',setup(build){build.onResolve({filter:/^\.\.\/bridge\/library\.mjs$/},()=>({path:resolve(root,'preview/library.mjs')}));}}]});
await copyFile(resolve(root,'../assets/shiwen-mark.png'),resolve(out,'shiwen-mark.png'));
await writeFile(resolve(out,'index.html'),'<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>拾文开发预览</title><link rel="stylesheet" href="./app.css"></head><body><div id="root"></div><script type="module" src="./app.js"></script></body></html>');
console.log('Built isolated preview. No real data or service is used.');
