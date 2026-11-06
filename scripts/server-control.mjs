import {readFile,mkdir,open} from 'node:fs/promises';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export async function readServerState(root){
 let state;
 try{state=JSON.parse(await readFile(join(root,'server/running.json'),'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw error;}
 if(!Number.isInteger(state.port)||state.port<1||state.port>65535||!/^\w{64}$/.test(state.secret))throw Error('Invalid service state');
 return state;
}
export async function controlServer(root,action='status',expected){
 const state=await readServerState(root);
 if(!state)return null;
 if(expected&&state.secret!==expected.secret)throw Error('服务已重新启动，请重新连接后操作 / Service changed; reconnect first');
 let response;
 try{response=await fetch(`http://127.0.0.1:${state.port}/${action}`,{method:'POST',headers:{authorization:'Bearer '+state.secret},signal:AbortSignal.timeout(5000),redirect:'error'});}
 catch(error){if(error.cause?.code==='ECONNREFUSED')return null;throw Error('无法确认本机服务状态，请稍后重试 / Cannot verify local service status',{cause:error});}
 if(!response.ok)throw Error('Service identity could not be verified');
 return {state,...await response.json()};
}
export async function stopServer(root,expected){
 const result=await controlServer(root,'stop',expected);
 if(!result)return;
 for(let n=0;n<100;n++){
  const state=await readServerState(root);
  if(!state||state.secret!==result.state.secret)return;
  if(!await controlServer(root,'status',result.state))return;
  await delay(100);
 }
 throw Error('服务尚未停止，请稍后重试 / Service has not stopped yet');
}
export async function startServer(options,{node=process.execPath,worker=join(import.meta.dirname,'server-worker.mjs'),runtime,env=process.env}={}){
 const directory=join(options.root,'server');await mkdir(directory,{recursive:true,mode:0o700});
 const log=await open(join(directory,'server.log'),'a',0o600);
 let child;
 try{child=spawn(node,[worker,JSON.stringify({...options,...(runtime?{runtime}:{})})],{cwd:options.root,env,detached:true,stdio:['ignore',log.fd,log.fd,'ipc']});}finally{await log.close();}
 await new Promise((yes,no)=>{
  const timer=setTimeout(()=>{child.kill('SIGTERM');no(Error('启动超时，请查看 server/server.log / Startup timed out'));},60000);
  const fail=error=>{clearTimeout(timer);no(error);};
  child.once('error',fail);child.once('exit',()=>fail(Error('服务启动失败，请查看 server/server.log / Startup failed')));
  child.on('message',m=>{if(m.type==='ready'){clearTimeout(timer);yes(m);}if(m.type==='error')fail(Error(m.message));});
 });
 child.unref();
 return controlServer(options.root,'url');
}
export async function ensureServer(options,launch){
 const existing=await controlServer(options.root,'url');
 if(existing)return {...existing,started:false};
 try{return {...await startServer(options,launch),started:true};}
 catch(error){
  // A competing launcher may have won the process lock. Join only a verified owner.
  for(let n=0;n<20;n++){const running=await controlServer(options.root,'url');if(running)return {...running,started:false};await delay(150);}
  throw error;
 }
}
