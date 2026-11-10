// Isolated preview of production components. Never opens the user's library.
import {createServer} from 'node:http';
import {mkdtemp,readFile,writeFile,copyFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {build} from 'esbuild';
import {randomUUID} from 'node:crypto';
import {createStore} from '../plugins/library/legacy/store.mjs';
const dir=await mkdtemp(join(tmpdir(),'shiwen-reading-preview-')),store=createStore(join(dir,'library.sqlite'));
for(const [book,day,reflection] of [['写作这回事','2026-11-08','关于写作中的“具体”，书里提到要让读者看到、听到、感受到细节，这一点很实用。'],['写作这回事','2026-11-05','读到作者谈写作习惯，认为稳定的写作时间比灵感更重要。这让我重新思考如何安排自己的写作节奏。'],['黑天鹅','2026-11-03','读到不确定性的讨论，提醒自己为未知留下余地。']])store.readingNoteSave({requestId:randomUUID(),book,day,reflection,excerpts:[]});
await build({entryPoints:[resolve('tests/support/reading-notes-preview.jsx')],nodePaths:[resolve('android/node_modules')],bundle:true,format:'esm',outfile:join(dir,'app.js'),jsx:'automatic'});
await copyFile('assets/shiwen-mark.png',join(dir,'logo.png'));
await writeFile(join(dir,'index.html'),'<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>拾文读书笔记 · 独立预览</title><link rel="stylesheet" href="/app.css"><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>');
const server=createServer(async(req,res)=>{try{
 if(req.url==='/rpc'&&req.method==='POST'){
  let body='';for await(const chunk of req){body+=chunk;if(body.length>2_000_000)throw Error('请求过大');}
  const {method,args={}}=JSON.parse(body);let result;
  if(['readingNoteList','readingNoteSave','review','reviewPreview'].includes(method))result=store[method](args);
  else if(method==='readMarkdown'){const row=store.get(args.id);result={...row,markdown:row.body};}
  else throw Error('Unsupported preview action');
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify({result}));return;
 }
 const file=({'/app.js':['app.js','text/javascript'],'/app.css':['app.css','text/css'],'/logo.png':['logo.png','image/png']})[req.url]??['index.html','text/html; charset=utf-8'];res.setHeader('Content-Type',file[1]);res.end(await readFile(join(dir,file[0])));
}catch(e){res.statusCode=400;res.end(JSON.stringify({error:e.message}));}});
server.listen(4179,'127.0.0.1',()=>console.log('Isolated reading-note preview: http://127.0.0.1:4179'));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>server.close(()=>{store.close();process.exit();}));
