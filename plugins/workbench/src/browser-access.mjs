// Reuse the running DSH Host, including its authentication and data ownership.
// Never derive a credential-bearing URL from a request header or client input.
export function browserAccess(ctx,{login=false}={}){
 const server=ctx.get('webServer'),profile=ctx.get('profileContext');
 const host=server?.host;
 const local=host==='::1'||/^127(?:\.\d{1,3}){3}$/.test(host??'');
 const ready=local&&Number.isInteger(server?.port)&&server.port>0;
 const url=ready?`${server.protocol}//${host==='::1'?'[::1]':host}:${server.port}/`:null;
 const result={profile:profile?.name??'default',library:ctx.shiwenLibrary.paths.library,url,
  available:!!ready,desktop:profile?.name==='desktop'};
 if(login){
  if(!ready)throw new Error('当前 Host 未提供本机浏览器入口 / No local browser endpoint is available');
  result.loginUrl=ctx.connection.authenticatedUrl(url);
 }
 return result;
}
