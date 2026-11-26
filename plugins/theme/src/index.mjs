import {readFile} from 'node:fs/promises';
import {bootCSS} from './palette.mjs';
export const inject=['webServer'];
export function apply(ctx){
  ctx.on('webserver/index-inject',table=>{
    table.push({kind:'style',text:`body[data-ds-dark-theme]{${bootCSS}}`});
    table.push({kind:'script',placement:'body',text:'document.title="拾文 · Shiwen";'});
  });
  for(const [path,file,mime] of [['/shiwen-brand.png','shiwen-mark.png','image/png'],['/shiwen-night.webp','night-meadow.webp','image/webp']])
    ctx.effect(()=>ctx.webServer.register({kind:'exact',path,async handler(req,res){if(!['GET','HEAD'].includes(req.method)){res.writeHead(405);res.end();return;}const bytes=await readFile(new URL(file,import.meta.url));res.writeHead(200,{'Content-Type':mime,'Cache-Control':'public,max-age=3600'});res.end(req.method==='HEAD'?undefined:bytes);}}));
}
