// Production UI with disposable acceptance data; never opens a personal library.
import {createServer} from 'node:http';
import {mkdtemp,readFile,writeFile,copyFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {context} from 'esbuild';
import {randomUUID} from 'node:crypto';
import {createStore} from '../plugins/library/legacy/store.mjs';
const dir=await mkdtemp(join(tmpdir(),'shiwen-reading-workspace-'));
const store=createStore(join(dir,'acceptance.sqlite'));
const passages=[
 ['第一步：分辨知性与感性、文学与非文学','文学语言叙事、描写成分多，其词性的使用富于弹性，表达情感的形容词使用频繁；而非文学性作品则是议论或说明成分多，力求客观呈现，主观的形容词很少。',''],
 ['从根本上治疗“语言癌”：多读与多思','语言简单短促可以沟通即可；文字则需要详细且有逻辑。','写作之前，先想清楚自己要表达什么。说话可以借助情境，文字却需要把逻辑交代完整。'],
 ['从根本上治疗“语言癌”：多读与多思','语言必须搭配环境背景，才能真正显现它所要表达的意思。',''],
 ['从根本上治疗“语言癌”：多读与多思','不论是语文教育或是文学教育，首要培养的是学生思辨能力。',''],
 ['从根本上治疗“语言癌”：多读与多思','在听、说、读、写的背后，其实还有着看不见却十分重要的思辨能力。思辨的面向、深浅，一定程度上会反映在你的表达能力及理解能力上。','']
];
for(const [chapter,text,reflection] of passages)store.readingNoteSave({requestId:randomUUID(),book:'从零开始学写作',day:'2022-06-13',chapter,reflection,excerpts:[{text,page:''}]});
for(let i=1;i<=22;i++)store.readingNoteSave({requestId:randomUUID(),book:'从零开始学写作',day:`2022-06-${String(13+Math.floor(i/3)).padStart(2,'0')}`,chapter:i<12?'写作之前：认清写作的目的':'写作的材料与观察',reflection:i===22?'分页末尾的感想，便于检查前后切换与返回位置。':'',excerpts:[{text:`练习 ${i}：把观察写下来，再选择最能说明问题的细节。${i===21?'这是一段用于检查长内容换行与阅读滚动的验收文字。'.repeat(30):''}`,page:String(30+i)}]});
store.readingNoteSave({requestId:randomUUID(),book:'另一本书：长书名与跨书搜索验收',day:'2026-11-14',chapter:'一个很长的章节名称，用于检查窄屏下的完整换行和布局是否稳定',reflection:'跨书搜索专用感想。',excerpts:[{text:'跨书搜索也应保留清楚的出处。',page:'9'}]});
const bundle=await context({entryPoints:[resolve('tests/support/reading-workspace-preview.jsx')],nodePaths:[resolve('android/node_modules')],bundle:true,format:'esm',outfile:join(dir,'app.js'),jsx:'automatic'});
await bundle.watch();
await copyFile('assets/shiwen-mark.png',join(dir,'logo.png'));
await writeFile(join(dir,'index.html'),'<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>拾文阅读与素材 · 隔离验收</title><link rel="stylesheet" href="/app.css"><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>');
const server=createServer(async(req,res)=>{try{
 const url=new URL(req.url,'http://127.0.0.1');
 if(url.pathname==='/rpc'&&req.method==='POST'){
  let body='';for await(const chunk of req){body+=chunk;if(body.length>2_000_000)throw Error('请求过大');}
  const {method,args={}}=JSON.parse(body);let result;
  if(['readingNoteList','readingNoteSave','remove'].includes(method))result=store[method](args);
  else if(method==='readMarkdown'){const row=store.get(args.id);if(!row)throw Error('记录不存在');result={...row,markdown:row.body};}
  else throw Error('Unsupported acceptance action');
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify({result}));return;
 }
 const file=({'/app.js':['app.js','text/javascript'],'/app.css':['app.css','text/css'],'/logo.png':['logo.png','image/png']})[url.pathname]??['index.html','text/html; charset=utf-8'];
 res.setHeader('Content-Type',file[1]);res.setHeader('Cache-Control','no-store');res.end(await readFile(join(dir,file[0])));
}catch(e){res.statusCode=400;res.end(JSON.stringify({error:e.message}));}});
server.listen(4183,'127.0.0.1',()=>console.log('Isolated acceptance preview: http://127.0.0.1:4183'));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>server.close(async()=>{await bundle.dispose();store.close();process.exit();}));
