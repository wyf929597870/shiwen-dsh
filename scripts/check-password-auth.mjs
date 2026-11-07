// Isolated real DSH host; no user data or model calls.
import {mkdtemp,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import assert from 'node:assert/strict';
import {request} from 'node:http';
import {startServer,controlServer,stopServer} from './server-control.mjs';
const root=await mkdtemp(join(tmpdir(),'shiwen-password-'));
// Validate the current source build, rather than a potentially stale prepared runtime.
const runtime=resolve(process.argv[2]??join(import.meta.dirname,'..'));
const password='Synthetic-password-4821';
let base,cookieA,cookieB,socket;
const cookies=r=>r.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');
const post=(path,body={},cookie='',origin=base)=>fetch(base+path,{method:'POST',headers:{origin,'content-type':'application/json',cookie},body:JSON.stringify(body),redirect:'manual'});
const api=cookie=>post('/api/shiwen',{method:'browserStatus'},cookie);
const assertStatus=async(response,status)=>{assert.equal(response.status,status,await response.clone().text());return response;};
try{
 const service=await startServer({root,host:'127.0.0.1',port:0},{runtime});base=service.url.slice(0,-1);
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
 // Android's profile RPC uses the same real password-authenticated browser Peer.
 await assertStatus(await post('/api/shiwen',{method:'mobileAgentProfile'}),401);
 const profileBefore=await(await assertStatus(await post('/api/shiwen',{method:'mobileAgentProfile'},cookieA),200)).json();
 assert.equal(profileBefore.result.agentId,'shiwen');assert.match(profileBefore.result.revision,/^[a-f0-9]{64}$/);
 const agentState=await(await assertStatus(await post('/api/shiwen',{method:'agentState'},cookieA),200)).json();
 await assertStatus(await post('/api/shiwen',{method:'agentDocumentSave',args:{name:'SOUL.md',scope:'global',revision:agentState.result.soul.revision,body:'Synthetic mobile profile: concise and careful.'}},cookieA),200);
 const profileAfter=await(await assertStatus(await post('/api/shiwen',{method:'mobileAgentProfile'},cookieB),200)).json();
 assert.notEqual(profileBefore.result.revision,profileAfter.result.revision);
 assert.ok(profileAfter.result.systemContext.includes('Synthetic mobile profile'));
 const memory=await(await assertStatus(await post('/api/shiwen',{method:'memorySave',args:{scope:'global',category:'user',body:'Synthetic mobile preference.'}},cookieA),200)).json();
 await assertStatus(await post('/api/shiwen',{method:'memorySave',args:{id:memory.result.id,revision:memory.result.revision+1,scope:'global',category:'user',body:'Stale revision must not write.'}},cookieA),400);
 const withMemory=await(await assertStatus(await post('/api/shiwen',{method:'mobileAgentProfile'},cookieB),200)).json();
 assert.ok(withMemory.result.memories.some(row=>row.id===memory.result.id));
 await assertStatus(await post('/api/shiwen',{method:'memoryDelete',args:{id:memory.result.id,revision:memory.result.revision}},cookieA),200);
 const withoutMemory=await(await assertStatus(await post('/api/shiwen',{method:'mobileAgentProfile'},cookieB),200)).json();
 assert.ok(!withoutMemory.result.memories.some(row=>row.id===memory.result.id));
 // External-client management must use the same owner session. The one-time
 // secret must never reappear in list/profile responses or service logs.
 for(const method of ['externalStatus','externalClientCreate','externalClientRevoke']){
  await assertStatus(await post('/api/shiwen',{method,args:{name:'Untrusted',scopes:['read']}}),401);
 }
 const externalBefore=await(await assertStatus(await post('/api/shiwen',{method:'externalStatus'},cookieA),200)).json();
 const externalCreated=await(await assertStatus(await post('/api/shiwen',{method:'externalClientCreate',args:{name:'Synthetic Android client',scopes:['read']}},cookieA),200)).json();
 assert.match(externalCreated.result.token,/^sw_/);
 const externalListed=await(await assertStatus(await post('/api/shiwen',{method:'externalStatus'},cookieB),200)).json();
 assert.equal(externalListed.result.clients.length,externalBefore.result.clients.length+1);
 const visibleClient=externalListed.result.clients.find(item=>item.id===externalCreated.result.id);
 assert.equal(visibleClient.name,'Synthetic Android client');assert.deepEqual(visibleClient.scopes,['read']);
 assert.equal('token' in visibleClient,false);assert.equal('token_hash' in visibleClient,false);
 assert.equal(JSON.stringify(externalListed).includes(externalCreated.result.token),false);
 const externalRevoked=await(await assertStatus(await post('/api/shiwen',{method:'externalClientRevoke',args:{id:externalCreated.result.id}},cookieB),200)).json();
 assert.equal(externalRevoked.result.revoked,true);
 const externalAfter=await(await assertStatus(await post('/api/shiwen',{method:'externalStatus'},cookieA),200)).json();
 assert.ok(externalAfter.result.clients.find(item=>item.id===externalCreated.result.id).revoked);
 // Real DSH Host services behind the fixed mobile management adapter. Keep
 // the synthetic task far in the future and never run it or install packages.
 const management=async(action,args={},cookie=cookieA)=>{
  const payload=action.startsWith('schedules.')&&!['schedules.catalog','schedules.deleteInactive'].includes(action)?{request:args}:args;
  const response=await assertStatus(await post('/api/shiwen',{method:'mobileManagement',args:{action,args:payload}},cookie),200);
  const {result}=await response.json();assert.equal(result.action,action);return result.data;
 };
 await assertStatus(await post('/api/shiwen',{method:'mobileManagement',args:{action:'capabilities'}}),401);
 await management('capabilities');
 const bundles=await management('plugins.listBundles');assert.ok(Array.isArray(bundles));
 const plugins=await management('plugins.listPlugins');assert.ok(Array.isArray(plugins));
 const schedulesBefore=await management('schedules.list',{limit:20,offset:0});assert.ok(Array.isArray(schedulesBefore.items));
 await management('schedules.catalog');
 const scheduled=await management('schedules.create',{
  title:'Synthetic Android management test',prompt:'Synthetic test: never execute this task.',
  timing:{kind:'at',at:new Date(Date.now()+365*86400_000).toISOString()}
 });
 assert.ok(scheduled.id);assert.equal(scheduled.status,'active');
 const paused=await management('schedules.edit',{
  id:scheduled.id,action:'update',expectedUpdatedAt:scheduled.updatedAt,patch:{active:false}
 });assert.equal(paused.status,'paused');
 const viewed=await management('schedules.view',{id:scheduled.id},cookieB);assert.equal(viewed.status,'paused');
 const conflict=await management('schedules.edit',{
  id:scheduled.id,action:'update',expectedUpdatedAt:scheduled.updatedAt,patch:{title:'Must not overwrite'}
 });assert.equal(conflict.code,'schedule_conflict');
 const deliveries=await management('schedules.history',{id:scheduled.id,limit:20});assert.deepEqual(deliveries.records,[]);
 const deleted=await management('schedules.edit',{
  id:scheduled.id,action:'delete',expectedUpdatedAt:paused.updatedAt
 });assert.equal(deleted.deleted,true);
 const missing=await management('schedules.view',{id:scheduled.id});assert.equal(missing.code,'schedule_not_found');
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
 await stopServer(root);await startServer({root,host:'127.0.0.1',port:Number(port)},{runtime});
 await assertStatus(await api(cookieA),200);
 await assertStatus(await post('/auth/logout',{},cookieA),200);await assertStatus(await api(cookieA),401);
 const log=await readFile(join(root,'server/server.log'),'utf8');assert.equal(log.includes(password),false);assert.equal(log.includes(new URL(service.loginUrl).searchParams.get('token')),false);assert.equal(log.includes(externalCreated.result.token),false);
 console.log('Password setup, login, profile sync, memory CRUD/revision checks, external client create/list/revoke and secret exclusion, mobile plugin inventory, schedule create/pause/conflict/history/delete, CSRF/Host fences, single-use bootstrap, device revocation, WebSocket disconnect, rotation, restart persistence and logout passed.');
 console.log('Isolated verification data:',root);
}finally{socket?.destroy();await stopServer(root);}
