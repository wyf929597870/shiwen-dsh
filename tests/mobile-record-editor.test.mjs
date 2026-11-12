import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

test('record editor saves and recovers pending edits without trapping navigation', {skip:!process.env.SHIWEN_TEST_CHROME}, async()=>{
  const dir=await mkdtemp(join(tmpdir(),'shiwen-editor-test-'));
  const entry=resolve('tests/support/record-editor-browser.jsx');
  try {
    await build({entryPoints:[entry],nodePaths:[resolve('android/node_modules')],bundle:true,format:'iife',outfile:join(dir,'app.js'),jsx:'automatic',plugins:[{
      name:'fixture-bridge',setup(build){build.onResolve({filter:/^\.\.\/bridge\/library\.mjs$/},()=>({path:entry}));}
    }]});
    await writeFile(join(dir,'index.html'),'<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="app.css"><div id="root"></div><script src="app.js"></script>');
    const {stdout}=await promisify(execFile)(process.env.SHIWEN_TEST_CHROME,[
      '--headless','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--no-first-run','--window-size=390,844',
      `--user-data-dir=${join(dir,'chrome')}`,'--virtual-time-budget=15000','--dump-dom',`file://${join(dir,'index.html')}`
    ],{timeout:45000,maxBuffer:2*1024*1024});
    const result=stdout.match(/<pre id="result"[^>]*>([\s\S]*?)<\/pre>/)?.[1]||stdout.slice(-2000);
    assert.match(result,/"passed":\[/,result);
    assert.doesNotMatch(result,/"error":/,result);
  } finally {await rm(dir,{recursive:true,force:true});}
});
