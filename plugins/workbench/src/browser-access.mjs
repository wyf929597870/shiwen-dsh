import {isIP} from 'node:net';
// Reuse the running DSH Host, including its authentication and data ownership.
// Never derive a credential-bearing URL from a request header or client input.
export function browserAccess(ctx,{login=false}={}){
 const server=ctx.get('webServer'),profile=ctx.get('profileContext');
 const host=server?.host;
 const local=host==='::1'||/^127(?:\.\d{1,3}){3}$/.test(host??'');
 const ready=!!isIP(host??'')&&!['0.0.0.0','::'].includes(host)&&['http:','https:'].includes(server?.protocol)&&Number.isInteger(server?.port)&&server.port>0;
 const url=ready?`${server.protocol}//${host.includes(':')?`[${host}]`:host}:${server.port}/`:null;
 const passwordAuth=process.env.SHIWEN_SERVER==='1';
 const result={passwordAuth,profile:profile?.name??'default',library:ctx.shiwenLibrary.paths.library,url,
  available:!!ready,local,desktop:profile?.name==='desktop'&&process.env.SHIWEN_SERVER!=='1'};
 if(login){
  if(!ready)throw new Error('当前 Host 未提供浏览器入口 / No browser endpoint is available');
  result.loginUrl=passwordAuth?url:ctx.connection.authenticatedUrl(url);
 }
 return result;
}
