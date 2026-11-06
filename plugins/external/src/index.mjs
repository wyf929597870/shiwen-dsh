import {resolve,dirname,join} from 'node:path';
import {startExternalServer} from '../../../integration/http-server.mjs';
export const inject=['shiwenLibrary'];
export async function apply(ctx){
 const root=dirname(process.env.SHIWEN_DATA_DIR),appRoot=resolve(import.meta.dirname,'../../..');
 const bridge=await startExternalServer({store:ctx.shiwenLibrary,root,command:join(appRoot,'integration','shiwen-bridge'),skillPath:join(appRoot,'skills','shiwen-library')});
 ctx.effect(()=>()=>bridge.close());ctx.provide('shiwenExternal',bridge);
}
