// Isolated real host: desktop loopback alias, legacy HTTP and pinned mobile TLS.
import {mkdtemp,readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {connect} from 'node:tls';
import {request} from 'node:https';
import {request as httpRequest} from 'node:http';
import {protocolVersion} from '../contracts/mobile/v1/schema.mjs';
import {X509Certificate,createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {startServer,stopServer} from './server-control.mjs';
const root=await mkdtemp('/tmp/shiwen-secure-host-');
const fingerprint=raw=>createHash('sha256').update(new X509Certificate(raw).publicKey.export({format:'der',type:'spki'})).digest('hex');
const cookie=res=>res.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');
const password='Isolated-network-test-8321';
const resources=process.argv[3]?resolve(process.argv[3]):null;
const launch=resources?{runtime:resources,worker:join(resources,'scripts/server-worker.mjs'),node:join(resources,'../runtime/primary-runtime/dependencies/node/bin/node')}:{runtime:resolve(process.argv[2]??'.')};
try{
 const service=await startServer({root,host:'127.0.0.2',port:0,discoverLan:false},launch);
 const local=new URL(service.loginUrl).origin;
 assert.notEqual(local,new URL(service.url).origin,'desktop uses permanent loopback alias');
 const boot=await fetch(service.loginUrl,{redirect:'manual'});assert.equal(boot.status,303);let admin=cookie(boot);
 const post=async(base,path,body,session='')=>fetch(base+path,{method:'POST',headers:{Origin:base,'Content-Type':'application/json',cookie:session},body:JSON.stringify(body)});
 const changed=await post(local,'/auth/password',{password},admin);assert.equal(changed.status,200);admin=cookie(changed);
 assert.equal((await post(local,'/api/shiwen',{method:'browserStatus'},admin)).status,200);
 const socket=await new Promise((resolve,reject)=>{
  const req=httpRequest(local+'/api/remote.mux',{headers:{Cookie:admin,Origin:local,Connection:'Upgrade',Upgrade:'websocket','Sec-WebSocket-Version':'13','Sec-WebSocket-Key':'dGhlIHNhbXBsZSBub25jZQ=='}});
  req.once('upgrade',(_res,s)=>resolve(s));req.once('response',r=>reject(Error('Local websocket status '+r.statusCode)));req.on('error',reject);req.end();
 });socket.on('error',()=>{});socket.destroy();
 // A forged cross-origin request cannot use the new local alias.
 assert.equal((await fetch(local+'/auth/status',{headers:{Origin:'https://evil.invalid',cookie:admin}})).status,403);
 const legacy=new URL(service.url).origin;
 const login=await post(legacy,'/auth/login',{password});assert.equal(login.status,200);
 assert.equal((await post(legacy,'/api/shiwen',{method:'mobileAgentProfile'},cookie(login))).status,200);
 const endpoint=new URL(service.secure.endpoints[0]);
 const cert=await new Promise((resolve,reject)=>{
  // Retrieve PUBLIC certificate only, then verify it against the independently
  // authenticated local control channel BEFORE sending credentials or requests.
  const socket=connect({host:endpoint.hostname,port:Number(endpoint.port),rejectUnauthorized:false},()=>{
   try{const raw=socket.getPeerCertificate().raw;assert.equal(fingerprint(raw),service.secure.fingerprint);resolve(new X509Certificate(raw).toString());}catch(e){reject(e);}finally{socket.destroy();}
  });socket.on('error',reject);
 });
 const tls=async(path,body,token)=>new Promise((resolve,reject)=>{
  const req=request(new URL(path,endpoint),{method:body?'POST':'GET',agent:false,ca:cert,checkServerIdentity(_host,peer){if(fingerprint(peer.raw)!==service.secure.fingerprint)return Error('IDENTITY_MISMATCH');},headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})}},res=>{
   let text='';res.on('data',x=>text+=x);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text)}));
  });req.on('error',reject);req.end(body?JSON.stringify(body):undefined);
 });
 const authorization=await tls('/auth/login',{password});assert.equal(authorization.status,200);const token=authorization.body.token;
 const profile=await tls('/api/shiwen',{method:'mobileAgentProfile'},token);assert.equal(profile.status,200);assert.equal(profile.body.result.agentId,'shiwen');
 const sync=await tls('/api/shiwen',{method:'mobileSync',args:{action:'identity',request:{protocolVersion,deviceId:'a5d58f42-7dc7-457b-8616-915d292af3b1'}}},token);assert.equal(sync.status,200,JSON.stringify(sync.body));assert.ok(sync.body.result.data.libraryId);
 const owner=async(method,args)=>{const response=await post(local,'/api/shiwen',{method,args},admin);const data=await response.json();assert.equal(response.status,200,JSON.stringify(data));return data.result;};
 const original=await owner('saveMarkdown',{kind:'freewrite',title:'隔离原文',body:'自己写的原文'}),anchor=await owner('originalVersionInfo',{id:original.id});
 const annotation=await owner('annotationCreate',{originalId:original.id,originalVersionId:anchor.versionId,originalContentHash:anchor.contentHash,body:'单独的 AI 标注',requestId:'isolated-note'});
 assert.equal((await owner('annotationRead',{id:annotation.id})).markdown,'单独的 AI 标注');
 assert.equal((await owner('readMarkdown',{id:original.id})).markdown,'自己写的原文');
 const exported=await owner('exportDocumentBundle',{id:original.id});assert.equal(Buffer.from(exported.dataBase64,'base64').readUInt32LE(),0x04034b50);
 assert.equal((await owner('annotationList',{originalId:original.id})).length,1);
 assert.ok(Number.isInteger((await owner('reviewPreview',{period:'7'})).personalOriginalCharacters));
 const status=await(await fetch(local+'/auth/status',{headers:{cookie:admin}})).json();
 const device=status.devices.find(x=>x.name==='Shiwen Android');assert.ok(device);
 assert.equal((await post(local,'/auth/revoke',{id:device.id},admin)).status,200);
 assert.equal((await tls('/api/shiwen',{method:'mobileAgentProfile'},token)).status,401);
 const log=await readFile(join(root,'server/server.log'),'utf8');assert.ok(!log.includes(token));assert.ok(!log.includes(password));
 console.log('Real host passed: stable desktop loopback, legacy HTTP, pinned TLS profile and sync, separate annotations/export, shared revocation, no credential logs.');
}finally{await stopServer(root);}
