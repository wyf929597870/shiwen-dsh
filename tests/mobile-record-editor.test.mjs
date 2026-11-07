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
    await writeFile(join(dir,'index.html'),'<div id="root"></div><script src="app.js"></script>');
    const {stdout}=await promisify(execFile)(process.env.SHIWEN_TEST_CHROME,[
      '--headless','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--no-first-run',
      `--user-data-dir=${join(dir,'chrome')}`,'--virtual-time-budget=15000','--dump-dom',`file://${join(dir,'index.html')}`
    ],{timeout:45000,maxBuffer:2*1024*1024});
    assert.match(stdout,/"passed":\[/,stdout);
    assert.doesNotMatch(stdout,/"error":/,stdout);
  } finally {await rm(dir,{recursive:true,force:true});}
});
