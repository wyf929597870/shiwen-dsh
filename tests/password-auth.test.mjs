import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PasswordStore} from '../integration/password-auth.mjs';
const options={audience:'http://127.0.0.1:3080',name:'Test device',remember:true};
const password='temporary-test-password';
function fixture(){const directory=mkdtempSync(join(tmpdir(),'shiwen-password-test-'));let now=Date.now();const store=new PasswordStore(directory,{now:()=>now});return {store,directory,advance:ms=>now+=ms,close(){store.close();rmSync(directory,{recursive:true,force:true});}};}
test('initial password requires local ownership; hashes persist, sessions bind to origin and expire',async()=>{
 const f=fixture(),{store}=f;
 try{
  await assert.rejects(store.change({password}),{status:403});
  await assert.rejects(store.change({password:'short',owner:true}),{status:400});
  await store.change({password,owner:true});assert.equal(await store.verify(password),true);assert.equal(await store.verify('wrong'),false);
  const session=await store.login(password,'client-a',options);
  assert.equal(store.authenticate(session.token,options.audience).id,session.id);
  assert.equal(store.authenticate(session.token,'https://127.0.0.1:3080'),undefined);
  assert.equal(store.authenticate(session.token,'http://127.0.0.1:3081'),undefined);
  assert.equal(store.authenticate(session.token+'a',options.audience),undefined);
  const reload=new PasswordStore(f.directory);assert.equal(await reload.verify(password),true);assert.ok(reload.authenticate(session.token,options.audience));reload.close();
  const raw=Buffer.concat(['access.sqlite','access.sqlite-wal'].map(name=>readFileSync(join(f.directory,name)))).toString();assert.equal(raw.includes(password),false);assert.equal(raw.includes(session.token),false);
  f.advance(31*86400000);assert.equal(store.authenticate(session.token,options.audience),undefined);
 }finally{f.close();}
});
test('password rotation, per-device revocation and short sessions',async()=>{
 const f=fixture(),{store}=f;
 try{
  await store.change({password,owner:true});
  const a=await store.login(password,'a',options),b=await store.login(password,'b',{...options,remember:false});
  store.revoke(a.id);assert.equal(store.authenticate(a.token,options.audience),undefined);assert.ok(store.authenticate(b.token,options.audience));
  await assert.rejects(store.change({password:'new-test-password',currentPassword:'wrong',owner:true}),{status:401});assert.ok(store.valid(b.id));
  await store.change({password:'new-test-password',currentPassword:password});assert.equal(store.valid(b.id),false);assert.equal(await store.verify(password),false);
  const c=await store.login('new-test-password','c',{...options,remember:false});f.advance(13*3600000);assert.equal(store.valid(c.id),false);
 }finally{f.close();}
});
test('repeated incorrect credentials are rate limited',async()=>{
 const f=fixture(),{store}=f;
 try{
  await store.change({password,owner:true});
  for(let n=0;n<8;n++)await assert.rejects(store.login('wrong','bad-client',options),{status:401});
  await assert.rejects(store.login(password,'bad-client',options),{status:429});
  f.advance(601000);assert.ok(await store.login(password,'bad-client',options));
 }finally{f.close();}
});
