import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer} from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createStore} from '../plugins/library/legacy/store.mjs';
import {createContentSearch} from '../plugins/library/src/search/service.mjs';
import {createModel} from '../plugins/library/src/search/model.mjs';
import {apply} from '../plugins/workbench/src/index.mjs';

const chrome=process.env.SHIWEN_TEST_CHROME,modelDir=process.env.SHIWEN_TEST_MODEL_DIR;
test('desktop idea opens an explorable canvas backed by the real semantic index',{skip:!chrome||!modelDir},async t=>{
  const dir=await mkdtemp(join(tmpdir(),'shiwen-canvas-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const dbDir=join(dir,'library');await mkdir(dbDir);
  const library=createStore(join(dbDir,'library.sqlite'));
  library.paths={root:dir,library:dbDir};
  const model=createModel({directory:modelDir});
  assert.ok(await model.available(),'A prepared local model is required');
  library.contentSearch=createContentSearch({library,modelFactory:()=>model});
  t.after(async()=>{await library.contentSearch.close();library.close();});
  library.save({kind:'idea',title:'每周回看',body:'每周回看日记，让我发现自己反复担心的事情。'});
  library.save({kind:'idea',title:'重复的心事',body:'重读旧日记，我发现相同的烦恼已经出现了许多次。'});
  library.save({kind:'freewrite',title:'星期天',body:'翻看过去的日记才发现，我常常在不同日子里为同一件事情焦虑。'});
  library.save({kind:'article',title:'给未来的自己',body:'回看一周的日记，我能发现哪些担心反复出现。'});
  library.save({kind:'journal',title:'月末的笔记',body:'我翻看这个月的日记，才发现那些反复出现的担忧。'});
  library.save({kind:'freewrite',title:'周末整理',body:'每周重读日记，把一再担心的事情记在一起。'});
  library.save({kind:'idea',title:'回读的习惯',body:'翻看一年前的日记，看见过去的烦恼是怎样一再出现的。'});
  library.save({kind:'reference',title:'日记的另一种读法',body:'每周回看日记时，专门圈出重复出现的担忧，再想想这些烦恼后来怎样了。'});
  library.save({kind:'freewrite',title:'春天播种',body:'种番茄要在春天播种，保持土壤湿润。'});
  library.readingNoteSave({requestId:'category-note',book:'园艺笔记',day:'2026-11-19',noteType:'excerpt',reflection:'',excerpts:[{text:'番红花开在秋天。',page:'11'}]});
  await library.contentSearch.enable();
  for(let i=0;i<200&&!library.contentSearch.status().canSearchSemantic;i++)await new Promise(r=>setTimeout(r,25));
  assert.ok(library.contentSearch.status().canSearchSemantic);
  let route;
  const peer={id:'test'};
  apply({shiwenLibrary:library,effect:fn=>fn(),connection:{browserPeer:peer,admit:()=>({peer}),fetch:{register:value=>{route=value;}}}});
  const {outputFiles:[app]}=await build({entryPoints:['tests/support/idea-canvas-browser.jsx'],nodePaths:[resolve('android/node_modules')],bundle:true,write:false,jsx:'automatic',loader:{'.css':'text'},define:{__SHIWEN_VERSION__:'"test"'}});
  let dropSaveResponse=true;
  const server=createServer(async(req,res)=>{
    if(req.url==='/api/shiwen'&&req.method==='POST'){
      const parts=[];for await(const part of req)parts.push(part);
      const reply=await route.fetch(new Request('http://localhost/api/shiwen',{method:'POST',body:Buffer.concat(parts)}));
      if(dropSaveResponse&&reply.ok&&JSON.parse(Buffer.concat(parts)).method==='saveMarkdown'){
        dropSaveResponse=false;res.writeHead(502,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'test lost response'}));return;
      }
      res.writeHead(reply.status,{'Content-Type':'application/json'});res.end(await reply.text());
    }else if(req.url==='/app.js'){res.setHeader('Content-Type','text/javascript');res.end(app.contents);}
    else{res.end('<!doctype html><meta charset="UTF-8"><style>html,body,#root{height:100%;margin:0}</style><div id="root"></div><pre id="result"></pre><script src="/app.js"></script>');}
  });
  await new Promise((ok,fail)=>server.once('error',fail).listen(0,'127.0.0.1',ok));
  t.after(()=>server.close());
  const {stdout}=await promisify(execFile)(chrome,['--headless','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--no-first-run','--window-size=1280,900','--virtual-time-budget=22000','--dump-dom','--user-data-dir='+join(dir,'chrome'),'http://127.0.0.1:'+server.address().port],{timeout:45000,maxBuffer:3*1024*1024});
  assert.equal(stdout.match(/<pre id="result">([^<]*)<\/pre>/)?.[1],'passed');
  const records=library.snapshot().records, drafts=records.filter(row=>row.title==='每周回看 · 文章大纲');
  assert.equal(drafts.length,1,'retry should reuse the original creation');
  assert.equal(drafts[0].stage,'draft');
  assert.ok(library.get(drafts[0].id).sourceIds.includes(records.find(row=>row.title==='每周回看').id));
  assert.equal(records.length,11,'all original records survive canvas removal');
});
