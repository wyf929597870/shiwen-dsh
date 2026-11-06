import {installPasswordAuth} from './password-auth.mjs';
export const inject=['connection','webServer'];
export function apply(ctx){
 if(!process.env.SHIWEN_AUTH_DIRECTORY)throw Error('Missing standalone authentication directory');
 const auth=installPasswordAuth(ctx,process.env.SHIWEN_AUTH_DIRECTORY);
 ctx.provide('shiwenPasswordAuth',auth);
 ctx.effect(()=>()=>auth.close());
}
