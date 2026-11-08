import test from 'node:test';
import assert from 'node:assert/strict';
import {browserAccess} from '../plugins/workbench/src/browser-access.mjs';
import {apply as workbench} from '../plugins/workbench/src/index.mjs';
import {createStore} from '../plugins/library/legacy/store.mjs';
import {plainDoc} from '../plugins/library/legacy/content.mjs';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

function context(server={host:'127.0.0.1',port:12345,protocol:'http:'}){
 return {get:name=>name==='webServer'?server:{name:'desktop'},
  shiwenLibrary:{paths:{library:'/synthetic/library'}},
  connection:{authenticatedUrl:url=>url+'?token=test-only'}};
}
test('workbench image save retry survives a later edit',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'shiwen-workbench-replay-')),store=createStore(join(dir,'library.sqlite'));t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
 const browserPeer={},ctx=context();let route;ctx.shiwenLibrary=store;ctx.effect=fn=>fn();ctx.connection={browserPeer,admit:()=>({peer:browserPeer}),fetch:{register:value=>{route=value;return()=>{};}}};workbench(ctx);
 const invoke=async(method,args)=>{const response=await route.fetch(new Request('http://localhost/api/shiwen',{method:'POST',body:JSON.stringify({method,args})}));return {status:response.status,...await response.json()};};
 const row=store.save({kind:'reference',origin:'external',body:'Original'}),image=store.stageWorkbenchImage({name:'x.png',data:Buffer.from('89504e470d0a1a0a00010203','hex').toString('base64')});
 const args={id:row.id,revision:row.revision,kind:'reference',title:'Image',body:`Original\n![x](attachment:${image.id})`,stage:'draft',imageIds:[image.id],requestId:'replay-after-edit'};
 const first=await invoke('saveMarkdown',args);assert.equal(first.status,200);
 store.save({id:row.id,revision:first.result.revision,doc:plainDoc('Original','ai')});
 const retry=await invoke('saveMarkdown',args);assert.equal(retry.status,200,retry.error);assert.equal(retry.result.id,first.result.id);
 const changed=await invoke('saveMarkdown',{...args,body:'different'});assert.equal(changed.status,400);assert.match(changed.error,/不同内容/);
 const missing=await invoke('saveMarkdown',{kind:'reference',body:'![x](attachment:unknown)'});assert.equal(missing.status,400);assert.match(missing.error,/图片不存在/);
 const example=await invoke('saveMarkdown',{kind:'reference',body:'`![x](attachment:unknown)`'});assert.equal(example.status,200);
 const legacy=store.save({kind:'reference',body:'![x](attachment:unknown)'});const legacyEdit=await invoke('saveMarkdown',{id:legacy.id,revision:legacy.revision,kind:'reference',body:'![x](attachment:unknown)\nkeep editing'});assert.equal(legacyEdit.status,200);
 const restored=createStore(join(dir,'restore.sqlite'));t.after(()=>restored.close());restored.restoreBackup(store.exportBackup());
 const requestPayload={id:args.id,revision:args.revision,kind:args.kind,title:args.title,body:args.body,stage:args.stage,sourceIds:args.sourceIds,imageIds:args.imageIds};
 assert.equal(restored.workbenchImageReceipt({requestId:args.requestId,requestPayload}).id,first.result.id);
});
test('浏览器入口复用 Host 地址；只有显式请求登录地址时返回凭据',()=>{
 const ctx=context(),status=browserAccess(ctx);
 assert.equal(status.url,'http://127.0.0.1:12345/');
 assert.equal(status.library,'/synthetic/library');
 assert.equal(status.desktop,true);
 assert.equal('loginUrl' in status,false);
 assert.equal(browserAccess(ctx,{login:true}).loginUrl,status.url+'?token=test-only');
 assert.equal(browserAccess(context({host:'::1',port:23456,protocol:'https:'})).url,'https://[::1]:23456/');
});
test('无有效监听地址不生成登录凭据',()=>{
 for(const server of [undefined,{host:'127.0.0.1',port:0},{host:'127.0.0.1'}, {host:'0.0.0.0',port:3080,protocol:'http:'}]){
  const ctx=context(null);ctx.get=name=>name==='webServer'?server:undefined;
  assert.equal(browserAccess(ctx).available,false);
  assert.throws(()=>browserAccess(ctx,{login:true}),/No browser endpoint/);
 }
});

test('登录地址仅发给 DSH 浏览器 Peer，拒绝 API Peer 与伪造身份且不生成凭据',async()=>{
 const ctx=context(),browserPeer={id:'browser',principal:{kind:'owner'},interactions:'answer'};
 let route,admission={peer:browserPeer},issued=0,received;
 ctx.effect=fn=>fn();
 ctx.connection={browserPeer,fetch:{register:value=>{route=value;return()=>{};}},
  admit:request=>{received=request;return admission;},
  authenticatedUrl:url=>{issued++;return url+'?token=test-only';}};
 workbench(ctx);
 const invoke=async(method,args={})=>{
  const request=new Request('http://127.0.0.1/api/shiwen',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({method,args})});
  const response=await route.fetch(request);return {request,response,body:await response.json()};
 };
 const allowed=await invoke('browserLogin');
 assert.equal(allowed.response.status,200);assert.equal(received,allowed.request);
 assert.match(allowed.body.result.loginUrl,/token=test-only/);assert.equal(issued,1);
 for(const rejected of [
  {peer:{id:'api',principal:{kind:'owner'},interactions:'none'}},
  {peer:{id:'api-answer',principal:{kind:'owner'},interactions:'answer'}},
  {peer:{...browserPeer}},
  {rejection:401},{rejection:403}
 ]){
  admission=rejected;
  const denied=await invoke('browserLogin',{peer:browserPeer});
  assert.equal(denied.response.status,rejected.rejection??403);
  assert.equal(denied.response.headers.get('cache-control'),'no-store');
  assert.equal('result' in denied.body,false);assert.equal(JSON.stringify(denied.body).includes('token='),false);
  assert.equal(issued,1);
 }
 for(const [method,args] of [['readImage',{}],['stageImage',{}],['workbenchDraft',{}],['discardStagedImages',{}],['saveMarkdown',{imageIds:['test']}]]){
  const denied=await invoke(method,args);assert.equal(denied.response.status,403);
 }
 const status=await invoke('browserStatus');assert.equal(status.response.status,200);
 assert.equal('loginUrl' in status.body.result,false);assert.equal(issued,1);
});

test('局域网入口使用服务配置，不读取请求头',()=>{
 const status=browserAccess(context({host:'192.168.1.5',port:3080,protocol:'http:'}));
 assert.equal(status.url,'http://192.168.1.5:3080/');assert.equal(status.local,false);assert.equal(status.available,true);
});
