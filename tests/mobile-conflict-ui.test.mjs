import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

for(const fixture of ['sync-conflict-browser.jsx','sync-refresh-browser.jsx','sync-auto-list-browser.jsx'])test('conflict UI safely handles '+fixture,{skip:!process.env.SHIWEN_TEST_CHROME},async()=>{
  const dir=await mkdtemp(join(tmpdir(),'shiwen-conflict-ui-'));
  const entry=resolve('tests/support',fixture);
  try{
    await build({entryPoints:[entry],nodePaths:[resolve('android/node_modules')],bundle:true,format:'iife',outfile:join(dir,'app.js'),jsx:'automatic',plugins:[{name:'fixture-bridge',setup(b){b.onResolve({filter:/^\.\.\/bridge\/library\.mjs$/},()=>({path:entry}));}}]});
    await writeFile(join(dir,'index.html'),'<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="app.css"><div id="root"></div><pre id="result" hidden></pre><script src="app.js"></script>');
    const {stdout}=await promisify(execFile)(process.env.SHIWEN_TEST_CHROME,['--headless','--no-sandbox','--disable-gpu','--disable-dev-shm-usage',`--user-data-dir=${join(dir,'chrome')}`,'--virtual-time-budget=10000','--dump-dom',`file://${join(dir,'index.html')}`],{timeout:30000,maxBuffer:2*1024*1024});
    const result=stdout.match(/<pre id="result"[^>]*>([\s\S]*?)<\/pre>/)?.[1]||stdout.slice(-2000);
    assert.match(result,/"passed":true/,result);
  }finally{await rm(dir,{recursive:true,force:true});}
});
