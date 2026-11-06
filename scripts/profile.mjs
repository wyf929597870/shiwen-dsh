import {mkdir,writeFile,symlink,readlink,realpath,readFile,rename} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
const names=['library','agent-tools','theme','workbench','personal-context','external'];
const persona='你是拾文的个人助理与思考伙伴。身份、性格和交流方式以 shiwen-personal-context 注入的用户设置为准。用户当前明确要求优先于角色口癖。遵守工具权限和资料来源规则。';
async function createOnly(path,content){try{await writeFile(path,content,{flag:'wx',mode:0o600});return true;}catch(error){if(error.code==='EEXIST')return false;throw error;}}
export async function setupProfile({root,home,pluginRoot=join(root,'plugins'),relocate=false,writeAppPatch=true}){
 // Refuse before relocating links or rewriting configuration used by a live server.
 let running;
 try{running=JSON.parse(await readFile(join(dirname(home),'server/running.json'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
 if(running){
  if(!Number.isInteger(running.port)||running.port<1||running.port>65535||!/^\w{64}$/.test(running.secret))throw Error('Invalid service state');
  let response;
  try{response=await fetch(`http://127.0.0.1:${running.port}/status`,{method:'POST',headers:{authorization:'Bearer '+running.secret},redirect:'error',signal:AbortSignal.timeout(1500)});}catch(error){if(error.name==='TimeoutError')throw Error('独立服务状态无法确认，请先停止服务 / Stop the server first');}
  if(response)throw Error('独立服务仍在运行，请先执行 npm run server:stop / Stop the server before launching desktop');
 }
 const profile=join(home,'profiles','desktop'),scope=join(profile,'node_modules','@shiwen');await mkdir(scope,{recursive:true,mode:0o700});
 const manifestPath=join(profile,'package.json');
 let previous;try{previous=JSON.parse(await readFile(manifestPath,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
 const workspaceRoot=join(dirname(home),'workspaces');await mkdir(workspaceRoot,{recursive:true,mode:0o700});
 for(const name of names){
  const source=resolve(pluginRoot,name),destination=join(scope,'dsh-'+name);
  try{await symlink(source,destination,process.platform==='win32'?'junction':'dir');}catch(error){
   if(error.code!=='EEXIST')throw error;
   const target=await readlink(destination).catch(()=>null);
   const registered=previous?.dependencies?.['@shiwen/dsh-'+name];
   let same=false;try{same=await realpath(destination)===await realpath(source);}catch{}
   if(!same){
    if(!relocate||!target||registered!==`file:${resolve(scope,target)}`)throw new Error(`拾文插件位置与现有配置冲突：${destination}`);
    const temp=destination+'.'+process.pid+'.tmp';await symlink(source,temp);await rename(temp,destination);
   }
  }
 }
 const deps=Object.fromEntries(names.map(name=>['@shiwen/dsh-'+name,`file:${resolve(pluginRoot,name)}`]));
 const manifest={name:'dsh-profile-desktop',private:true,dependencies:deps,dsh:{profile:{bundles:['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app']}}};
 if(relocate&&previous){
  const updated={...previous,dependencies:{...previous.dependencies,...deps}};
  const temp=manifestPath+'.'+process.pid+'.tmp';await writeFile(temp,JSON.stringify(updated,null,2)+'\n',{mode:0o600});await rename(temp,manifestPath);
 }else await createOnly(manifestPath,JSON.stringify(manifest,null,2)+'\n');
 const patch=[
  {id:'ui-brand-official',disabled:true},
  {id:'agent-preset-registry',config:{default:'shiwen'}},
  {id:'workspace-controller',config:{documentsDirectory:workspaceRoot}},
  {insert:[
   ...names.map(name=>({id:'shiwen-'+name,name:'@shiwen/dsh-'+name})),
   {id:'preset-shiwen',name:'@deepseek-ai/dsh-agent-preset',config:{id:'shiwen',name:'拾文助手 · 皮皮',description:'胖橘猫伙伴，陪你记录、学习、回顾与创作',order:0,plugins:[
    {id:'persona',name:'@deepseek-ai/dsh-persona',config:{prefix:persona}},
    {id:'compaction',name:'cordis:group',group:true,isolate:{compaction:true,toolResultPruner:true},config:[
     {id:'compaction-basic',name:'@deepseek-ai/dsh-compaction-basic'},
     {id:'command-compact',name:'@deepseek-ai/dsh-command-compact'},
     {id:'tool-result-pruner',name:'@deepseek-ai/dsh-compaction-tool-result-pruner'}
    ]}
   ]}}
  ]}
 ];
 await createOnly(join(profile,'cordis.patch.yml'),JSON.stringify([{id:'ui-theme',config:{preference:'dark'}},{id:'locale',config:{preference:'zh'}}],null,2)+'\n');
 const appPatch=join(home,'shiwen.desktop.patch.yml');if(writeAppPatch)await writeFile(appPatch,JSON.stringify(patch,null,2)+'\n',{mode:0o600});
 else await createOnly(appPatch,JSON.stringify(patch,null,2)+'\n');
 return {profile,appPatch};
}
