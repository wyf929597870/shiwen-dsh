#!/usr/bin/env node
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {createHash,randomUUID} from 'node:crypto';
import {basename} from 'node:path';
import {createClient,dataRoot} from './client.mjs';
import {definitions} from './contracts.mjs';
const {values,positionals}=parseArgs({allowPositionals:true,options:{root:{type:'string'},'token-file':{type:'string'},input:{type:'string'},purpose:{type:'string'},record:{type:'string'},help:{type:'boolean'}}});
const inputText=async()=>{let body='';for await(const chunk of process.stdin){body+=chunk;if(Buffer.byteLength(body)>8*1024*1024)throw Error('输入过大');}return body;};
async function main(){
 if(values.help||!positionals.length){console.log('Usage: shiwen-bridge [--root DATA_ROOT] [--token-file FILE] tools | call TOOL [--input JSON_FILE] | upload-image FILE [--purpose create|update] [--record ID] | mcp | configure\ncall reads a JSON object from stdin when --input is omitted.\nconfigure reads a token from stdin and writes --token-file (new file only).');return;}
 const [command,name]=positionals;
 if(command==='configure'){
  if(!values['token-file'])throw Error('configure 需要 --token-file');
  const token=(await inputText()).trim();if(!/^sw_[A-Za-z0-9_-]{43}$/.test(token))throw Error('凭据格式无效');
  const path=resolve(values['token-file']);await mkdir(dirname(path),{recursive:true,mode:0o700});await writeFile(path,token+'\n',{mode:0o600,flag:'wx'});console.log('Credential file created.');return;
 }
 const request=createClient({root:values.root?resolve(values.root):dataRoot(),tokenFile:values['token-file']??process.env.SHIWEN_TOKEN_FILE});
 if(command==='upload-image'){
  if(!name)throw Error('请提供图片文件');
  const bytes=await readFile(resolve(name));if(!bytes.length||bytes.length>8*1024*1024)throw Error('图片大小超出限制');
  const uploadId=randomUUID(),purpose=values.purpose??'create',digest=createHash('sha256').update(bytes).digest('hex');
  const begin=(await request('/v1/tools/call',{name:'shiwen_image_begin',arguments:{uploadId,purpose,...(values.record?{recordId:values.record}:{}),name:basename(name),byteLength:bytes.length,digest}})).result;
  for(const part of begin.missingParts){const start=part*begin.partBytes;await request('/v1/tools/call',{name:'shiwen_image_part',arguments:{uploadId,part,dataBase64:bytes.subarray(start,start+begin.partBytes).toString('base64')}});}
  console.log(JSON.stringify((await request('/v1/tools/call',{name:'shiwen_image_status',arguments:{uploadId}})).result,null,2));return;
 }
 if(command==='tools'){console.log(JSON.stringify(await request('/v1/tools'),null,2));return;}
 if(command==='call'){
  if(!name)throw Error('请提供工具名称');
  const args=JSON.parse(values.input?await readFile(resolve(values.input),'utf8'):await inputText());
  console.log(JSON.stringify(await request('/v1/tools/call',{name,arguments:args}),null,2));return;
 }
 if(command!=='mcp')throw Error('未知命令');
 const {tools}=await request('/v1/tools');
 const [{McpServer},{serveStdio}]=await Promise.all([import('@modelcontextprotocol/server'),import('@modelcontextprotocol/server/stdio')]);
 const handle=serveStdio(()=>{
  const server=new McpServer({name:'shiwen',version:'0.1.3'});
  for(const tool of tools){
   const definition=definitions[tool.name];if(!definition)continue;
   server.registerTool(tool.name,{description:tool.description,inputSchema:definition.schema,annotations:tool.annotations},async(args,context)=>{
    try{const {result}=await request('/v1/tools/call',{name:tool.name,arguments:args},{signal:context.signal});return {content:[{type:'text',text:JSON.stringify(result)}],structuredContent:result};}
    catch(error){return {isError:true,content:[{type:'text',text:String(error.message)}]};}
   });
  }
  return server;
 },{onerror:error=>console.error('MCP:',error.message)});
 for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>{handle.close().finally(()=>process.exit(0));});
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
