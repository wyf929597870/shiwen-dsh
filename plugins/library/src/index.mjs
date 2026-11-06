import {join} from 'node:path';
import {createStore} from '../legacy/store.mjs';
export function apply(ctx){
  const root=process.env.SHIWEN_DATA_DIR;if(!root)throw new Error('SHIWEN_DATA_DIR is required');
  const store=createStore(join(root,'library.sqlite'));
  ctx.effect(()=>()=>store.close());
  ctx.provide('shiwenLibrary',store);
}
