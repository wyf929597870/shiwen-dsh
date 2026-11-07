import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,writeFile,rm,unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {stopServer} from '../scripts/server-control.mjs';

test('stop waits for the identity file after a shutdown poll socket reset',async()=>{
 const root=await mkdtemp(join(tmpdir(),'shiwen-stop-test-'));
 let timer,reset=false,stopping=false;
 const server=createServer((req,res)=>{
  if(req.url==='/stop'){stopping=true;res.end('{}');return;}
  if(stopping&&!reset){
   reset=true;req.socket.destroy();
   timer=setTimeout(()=>{unlink(join(root,'server/running.json')).catch(()=>{});},30);
   return;
  }
  res.end('{}');
 });
 try{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  await mkdir(join(root,'server'));
  await writeFile(join(root,'server/running.json'),JSON.stringify({port:server.address().port,secret:'a'.repeat(64)}));
  await stopServer(root);
  assert.equal(reset,true);
 }finally{
  clearTimeout(timer);server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  await rm(root,{recursive:true,force:true});
 }
});
