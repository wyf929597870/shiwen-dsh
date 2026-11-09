// Real LAN mDNS round trip, temporary identity, no library data.
import {mkdtemp,rm} from 'node:fs/promises';
import {Bonjour} from 'bonjour-service';
import assert from 'node:assert/strict';
import {lanAddresses} from './server-config.mjs';
import {startServiceNetwork} from '../integration/service-network.mjs';
const address=lanAddresses().find(x=>!x.virtual)?.address;
if(!address){console.log('No physical LAN address: discovery round trip not available.');process.exit(0);}
const directory=await mkdtemp('/tmp/shiwen-discovery-');let network,browser,bonjour;
try{
 network=await startServiceNetwork({directory,store:{authenticate(){return null;}},addresses:()=>[address],port:0,dispatch(){}});
 bonjour=new Bonjour({interface:address,bind:'0.0.0.0'});
 const discovered=await new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(Error('LAN_DISCOVERY_TIMEOUT')),12000);
  browser=bonjour.find({type:'shiwen'},service=>{
   if(service.txt?.fp!==network.fingerprint)return;
   clearTimeout(timer);resolve(service);
  });
 });
 assert.ok(discovered.addresses.includes(address));
 assert.deepEqual(discovered.addresses.filter(x=>x!==address),[],'do not advertise other NICs');
 assert.ok(network.endpoints().includes(`https://${address}:${discovered.port}/`));
 console.log('LAN mDNS round trip passed: fingerprint, ready port, and only the selected NIC address.');
}finally{browser?.stop();bonjour?.destroy();network?.close();await rm(directory,{recursive:true,force:true});}
