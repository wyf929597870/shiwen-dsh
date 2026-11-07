// Read/control integration against a temporary real Host. Never sends a prompt or uses a personal library.
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {startServer,stopServer} from './server-control.mjs';
const root=await mkdtemp(join(tmpdir(),'shiwen-sessions-host-'));let service;
try{
  service=await startServer({root,host:'127.0.0.1',port:0},{runtime:resolve(import.meta.dirname,'..')});
  const initial=await fetch(service.loginUrl,{redirect:'manual'});
  assert.equal(initial.status,303);const cookie=initial.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');
  const call=async(action,args={},authenticated=true)=>{
    const response=await fetch(new URL('/api/shiwen',service.url),{method:'POST',headers:{'Content-Type':'application/json',...(authenticated?{cookie}:{}),origin:new URL(service.url).origin},body:JSON.stringify({method:'mobileSessions',args:{action,args}})});
    const body=await response.text();let result;try{result=JSON.parse(body);}catch{result={error:body};}return {status:response.status,result};
  };
  assert.equal((await call('list',{},false)).status,401);
  for(const action of ['capabilities','list','catalog','models']){
    const response=await call(action);assert.equal(response.status,200,`${action}: ${JSON.stringify(response.result)}`);assert.equal(response.result.result.action,action);
  }
  const args={requestId:randomUUID(),sessionId:randomUUID()};
  const first=await call('create',args);assert.equal(first.status,200);assert.equal(first.result.result.data.status,'accepted',JSON.stringify(first.result));
  const second=await call('create',args);assert.deepEqual(second.result,first.result);
  const sessionId=first.result.result.data.sessionId;
  for(const action of ['state','events']){
    const response=await call(action,{sessionId});assert.equal(response.status,200,`${action}: ${JSON.stringify(response.result)}`);
    if(action==='state')assert.ok(response.result.result.data.interactions?.clientId,'real Host interaction carrier should be ready');
  }
  const mismatch=await call('create',{...args,agentPreset:'different'});assert.equal(mismatch.result.code,'REQUEST_ID_REUSED');
  console.log('Real isolated DSH Host sessions passed: owner authentication, catalog, models, create receipt, history/state, interaction carrier. No prompt or model generation was invoked.');
}finally{try{if(service)await stopServer(root);}finally{await rm(root,{recursive:true,force:true});}}
