// Isolated real DSH host; no user data or model calls.
import {mkdtemp,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import assert from 'node:assert/strict';
import {request} from 'node:http';
import {startServer,controlServer,stopServer} from './server-control.mjs';
const root=await mkdtemp(join(tmpdir(),'shiwen-password-'));
const password='Synthetic-password-4821';
let base,cookieA,cookieB,socket;
const cookies=r=>r.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');
const post=(path,body={},cookie='',origin=base)=>fetch(base+path,{method:'POST',headers:{origin,'content-type':'application/json',cookie},body:JSON.stringify(body),redirect:'manual'});
const api=cookie=>post('/api/shiwen',{method:'browserStatus'},cookie);
const assertStatus=async(response,status)=>{assert.equal(response.status,status,await response.clone().text());return response;};
try{
 const service=await startServer({root,host:'127.0.0.1',port:0});base=service.url.slice(0,-1);
 await assertStatus(await fetch(base,{redirect:'manual'}),303);
 await assertStatus(await api(''),401);
 assert.equal(await new Promise((yes,no)=>{const req=request(base,{headers:{'sec-fetch-site':'cross-site','sec-fetch-mode':'navigate','sec-fetch-dest':'document'}},res=>{res.resume();yes(res.statusCode);});req.on('error',no);req.end();}),303);
 await assertStatus(await fetch(base+'/auth/status',{headers:{'sec-fetch-site':'cross-site','sec-fetch-mode':'navigate','sec-fetch-dest':'document'}}),403);
 const unauth=await(await fetch(base+'/auth/status')).json();assert.equal(unauth.configured,false);assert.equal('devices'in unauth,false);
 await assertStatus(await post('/auth/password',{password}),401);
 const boot=await assertStatus(await fetch(service.loginUrl,{redirect:'manual'}),303);const admin=cookies(boot);assert.equal(boot.headers.get('location'),'/auth/manage');
 await assertStatus(await fetch(service.loginUrl,{redirect:'manual'}),401);
 await assertStatus(await post('/auth/password',{password},admin,'https://evil.invalid'),403);
 const setup=await assertStatus(await post('/auth/password',{password},admin),200);const local=cookies(setup);
 await assertStatus(await api(admin),401);
 await assertStatus(await api(local),200);
 await assertStatus(await post('/auth/login',{password:'wrong'}),401);
 const loginA=await assertStatus(await post('/auth/login',{password,remember:true,name:'Test browser A'}),200);cookieA=cookies(loginA);
 assert.match(loginA.headers.get('set-cookie'),/HttpOnly; SameSite=Strict; Max-Age=2592000/);
 const loginB=await assertStatus(await post('/auth/login',{password,remember:false,name:'Test browser B'}),200);cookieB=cookies(loginB);assert.doesNotMatch(loginB.headers.get('set-cookie'),/Max-Age/);
 await assertStatus(await api(cookieA),200);await assertStatus(await api(cookieB),200);
 await assertStatus(await post('/api/shiwen',{method:'browserStatus'},cookieA,'https://evil.invalid'),403);
 assert.equal(await new Promise((yes,no)=>{const req=request(base+'/auth/status',{headers:{Host:'evil.invalid'}},res=>{res.resume();yes(res.statusCode);});req.on('error',no);req.end();}),403);
 const shared=await(await post('/api/shiwen',{method:'browserLogin'},cookieA)).json();assert.equal(shared.result.loginUrl,base+'/');
 const state=await(await fetch(base+'/auth/status',{headers:{cookie:cookieA}})).json();assert.equal(state.devices.length,3);
 // Test an actual long-lived DSH WebSocket, then revoke its session.
 socket=await new Promise((yes,no)=>{
  const req=request(base+'/api/remote.mux',{headers:{Cookie:cookieB,Origin:base,Connection:'Upgrade',Upgrade:'websocket','Sec-WebSocket-Version':'13','Sec-WebSocket-Key':'dGhlIHNhbXBsZSBub25jZQ=='} });
  req.once('upgrade',(_res,socket)=>yes(socket));req.once('response',res=>no(Error('Upgrade status '+res.statusCode)));req.once('error',no);req.end();
 });socket.on('data',()=>{});socket.on('error',()=>{});
 const closed=new Promise(yes=>socket.once('close',yes));
 const idB=state.devices.find(d=>d.name==='Test browser B').id;
 await assertStatus(await post('/auth/revoke',{id:idB},cookieA),200);
 await Promise.race([closed,new Promise((_,no)=>{const t=setTimeout(()=>no(Error('Revoked socket stayed open')),3000);t.unref();})]);
 await assertStatus(await api(cookieB),401);
 await assertStatus(await post('/auth/password',{password:'Rotated-password-7392',currentPassword:'wrong'},cookieA),401);
 const rotated=await assertStatus(await post('/auth/password',{password:'Rotated-password-7392',currentPassword:password},cookieA),200);cookieA=cookies(rotated);
 await assertStatus(await api(local),401);await assertStatus(await api(cookieA),200);
 await assertStatus(await post('/auth/login',{password}),401);
 const port=new URL(base).port;
 await stopServer(root);await startServer({root,host:'127.0.0.1',port:Number(port)});
 await assertStatus(await api(cookieA),200);
 await assertStatus(await post('/auth/logout',{},cookieA),200);await assertStatus(await api(cookieA),401);
 const log=await readFile(join(root,'server/server.log'),'utf8');assert.equal(log.includes(password),false);assert.equal(log.includes(new URL(service.loginUrl).searchParams.get('token')),false);
 console.log('Password setup, login, CSRF/Host fences, single-use bootstrap, device revocation, WebSocket disconnect, rotation, restart persistence and logout passed.');
 console.log('Isolated verification data:',root);
}finally{socket?.destroy();await stopServer(root);}
