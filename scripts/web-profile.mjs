import {mkdir,writeFile,readFile,symlink,realpath} from 'node:fs/promises';
import {join,resolve} from 'node:path';
export async function setupWebProfile({home,bundle,theme=true,persona=true}){
 const profile=join(resolve(home),'profiles','shiwen-web');
 await mkdir(join(profile,'node_modules'),{recursive:true,mode:0o700});
 const path=join(profile,'package.json');
 let previous;try{previous=JSON.parse(await readFile(path,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
 if(previous&&!previous.dsh?.profile?.bundles?.includes('dsh-shiwen'))throw Error('shiwen-web profile 已存在且不属于拾文；请指定独立 DSH_HOME。');
 const destination=join(profile,'node_modules','dsh-shiwen');
 try{await symlink(resolve(bundle),destination,process.platform==='win32'?'junction':'dir');}catch(error){
  if(error.code!=='EEXIST')throw error;
  if(await realpath(destination)!==await realpath(bundle))throw Error('现有插件路径不同，请保留现有配置或使用独立 DSH_HOME。');
 }
 if(!previous)await writeFile(path,JSON.stringify({name:'dsh-profile-shiwen-web',private:true,dependencies:{'dsh-shiwen':`link:${resolve(bundle)}`},dsh:{profile:{bundles:['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app','dsh-shiwen']}}},null,2)+'\n',{flag:'wx',mode:0o600});
 const patch=[{id:'locale',config:{preference:'zh'}}];
 if(theme)patch.push({id:'shiwen-theme',disabled:false},{id:'ui-brand-official',disabled:true});
 if(persona)patch.push({id:'shiwen-personal-context',disabled:false},{id:'preset-shiwen',disabled:false},{id:'agent-preset-registry',config:{default:'shiwen'}});
 try{await writeFile(join(profile,'cordis.patch.yml'),JSON.stringify(patch,null,2)+'\n',{flag:'wx',mode:0o600});}catch(error){if(error.code!=='EEXIST')throw error;}
 return profile;
}
