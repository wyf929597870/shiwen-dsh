import {join,resolve,dirname} from 'node:path';
import {homedir} from 'node:os';
import Schema from '@deepseek-ai/schemastery';
import {createStore} from '../legacy/store.mjs';
import {acquireOwnership} from './ownership.mjs';
export const Config=Schema.object({dataDir:Schema.string().description('资料库目录；留空时使用当前 DSH profile 的拾文目录。')});
export function libraryPaths(ctx,config={},env=process.env){
  const profile=ctx.get?.('profileContext');
  const home=profile?.home??env.DSH_HOME??join(homedir(),'.dsh');
  const library=resolve(config.dataDir||env.SHIWEN_DATA_DIR||join(home,'shiwen',profile?.name??'default','library'));
  return {library,root:dirname(library)};
}
export function apply(ctx,config={}){
  const paths=libraryPaths(ctx,config);
  const release=acquireOwnership(paths.library);
  let store;
  try{store=createStore(join(paths.library,'library.sqlite'));}catch(error){release();throw error;}
  store.paths=paths;
  ctx.effect(()=>()=>{try{store.close();}finally{release();}});
  ctx.provide('shiwenLibrary',store);
}
