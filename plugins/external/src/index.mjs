import {resolve,dirname,join} from 'node:path';
import {startExternalServer} from '../../../integration/http-server.mjs';
export const inject=['shiwenLibrary'];
export async function apply(ctx){
 const root=ctx.shiwenLibrary.paths?.root??dirname(process.env.SHIWEN_DATA_DIR),appRoot=resolve(import.meta.dirname,'../../..');
 // The desktop wrapper selects its bundled Node; stock DSH already runs on Node.
 const desktop=process.env.SHIWEN_DESKTOP==='1';
 const bridge=await startExternalServer({store:ctx.shiwenLibrary,root,command:desktop?join(appRoot,'integration','shiwen-bridge'):process.execPath,args:desktop?[]:[join(appRoot,'integration','cli.mjs')],skillPath:join(appRoot,'skills','shiwen-library')});
 ctx.effect(()=>()=>bridge.close());ctx.provide('shiwenExternal',bridge);
}
