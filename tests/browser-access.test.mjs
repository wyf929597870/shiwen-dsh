import test from 'node:test';
import assert from 'node:assert/strict';
import {browserAccess} from '../plugins/workbench/src/browser-access.mjs';
import {apply as workbench} from '../plugins/workbench/src/index.mjs';

function context(server={host:'127.0.0.1',port:12345,protocol:'http:'}){
 return {get:name=>name==='webServer'?server:{name:'desktop'},
  shiwenLibrary:{paths:{library:'/synthetic/library'}},
  connection:{authenticatedUrl:url=>url+'?token=test-only'}};
}
test('浏览器入口复用 Host 地址；只有显式请求登录地址时返回凭据',()=>{
 const ctx=context(),status=browserAccess(ctx);
 assert.equal(status.url,'http://127.0.0.1:12345/');
 assert.equal(status.library,'/synthetic/library');
 assert.equal(status.desktop,true);
 assert.equal('loginUrl' in status,false);
 assert.equal(browserAccess(ctx,{login:true}).loginUrl,status.url+'?token=test-only');
 assert.equal(browserAccess(context({host:'::1',port:23456,protocol:'https:'})).url,'https://[::1]:23456/');
});
test('无监听端口或非回环部署不生成本机登录凭据',()=>{
 for(const server of [undefined,{host:'127.0.0.1',port:0},{host:'127.0.0.1'}, {host:'192.0.2.1',port:3080,protocol:'http:'}]){
  const ctx=context(null);ctx.get=name=>name==='webServer'?server:undefined;
  assert.equal(browserAccess(ctx).available,false);
  assert.throws(()=>browserAccess(ctx,{login:true}),/No local browser endpoint/);
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
 const status=await invoke('browserStatus');assert.equal(status.response.status,200);
 assert.equal('loginUrl' in status.body.result,false);assert.equal(issued,1);
});
