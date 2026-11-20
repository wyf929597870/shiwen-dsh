import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
for(const [fixture,description] of [['content-search-browser.jsx','search UI prevents composition and stale response races and rejects stale anchors'],['writing-quote-race-browser.jsx','quote insertion rechecks a changed source']])test(description,{skip:!process.env.SHIWEN_TEST_CHROME},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'shiwen-search-ui-'));
 try{await build({entryPoints:[resolve('tests/support',fixture)],nodePaths:[resolve('android/node_modules')],bundle:true,format:'iife',outfile:join(dir,'app.js'),jsx:'automatic'});await writeFile(join(dir,'index.html'),'<!doctype html><meta charset="utf-8"><div id="root"></div><pre id="result"></pre><script src="app.js"></script>');const {stdout}=await promisify(execFile)(process.env.SHIWEN_TEST_CHROME,['--headless','--no-sandbox','--disable-gpu','--disable-dev-shm-usage',`--user-data-dir=${join(dir,'chrome')}`,'--virtual-time-budget=5000','--dump-dom',`file://${join(dir,'index.html')}`],{timeout:30000,maxBuffer:2*1024*1024});const result=stdout.match(/<pre id="result">([\s\S]*?)<\/pre>/)?.[1];assert.match(result||stdout, /"passed":true/);}finally{await rm(dir,{recursive:true,force:true});}
});
