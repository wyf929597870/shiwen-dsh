// Run with the actual Electron binary. API/cookie process smoke only, no UI automation.
import {app,session} from 'electron';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {authenticateRemote} from '../desktop/connection.mjs';
const directory=await mkdtemp(join(tmpdir(),'shiwen-electron-auth-'));
app.setPath('userData',directory);
void app.whenReady().then(async()=>{
 try{
  const origin=process.env.SHIWEN_AUTH_TEST_URL;
  if(!origin?.startsWith('http://127.0.0.1:'))throw Error('An isolated loopback test service is required');
  const jar=session.fromPartition('persist:password-test');
  const status=()=>jar.fetch(origin+'/api/shiwen',{method:'POST',credentials:'include',headers:{Origin:origin,'Content-Type':'application/json'},body:'{"method":"browserStatus"}'});
  assert.equal((await status()).status,401);
  await assert.rejects(authenticateRemote(jar,origin,{password:'wrong'}),/Incorrect password/);
  await authenticateRemote(jar,origin,{password:'Synthetic-password-4821',remember:true});
  assert.equal((await status()).status,200);
  const cookies=await jar.cookies.get({url:origin});assert.equal(cookies.length,1);assert.equal(cookies[0].httpOnly,true);assert.equal(cookies[0].session,false);
  await jar.cookies.flushStore();
  await jar.fetch(origin+'/auth/logout',{method:'POST',credentials:'include',headers:{Origin:origin,'Content-Type':'application/json'},body:'{}'});
  assert.equal((await status()).status,401);
  await authenticateRemote(jar,origin,{password:'Synthetic-password-4821',remember:false});
  assert.equal((await jar.cookies.get({url:origin}))[0].session,true);
  console.log('Electron session.fetch: password error, login, persistent/session cookies, RPC and logout passed.');app.exit(0);
 }catch(e){console.error(e);app.exit(1);}
});
