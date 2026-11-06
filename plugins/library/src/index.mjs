import {join,resolve,dirname} from 'node:path';
import {homedir} from 'node:os';
import Schema from '@deepseek-ai/schemastery';
import {createStore} from '../legacy/store.mjs';
export const Config=Schema.object({dataDir:Schema.string().description('资料库目录；留空时使用当前 DSH profile 的拾文目录。')});
export function libraryPaths(ctx,config={},env=process.env){
  const profile=ctx.get?.('profileContext');
  const home=profile?.home??env.DSH_HOME??join(homedir(),'.dsh');
  const library=resolve(config.dataDir||env.SHIWEN_DATA_DIR||join(home,'shiwen',profile?.name??'default','library'));
  return {library,root:dirname(library)};
}
export function apply(ctx,config={}){
  const paths=libraryPaths(ctx,config);
  const store=createStore(join(paths.library,'library.sqlite'));
  store.paths=paths;
  ctx.effect(()=>()=>store.close());
  ctx.provide('shiwenLibrary',store);
}
