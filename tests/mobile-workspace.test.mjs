import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtemp,rm,writeFile,copyFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {workspaceAdapter} from '../android/web/workspace-adapter.mjs';

test('synced topics require matching local and server source text, with the server revision on write',async()=>{
  let remoteText='电脑修改',writes=[];
  const call=async(method,args)=>{
    assert.equal(args.libraryId,'bound');
    if(method==='recordRead')return {id:'source',kind:'idea',markdown:'手机修改',revision:4};
    assert.equal(method,'workspaceRemote');
    if(args.method==='readMarkdown')return {result:{id:'source',sourceLibraryId:'bound',kind:'idea',revision:17,markdown:remoteText}};
    writes.push(args);return {result:{revision:2}};
  };
  const rpc=workspaceAdapter(call,{libraryId:'bound',role:'replica'});
  const add=()=>rpc('themeMemberAdd',{themeId:'theme',sourceRecordId:'source',sourceRevision:4,field:'body',expectedLibraryId:'bound'});
  await assert.rejects(add,/同步/);assert.equal(writes.length,0);
  remoteText='手机修改';await add();assert.equal(writes[0].args.sourceRevision,17);
  await assert.rejects(()=>rpc('themeDelete',{expectedLibraryId:'elsewhere'}),/切换/);
});

test('phone workspace navigates collections and highlights, adds a passage to a topic and opens the generated outline in Writing',{skip:!process.env.SHIWEN_TEST_CHROME},async t=>{
  const dir=await mkdtemp(join(tmpdir(),'shiwen-mobile-workspace-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const entry=resolve('tests/support/mobile-workspace-browser.jsx');
  await build({entryPoints:[entry],bundle:true,outfile:join(dir,'app.js'),nodePaths:[resolve('android/node_modules')],jsx:'automatic',plugins:[{
    name:'isolated-native-bridge',setup(b){b.onResolve({filter:/^\.\.\/bridge\/library\.mjs$/},()=>({path:entry}));}
  }]});
  await writeFile(join(dir,'index.html'),'<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="app.css"><div id="root"></div><script src="app.js"></script>');
  await copyFile('assets/shiwen-mark.png',join(dir,'shiwen-mark.png'));
  await writeFile(join(dir,'phone.html'),`<!doctype html><meta charset="utf-8"><style>body{margin:0}iframe{border:0}</style>
    <iframe style="width:320px;height:568px" src="index.html"></iframe><script>
    addEventListener('message',event=>{
      const phone=document.querySelector('iframe');
      if(event.source!==phone.contentWindow)return;
      if(event.data==='rotate'){phone.style.width='568px';phone.style.height='320px';}
      else document.body.dataset.qa=event.data;
    });
    </script>`);
  const check=async(screen='',theme='light')=>{
    const args=['--headless','--disable-gpu','--no-sandbox','--disable-dev-shm-usage','--window-size=390,844','--virtual-time-budget=20000','--dump-dom','--user-data-dir='+join(dir,'chrome')];
    if(screen)args.push('--screenshot='+join(process.env.SHIWEN_WORKSPACE_PREVIEW,`android-${screen}-${theme}.png`));
    const {stdout}=await promisify(execFile)(process.env.SHIWEN_TEST_CHROME,[...args,`file://${dir}/${screen?'index':'phone'}.html?screen=${screen}&theme=${theme}`],{maxBuffer:3*1024*1024,timeout:45000});
    assert.equal(stdout.match(/data-qa="([^"]*)"/)?.[1]??stdout.slice(-1200),'passed');
  };
  await check();
  if(process.env.SHIWEN_WORKSPACE_PREVIEW){await check('reading');await check('canvas','dark');}
});

test('the phone uses the PC semantic index and reads the same topic membership',{skip:!process.env.SHIWEN_TEST_MODEL_DIR},async t=>{
  const {createStore}=await import('../plugins/library/legacy/store.mjs');
  const {createContentSearch}=await import('../plugins/library/src/search/service.mjs');
  const {createModel}=await import('../plugins/library/src/search/model.mjs');
  const {apply}=await import('../plugins/workbench/src/index.mjs');
  const dir=await mkdtemp(join(tmpdir(),'phone-pc-search-'));
  const library=createStore(join(dir,'library.sqlite'));library.paths={root:dir,library:dir};
  const model=createModel({directory:process.env.SHIWEN_TEST_MODEL_DIR});
  library.contentSearch=createContentSearch({library,modelFactory:()=>model});
  t.after(async()=>{await library.contentSearch.close();library.close();await rm(dir,{recursive:true,force:true});});
  const record=library.save({kind:'idea',title:'每周回看',body:'每周回看日记，让我发现自己反复担心的事情。'});
  const related=library.save({kind:'freewrite',title:'重复的心事',body:'重读旧日记，我发现相同的烦恼已经出现了许多次。'});
  const libraryId=library.themeContext().libraryId;
  const peer={id:'owner'};let route;
  apply({shiwenLibrary:library,effect:fn=>fn(),connection:{browserPeer:peer,admit:()=>({peer}),fetch:{register:config=>{route=config;}}}});
  const rpc=workspaceAdapter(async(method,request)=>{
    assert.equal(request.libraryId,libraryId);
    if(method==='recordRead')return {...record,markdown:'每周回看日记，让我发现自己反复担心的事情。'};
    assert.equal(method,'workspaceRemote');
    const result=await route.fetch(new Request('http://localhost/api/shiwen',{method:'POST',body:JSON.stringify({method:request.method,args:request.args})}));
    const data=await result.json();assert.equal(result.status,200,data.error);return data;
  },{libraryId,role:'replica'});
  await library.contentSearch.enable();
  for(let i=0;i<160&&!library.contentSearch.status().canSearchSemantic;i++)await new Promise(r=>setTimeout(r,30));
  assert.equal((await rpc('serverSearchStatus')).canSearchSemantic,true);
  const found=await rpc('contentSearch',{scope:'ideaCanvas',mode:'semantic',query:'回看日记，找出反复出现的担忧',offset:0,limit:5});
  assert.equal(found.libraryScope,libraryId);assert.ok(found.items.some(x=>x.recordId===related.id));
  const topic=await rpc('themeSave',{title:'手机与电脑',summary:'',expectedLibraryId:libraryId});
  await rpc('themeMemberAdd',{themeId:topic.id,revision:topic.revision,sourceRecordId:record.id,sourceRevision:record.revision,field:'body',expectedLibraryId:libraryId});
  assert.equal(library.themeRead({id:topic.id}).members[0].sourceRecordId,record.id);
  assert.equal((await rpc('themeList'))[0].memberCount,1);
});
