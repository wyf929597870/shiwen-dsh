import {serverOptions} from './server-config.mjs';
import {controlServer,startServer,stopServer} from './server-control.mjs';
const [command='status',...args]=process.argv.slice(2);
try{
 if(command==='help'||command==='--help')console.log('npm run server:prepare\nnpm run server:start -- [--lan | --host <IP>] [--port 3080] [--root <data directory>]\nnpm run server:status | server:url | server:stop -- [--root <data directory>]');
 else{
  if(!['start','status','url','stop'].includes(command))throw Error('Unknown server command');
  const options=serverOptions(args);
  if(command==='start'){
   const result=await startServer(options,process.env.SHIWEN_SERVICE_RESOURCES?{runtime:process.env.SHIWEN_SERVICE_RESOURCES}:{});
   console.log(`服务已启动 / Server started: ${result.url}\n资料库 / Library: ${result.library}\n运行 npm run server:url 获取登录地址 / Run npm run server:url for the login link.`);
  }else if(command==='stop'){await stopServer(options.root);console.log('服务已停止 / Server stopped');}
  else{
   const result=await controlServer(options.root,command);
   if(!result)throw Error('服务未运行 / Server is not running');
   const {state,...publicStatus}=result;
   console.log(command==='url'?result.loginUrl:JSON.stringify(publicStatus,null,2));
  }
 }
}catch(error){console.error(error.message);process.exitCode=1;}
