import {readFile} from 'node:fs/promises';
import {bootCSS} from './palette.mjs';
export const inject=['webServer'];
export function apply(ctx){
  ctx.on('webserver/index-inject',table=>{
    table.push({kind:'style',text:`body[data-ds-dark-theme]{${bootCSS}}`});
    table.push({kind:'script',placement:'body',text:'document.title="拾文 · Shiwen";'});
  });
  ctx.effect(()=>ctx.webServer.register({kind:'exact',path:'/shiwen-brand.png',async handler(req,res){if(!['GET','HEAD'].includes(req.method)){res.writeHead(405);res.end();return;}const bytes=await readFile(new URL('./shiwen-mark.png',import.meta.url));res.writeHead(200,{'Content-Type':'image/png','Cache-Control':'public,max-age=3600'});res.end(req.method==='HEAD'?undefined:bytes);}}));
}
