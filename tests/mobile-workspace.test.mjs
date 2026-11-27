import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtemp,rm,writeFile,copyFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {workspaceAdapter} from '../android/web/workspace-adapter.mjs';

test('paired phone reads and edits the same local topics while disconnected',async()=>{
  const calls=[];
  const rpc=workspaceAdapter(async(method,args)=>{
    assert.equal(method,'workspaceThemes');
    assert.equal(args.libraryId,'bound');
    calls.push(args.method);
    return {result:{revision:2}};
  },{libraryId:'bound',role:'replica'});
  await rpc('themeList');
  await rpc('themeRead',{id:'theme'});
  await rpc('themeMemberAdd',{themeId:'theme',sourceRecordId:'source',sourceRevision:4,field:'body',expectedLibraryId:'bound'});
  assert.deepEqual(calls,['themeList','themeRead','themeMemberAdd']);
  await assert.rejects(()=>rpc('themeDelete',{expectedLibraryId:'elsewhere'}),/切换/);
});

test('phone workspace navigates collections and highlights, adds a passage to a topic and opens the generated outline in Writing',{skip:!process.env.SHIWEN_TEST_CHROME},async t=>{
  const dir=await mkdtemp(join(tmpdir(),'shiwen-mobile-workspace-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const entry=resolve('tests/support/mobile-workspace-browser.jsx');
  await build({entryPoints:[entry],bundle:true,loader:{'.webp':'file'},outfile:join(dir,'app.js'),nodePaths:[resolve('android/node_modules')],jsx:'automatic',plugins:[{
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

test('phone meaning search uses the active local index in standalone and paired libraries',async()=>{
  for(const role of ['standalone','coordinated']){
    const calls=[];
    const rpc=workspaceAdapter(async(method,args)=>{
      calls.push(method);
      assert.equal(args.libraryId,'local');
      if(method==='phoneSemanticStatus')return {canSearchSemantic:true,state:'ready',libraryScope:'local'};
      if(method==='phoneSemanticSearch')return {items:[{recordId:'found'}],libraryScope:'local'};
      if(method==='workspaceSearch')return {items:[],libraryScope:'local'};
      throw Error('Unexpected call '+method);
    },{libraryId:'local',role});
    await rpc('contentSearchEnable');
    assert.ok((await rpc('contentSearchStatus')).canSearchSemantic);
    for(const scope of ['ideaCanvas','global'])
      assert.equal((await rpc('contentSearch',{scope,mode:'semantic',query:'以前对拖延的看法'})).items[0].recordId,'found');
    await rpc('contentSearch',{mode:'exact',query:'拖延'});
    assert.deepEqual(calls,['phoneSemanticStatus','phoneSemanticStatus','phoneSemanticSearch','phoneSemanticSearch','workspaceSearch']);
  }
});
