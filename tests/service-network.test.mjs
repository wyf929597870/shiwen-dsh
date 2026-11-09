import test from 'node:test';
import assert from 'node:assert/strict';
import {request} from 'node:https';
import {X509Certificate,createHash} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {PasswordStore} from '../integration/password-auth.mjs';
import {startServiceNetwork} from '../integration/service-network.mjs';
function fetchPinned(url,certificate,fingerprint,{method='GET',token,body}={}){
 return new Promise((resolve,reject)=>{
  const req=request(url,{method,agent:false,ca:certificate,checkServerIdentity(_host,cert){
   const actual=createHash('sha256').update(new X509Certificate(cert.raw).publicKey.export({type:'spki',format:'der'})).digest('hex');
   if(actual!==fingerprint)return Error('IDENTITY_MISMATCH');
  },headers:{...(token?{authorization:'Bearer '+token}:{}),...(body?{'content-type':'application/json'}:{})}},res=>{
   let text='';res.on('data',chunk=>text+=chunk);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text)}));
  });req.on('error',reject);req.end(body?JSON.stringify(body):undefined);
 });
}
test('pinned TLS, one-use pairing, same auth revocation and endpoint lifecycle',async()=>{
 const directory=mkdtempSync('/tmp/shiwen-network-test-'),store=new PasswordStore(directory);
 let addresses=['127.0.0.2'],network,dispatched=0;
 try{
  network=await startServiceNetwork({directory,store,addresses:()=>addresses,port:0,discovery:false,dispatch(_req,res){dispatched++;res.end(JSON.stringify({ok:true}));}});
  const cert=network.certificate;
  const fp=network.fingerprint,first=network.endpoints().find(x=>x.includes('127.0.0.2'));
  const call=(path,options)=>fetchPinned(new URL(path,first),cert,fp,options);
  assert.equal((await call('/auth/status')).body.authenticated,false);
  const pairing=JSON.parse((await network.pairing()).code);
  const paired=await call('/auth/pair',{method:'POST',body:pairing});assert.equal(paired.status,200);
  const token=paired.body.token;
  assert.equal((await call('/auth/pair',{method:'POST',body:pairing})).status,401);
  assert.equal((await call('/api/shiwen',{method:'POST',token,body:{}})).status,200);
  await assert.rejects(fetchPinned(new URL('/api/shiwen',first),cert,'0'.repeat(64),{method:'POST',token,body:{}}),/IDENTITY_MISMATCH/);
  assert.equal(dispatched,1,'wrong identity receives no RPC');
  assert.equal((await call('/auth/password',{method:'POST',token,body:{}})).status,404);
  addresses=['127.0.0.3'];await network.refresh();
  assert.ok(!network.endpoints().includes(first));
  const next=network.endpoints().find(x=>x.includes('127.0.0.3'));
  assert.equal((await fetchPinned(new URL('/auth/status',next),cert,fp,{token})).body.authenticated,true);
  store.revoke(store.list()[0].id);
  assert.equal((await fetchPinned(new URL('/api/shiwen',next),cert,fp,{method:'POST',token,body:{}})).status,401);
 }finally{network?.close();store.close();rmSync(directory,{recursive:true,force:true});}
});
