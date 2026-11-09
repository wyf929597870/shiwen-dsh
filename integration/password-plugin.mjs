import {installPasswordAuth} from './password-auth.mjs';
export const inject=['connection','webServer'];
export async function apply(ctx){
 if(!process.env.SHIWEN_AUTH_DIRECTORY)throw Error('Missing standalone authentication directory');
 const auth=installPasswordAuth(ctx,process.env.SHIWEN_AUTH_DIRECTORY);
 ctx.provide('shiwenPasswordAuth',auth);
 ctx.effect(()=>()=>auth.close());
 await auth.startNetwork({includeAddress:ctx.webServer.host,port:Number(process.env.SHIWEN_SECURE_PORT??3081),...(process.env.SHIWEN_LAN_DISCOVERY==='1'?{}:{addresses:()=>[],discovery:false})});
}
