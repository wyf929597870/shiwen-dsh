import {createHash,createPrivateKey,createPublicKey,generateKeyPairSync,randomBytes} from 'node:crypto';
import {chmodSync,linkSync,mkdirSync,openSync,readFileSync,closeSync,writeFileSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';

// Stored separately from library data: a normal library backup must not clone
// the identity of a trusted service. The caller owns directory selection.
export function loadServiceIdentity(directory){
 mkdirSync(directory,{recursive:true,mode:0o700});
 const file=join(directory,'service-identity.pem');
 try{readFileSync(file);}catch(error){
  if(error.code!=='ENOENT')throw error;
  const {privateKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
  const temporary=join(directory,`.identity-${randomBytes(16).toString('hex')}.tmp`);
  let fd;
  try{
   fd=openSync(temporary,'wx',0o600);
   writeFileSync(fd,privateKey.export({type:'pkcs8',format:'pem'}));
   closeSync(fd);fd=undefined;
   try{linkSync(temporary,file);}catch(failure){if(failure.code!=='EEXIST')throw failure;}
  }finally{if(fd!==undefined)closeSync(fd);try{unlinkSync(temporary);}catch(error){if(error.code!=='ENOENT')throw error;}}
 }
 chmodSync(file,0o600);
 const privateKey=createPrivateKey(readFileSync(file));
 if(privateKey.asymmetricKeyType!=='ec'||privateKey.asymmetricKeyDetails?.namedCurve!=='prime256v1')throw Error('INVALID_SERVICE_IDENTITY');
 const publicKey=createPublicKey(privateKey).export({type:'spki',format:'der'});
 return {privateKey,publicKey,fingerprint:createHash('sha256').update(publicKey).digest('hex')};
}

// Renewing the certificate preserves the pinned service key.
export async function serviceCertificate(identity){
 const {generate}=await import('selfsigned');
 const key=identity.privateKey.export({type:'pkcs8',format:'pem'});
 const publicKey=createPublicKey(identity.privateKey).export({type:'spki',format:'pem'});
 const pem=await generate([{name:'commonName',value:'shiwen-'+identity.fingerprint.slice(0,16)}],{
  keyType:'ec',curve:'P-256',algorithm:'sha256',keyPair:{privateKey:key,publicKey},
  notBeforeDate:new Date(Date.now()-86400000),notAfterDate:new Date(Date.now()+3650*86400000),
  extensions:[{name:'basicConstraints',cA:false},{name:'keyUsage',digitalSignature:true},
   {name:'extKeyUsage',serverAuth:true}]
 });
 return {key,cert:pem.cert};
}
