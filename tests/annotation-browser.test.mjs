import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createStore} from '../plugins/library/legacy/store.mjs';
import {dateKey} from '../plugins/library/legacy/content.mjs';
import {markdownSource} from '../plugins/library/legacy/markdown.mjs';
test('web annotation editor preserves original, draft and uncertain-save identity',{skip:!process.env.SHIWEN_TEST_CHROME},async()=>{
  const dir=await mkdtemp(join(tmpdir(),'shiwen-annotation-browser-')),store=createStore(join(dir,'library.sqlite'));
  const record=store.save({kind:'freewrite',body:'自己的原文'});
  const view=row=>({...row,markdown:markdownSource(row.doc)});
  const server=createServer(async(req,res)=>{
    try{
      if(req.url==='/app.js'){res.setHeader('Content-Type','text/javascript');res.end(await readFile(join(dir,'app.js')));return;}
      if(req.url!=='/rpc'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<div id="root"></div><script src="/app.js"></script>');return;}
      let body='';for await(const chunk of req)body+=chunk;const {method,args}=JSON.parse(body);let result;
      if(method==='original')result=view(store.get(record.id));
      else if(method==='inspect')result={original:view(store.get(record.id)),annotations:store.annotationList({originalId:record.id})};
      else if(method==='changeOriginal')result=store.updateRecord({id:record.id,revision:store.get(record.id).revision,body:'编辑后的原文'});
      else if(method==='reviewFixture'){
        const day=dateKey(new Date());
        const row=store.saveDsh({kind:'freewrite',body:'个人原文',origin:'personal',day,sessionId:'review',messageId:'one',role:'user',operationId:'review-one'});
        store.saveDsh({kind:'reference',body:'我的参考',origin:'personal',day,sessionId:'review',messageId:'two',role:'user',operationId:'review-two'});
        store.saveDsh({kind:'reference',body:'外部资料',origin:'external',day,sessionId:'review',messageId:'three',role:'user',operationId:'review-three'});
        const anchor=store.originalVersionInfo({id:row.id});store.annotationCreate({originalId:row.id,originalVersionId:anchor.versionId,title:'历史 AI 标注',body:'AI 分析不计入原文',requestId:'review-note'});result=true;
      }
      else if(method==='annotationRead')result=view(store.annotationRead(args));
      else if(['review','reviewPreview','correctRecordOrigin','annotationList','originalVersionInfo','workbenchDraft','annotationCreate','annotationUpdate','annotationDelete','annotationRestore'].includes(method))result=store[method](args);
      else throw Error('Unexpected method '+method);
      res.setHeader('Content-Type','application/json');res.end(JSON.stringify({result}));
    }catch(error){res.statusCode=400;res.end(JSON.stringify({error:error.message}));}
  });
  try{
    await build({entryPoints:[resolve('tests/support/annotation-browser.jsx')],nodePaths:[resolve('android/node_modules')],bundle:true,format:'iife',outfile:join(dir,'app.js'),jsx:'automatic'});
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    const {stdout}=await promisify(execFile)(process.env.SHIWEN_TEST_CHROME,['--headless','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--no-first-run',`--user-data-dir=${join(dir,'chrome')}`,'--virtual-time-budget=30000','--dump-dom',`http://127.0.0.1:${server.address().port}/`],{timeout:60000,maxBuffer:2*1024*1024});
    assert.match(stdout,/"passed":\[/,stdout);assert.doesNotMatch(stdout,/"error":/,stdout);
  }finally{await new Promise(resolve=>server.close(resolve));store.close();await rm(dir,{recursive:true,force:true});}
});
