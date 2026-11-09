import {readFile,writeFile,rename,unlink,mkdir} from 'node:fs/promises';
import {createServer} from 'node:http';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {createRequire} from 'node:module';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {acquireOwnership} from '../plugins/library/src/ownership.mjs';
import {setupProfile} from './profile.mjs';
import {guardPasswordHost} from '../integration/password-auth.mjs';

// DSH prints its bootstrap credential with --no-open; keep it out of persistent logs.
const log=console.log.bind(console);
console.log=(...args)=>log(...args.map(value=>typeof value==='string'?value.replace(/([?&]token=)[^\s&]+/g,'$1[redacted]'):value));
const options=JSON.parse(process.argv[2]),root=resolve(import.meta.dirname,'..');
const directory=join(options.root,'server'),stateFile=join(directory,'running.json');
let app,control,release,serviceRelease;
const notify=message=>{if(process.connected)process.send(message);};
try{
 await mkdir(directory,{recursive:true,mode:0o700});
 serviceRelease=acquireOwnership(directory);
 // Compatibility with older desktops that predate the ownership lock.
 let endpoint;
 try{endpoint=JSON.parse(await readFile(join(options.root,'external-endpoint.json'),'utf8')).endpoint;}catch(error){if(error.code!=='ENOENT')throw error;}
 if(endpoint){
  const url=new URL(endpoint);
  if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.pathname!=='/'||!url.port)throw Error('Invalid existing external endpoint');
  let active=false;
  try{await fetch(new URL('/v1/tools',url),{signal:AbortSignal.timeout(1500),redirect:'manual'});active=true;}catch(error){if(error.name==='TimeoutError')active=true;}
  if(active)throw Error('桌面端或其他 Host 仍在运行，请先退出程序（关闭窗口可能只是最小化到托盘）。');
 }
 release=acquireOwnership(join(options.root,'library'));
 const runtime=options.runtime??JSON.parse(await readFile(join(root,'.runtime/server/current.json'),'utf8')).runtime;
 const home=join(options.root,'dsh');
 const {appPatch}=await setupProfile({root,home,pluginRoot:join(runtime,'plugins'),relocate:true,writeAppPatch:false});
 process.env.SHIWEN_AUTH_DIRECTORY=directory;
 process.env.SHIWEN_SECURE_PORT=String(options.port>0&&options.port<65535?options.port+1:0);
 process.env.SHIWEN_LAN_DISCOVERY=options.discoverLan===false?'0':(options.discoverLan||!['127.0.0.1','::1'].includes(options.host)?'1':'0');
 process.env.DSH_HOME=home;process.env.SHIWEN_DATA_DIR=join(options.root,'library');process.env.SHIWEN_SERVER='1';
 for(const key of ['ELECTRON_RUN_AS_NODE','SHIWEN_DESKTOP','SHIWEN_APP_PATCH'])delete process.env[key];
 const {runProfile}=await import('@deepseek-ai/dsh/profile-boot');
 const require=createRequire(import.meta.resolve('@deepseek-ai/dsh/package.json'));
 const {loadLayeredEnv}=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-app-boot')).href);
 const {HostConnectionService}=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-client-connection')).href);
 guardPasswordHost(HostConnectionService);
 const args=['--no-open','--host',options.host,'--port',String(options.port)];
 if(options.cert)args.push('--tls-cert',options.cert,'--tls-key',options.key);
 const serverPatch=join(directory,'runtime.patch.json');
 await writeFile(serverPatch,JSON.stringify([{id:'desktop-product-telemetry',disabled:true},{id:'product-analytics',disabled:true},{insert:[{id:'shiwen-password-auth',name:join(root,'integration/password-plugin.mjs')}]}]),{mode:0o600});
 app=await runProfile({environment:loadLayeredEnv('dsh'),profile:'desktop',patchFiles:[appPatch,serverPatch],args});
 const {ctx}=app;
 if(!ctx.get('shiwenLibrary')||!ctx.get('shiwenExternal'))throw Error('Shiwen plugins did not start');
 if(!ctx.get('shiwenPasswordAuth'))throw Error('Password authentication did not start');
 const url=ctx.webServer.getOrigin()+'/';
 const secret=randomBytes(32).toString('hex');
 let stopping=false;
 control=createServer((req,res)=>{
  res.setHeader('Cache-Control','no-store');
  const supplied=Buffer.from(req.headers.authorization??''),expected=Buffer.from('Bearer '+secret);
  if(req.headers.origin||req.headers.host!==`127.0.0.1:${control.address().port}`||supplied.length!==expected.length||!timingSafeEqual(supplied,expected)){res.writeHead(403).end();return;}
  if(req.method!=='POST'){res.writeHead(405).end();return;}
  if(req.url==='/stop'){
   res.end('{}');if(stopping)return;stopping=true;
   setImmediate(async()=>{try{await app.shutdown.shutdown(0);}finally{await unlink(stateFile).catch(()=>{});control.close();release();serviceRelease();process.exit(0);}});
  }else if(req.url==='/status'||req.url==='/url'){
   const auth=ctx.get('shiwenPasswordAuth');
   if(req.url==='/url'&&!auth){res.writeHead(503).end('{}');return;}
   res.setHeader('Content-Type','application/json');
   res.end(JSON.stringify({pid:process.pid,url,secure:auth?.networkInfo(),library:join(options.root,'library'),profile:'desktop',...(req.url==='/url'?{loginUrl:auth.localLoginUrl(url)}:{})}));
  }else res.writeHead(404).end();
 });
 await new Promise((yes,no)=>{control.once('error',no);control.listen(0,'127.0.0.1',yes);});
 const temp=stateFile+'.'+process.pid+'.tmp';
 await writeFile(temp,JSON.stringify({port:control.address().port,secret})+'\n',{mode:0o600});await rename(temp,stateFile);
 await writeFile(join(directory,'last-start.json'),JSON.stringify({host:options.host,port:options.port,...(options.cert?{cert:options.cert,key:options.key}:{})})+'\n',{mode:0o600});
 notify({type:'ready',url,library:join(options.root,'library')});
 if(process.connected)process.disconnect();
}catch(error){
 notify({type:'error',message:error.message});console.error(error);
 try{await app?.shutdown.shutdown(1);}catch{}
 control?.close();release?.();serviceRelease?.();process.exit(1);
}
