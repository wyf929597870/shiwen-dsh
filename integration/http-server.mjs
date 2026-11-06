import {createServer} from 'node:http';
import {mkdir,writeFile,rename,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
export async function startExternalServer({store,root,command,skillPath}){
 const file=join(root,'external-endpoint.json'),instance=randomUUID();
 let endpoint;
 const server=createServer(async(req,res)=>{
  const respond=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value));};
  try{
   if(req.headers.origin||req.headers.host!==new URL(endpoint).host){respond(403,{error:'仅允许本机客户端调用'});return;}
   const authorization=req.headers.authorization??'';
   const client=store.externalAuthenticate(authorization.startsWith('Bearer ')?authorization.slice(7):'');
   if(req.method==='GET'&&req.url==='/v1/tools'){respond(200,{tools:store.externalCatalog(client)});return;}
   if(req.method!=='POST'||req.url!=='/v1/tools/call'){respond(404,{error:'接口不存在'});return;}
   if(!req.headers['content-type']?.startsWith('application/json')){respond(415,{error:'请使用 application/json'});return;}
   let size=0;const chunks=[];
   for await(const chunk of req){size+=chunk.length;if(size>8*1024*1024){respond(413,{error:'请求过大'});return;}chunks.push(chunk);}
   const input=JSON.parse(Buffer.concat(chunks).toString('utf8'));
   if(!input||typeof input.name!=='string'||Object.keys(input).some(key=>!['name','arguments'].includes(key)))throw Error('请求格式无效');
   const result=store.externalCall(client,input.name,input.arguments??{});
   respond(200,{result});
  }catch(error){if(!res.headersSent)respond(error.status??400,{error:error.name==='ZodError'?'参数不符合工具定义':String(error.message)});}
 });
 server.requestTimeout=15000;server.headersTimeout=10000;
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 endpoint=`http://127.0.0.1:${server.address().port}`;
 const close=async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));try{if(JSON.parse(await readFile(file,'utf8')).instance===instance)await rm(file,{force:true});}catch(error){if(error.code!=='ENOENT')throw error;}};
 try{
  await mkdir(root,{recursive:true,mode:0o700});
  const temp=file+'.'+instance;await writeFile(temp,JSON.stringify({version:1,endpoint,instance})+'\n',{mode:0o600});await rename(temp,file);
 }catch(error){await close();throw error;}
 return {status:()=>({running:server.listening,endpoint,discoveryFile:file,command,skillPath,root}),close};
}
