import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,statSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {sign,verify} from 'node:crypto';
import {loadServiceIdentity} from '../integration/service-identity.mjs';

test('服务身份跨重启保持，独立服务身份不同，私钥可证明公钥所有权',()=>{
 const a=mkdtempSync(join(tmpdir(),'shiwen-identity-')),b=mkdtempSync(join(tmpdir(),'shiwen-identity-'));
 try{
  const one=loadServiceIdentity(a),again=loadServiceIdentity(a),other=loadServiceIdentity(b);
  assert.equal(one.fingerprint,again.fingerprint);assert.notEqual(one.fingerprint,other.fingerprint);
  assert.equal(statSync(join(a,'service-identity.pem')).mode & 0o777,0o600);
  const challenge=Buffer.from('independent-test-challenge');const signature=sign('sha256',challenge,one.privateKey);
  assert.equal(verify('sha256',challenge,{key:one.publicKey,type:'spki',format:'der'},signature),true);
  assert.equal(verify('sha256',challenge,{key:other.publicKey,type:'spki',format:'der'},signature),false);
 }finally{rmSync(a,{recursive:true,force:true});rmSync(b,{recursive:true,force:true});}
});
test('损坏的服务身份不能静默替换',()=>{
 const root=mkdtempSync(join(tmpdir(),'shiwen-identity-'));
 try{writeFileSync(join(root,'service-identity.pem'),'invalid');assert.throws(()=>loadServiceIdentity(root));assert.equal(requireValue(root),'invalid');}
 finally{rmSync(root,{recursive:true,force:true});}
});
function requireValue(root){return readFileSync(join(root,'service-identity.pem'),'utf8');}
import {readFileSync} from 'node:fs';
