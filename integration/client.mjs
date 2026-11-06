import {readFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {homedir} from 'node:os';
export function dataRoot(){return resolve(process.env.SHIWEN_ROOT_DIR??join(process.env.XDG_DATA_HOME??join(homedir(),'.local/share'),'shiwen-dsh'));}
export function createClient({root=dataRoot(),tokenFile=process.env.SHIWEN_TOKEN_FILE,token=process.env.SHIWEN_TOKEN}={}){
 return async(path,body,{signal}={})=>{
  let endpoint,key;
  try{endpoint=JSON.parse(await readFile(join(root,'external-endpoint.json'),'utf8')).endpoint;}catch{throw Error('拾文接口尚未就绪，请先打开拾文；自定义资料目录需设置 SHIWEN_ROOT_DIR。');}
  const url=new URL(endpoint);
  if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||!url.port||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw Error('拾文接口地址无效');
  key=tokenFile?(await readFile(tokenFile,'utf8')).trim():token;
  if(!key)throw Error('请配置 SHIWEN_TOKEN_FILE 或 SHIWEN_TOKEN，凭据在拾文的外部接入页面创建。');
  let response;
  try{response=await fetch(new URL(path,url),{method:body?'POST':'GET',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:signal?AbortSignal.any([signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000),redirect:'error'});}catch(error){if(signal?.aborted)throw error;throw Error('无法连接拾文，请确认应用正在运行；写入重试时保留原 requestId。');}
  const value=await response.json();if(!response.ok)throw Error(value.error??`HTTP ${response.status}`);return value;
 };
}
