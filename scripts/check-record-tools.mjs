// Exercise the packaged plugins with synthetic data, without a model request.
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const root=resolve(process.argv[2]??'release/linux-unpacked/resources/shiwen');
const directory=await mkdtemp(join(tmpdir(),'shiwen-packaged-tools-'));
process.env.SHIWEN_DATA_DIR=directory;
const cleanup=[],tools=new Map();let library;
const events=[{type:'user/message',data:{id:'user-1',source:{kind:'user'},content:[{type:'text',text:'今天散步很开心。帮我记日记，再收藏网络文章。'}]}}];
const ctx={effect:fn=>{const dispose=fn();if(typeof dispose==='function')cleanup.push(dispose);},provide:(key,value)=>{ctx[key]=value;if(key==='shiwenLibrary')library=value;},tools:{register:tool=>{tools.set(tool.name,tool);return()=>tools.delete(tool.name);}},systemPrompt:{section:()=>()=>{}},sessionQuery:{observeSession:async()=>({events,[Symbol.dispose](){}})}};
try{
 (await import(pathToFileURL(join(root,'plugins/library/lib/index.js')))).apply(ctx);
 (await import(pathToFileURL(join(root,'plugins/agent-tools/lib/index.js')))).apply(ctx);
 assert.equal(tools.size,10);
 let sequence=0;const invoke=(name,args)=>tools.get(name).execute(args,{agent:{session:{id:'isolated'}},callId:String(++sequence),signal:new AbortController().signal});
 const created=await invoke('shiwen_save',{kind:'idea',mode:'original',sourceMessageId:'user-1'});assert.equal(created.origin,'personal');
 const before=await invoke('shiwen_read',{id:created.id});
 const updated=await invoke('shiwen_update',{id:created.id,revision:before.revision,kind:'journal',origin:'personal',title:'散步日记',day:'2026-10-12'});
 assert.equal(updated.kind,'journal');assert.equal(updated.day,'2026-10-12');
 await assert.rejects(()=>invoke('shiwen_update',{id:created.id,revision:before.revision,title:'stale'}),/更新/);
 const web=await invoke('shiwen_collect',{requestMessageId:'user-1',title:'示例文章',url:'https://example.org/article',body:'# 示例\n外部原文'});
 assert.equal(web.origin,'external');assert.equal(web.kind,'web');
 const corrected=await invoke('shiwen_update',{id:web.id,revision:web.revision,origin:'personal'});assert.equal(corrected.origin,'personal');
 assert.equal(library.review().totals.added,0);
 const deleted=await invoke('shiwen_delete',{id:created.id,revision:updated.revision});
 await assert.rejects(()=>invoke('shiwen_read',{id:created.id}),/不存在/);
 await invoke('shiwen_restore',{id:deleted.id,revision:deleted.revision});
 assert.equal((await invoke('shiwen_read',{id:created.id})).title,'散步日记');
 console.log('Packaged plugins: 10 tools loaded; update, provenance, collection, conflict and delete/restore passed.');
}finally{for(const dispose of cleanup.reverse())dispose();await rm(directory,{recursive:true,force:true});}
