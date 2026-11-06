import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createStore} from '../plugins/library/legacy/store.mjs';
import {apply} from '../plugins/agent-tools/src/index.mjs';

test('工具从当前 DSH 会话取原文、记录出处，拒绝虚构和未完成的来源',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'shiwen-dsh-tool-'));const library=createStore(join(dir,'library.sqlite'));t.after(()=>{library.close();rmSync(dir,{recursive:true,force:true});});
 const events=[{type:'user/message',data:{id:'user-1',source:{kind:'user'},content:[{type:'text',text:'用户真实原话'}]}},{type:'user/message',data:{id:'injected-1',source:{kind:'system-prompt'},content:[{type:'text',text:'注入内容'}]}},{type:'assistant/message',data:{interrupted:true,message:{id:'partial-1',content:[{type:'text',text:'半截回复'}]}}}];
 const tools=new Map(),ctx={shiwenLibrary:library,sessionQuery:{observeSession:async()=>({events,[Symbol.dispose]() {}})},systemPrompt:{section:()=>()=>{}},tools:{register:tool=>{tools.set(tool.name,tool);return()=>tools.delete(tool.name);}},effect:fn=>fn()};
 apply(ctx);const exec={agent:{session:{id:'session-1'}},signal:new AbortController().signal,callId:'call-1'};
 const recent=await tools.get('shiwen_recent_messages').execute({},exec);assert.deepEqual(recent.map(m=>m.id),['user-1']);
 const args={kind:'journal',mode:'original',sourceMessageId:'user-1',body:'不能使用模型伪造的文字',day:'2026-11-04'};
 const saved=await tools.get('shiwen_save').execute(args,exec);assert.equal(library.get(saved.id).body,'用户真实原话');assert.equal(saved.date,'2026-11-04');assert.equal((await tools.get('shiwen_save').execute(args,exec)).id,saved.id);
 await assert.rejects(()=>tools.get('shiwen_save').execute({...args,sourceMessageId:'partial-1'},{...exec,callId:'other'}),/来源/);
 await assert.rejects(()=>tools.get('shiwen_save').execute({...args,sourceMessageId:'injected-1'},{...exec,callId:'other'}),/来源/);
 const article=await tools.get('shiwen_save').execute({kind:'article',mode:'organized',sourceMessageId:'user-1',title:'文章测试',body:'文章草稿正文'},{...exec,callId:'article-1'});assert.equal(library.get(article.id).stage,'draft');assert.equal(article.origin,'ai');
 const stopped=new AbortController();stopped.abort();await assert.rejects(()=>tools.get('shiwen_save').execute(args,{...exec,callId:'cancelled',signal:stopped.signal}));assert.equal(library.snapshot().records.length,2);
});

test('候选记忆必须引用当前用户消息，确认前不进入上下文',async t=>{
 const {personalContext}=await import('../plugins/personal-context/src/index.mjs');
 const dir=mkdtempSync(join(tmpdir(),'shiwen-dsh-memory-'));const library=createStore(join(dir,'library.sqlite'));t.after(()=>{library.close();rmSync(dir,{recursive:true,force:true});});
 const events=[{type:'user/message',data:{id:'u',source:{kind:'user'},content:[{type:'text',text:'请记住我喜欢简洁的回复'}]}}],tools=new Map();
 const ctx={shiwenLibrary:library,sessionQuery:{observeSession:async()=>({events,[Symbol.dispose]() {}})},systemPrompt:{section:()=>()=>{}},tools:{register:tool=>{tools.set(tool.name,tool);return()=>tools.delete(tool.name);}},effect:fn=>fn()};apply(ctx);
 const exec={agent:{session:{id:'s'}},signal:new AbortController().signal,callId:'c'};
 await assert.rejects(()=>tools.get('shiwen_propose_memory').execute({body:'虚构的偏好',evidence:'不在原话里'},exec),/原文/);
 const proposed=await tools.get('shiwen_propose_memory').execute({body:'喜欢简洁的回复',evidence:'喜欢简洁的回复'},exec);assert.equal(proposed.status,'pending');assert.ok(!personalContext(library.agentState()).includes('已确认记忆：喜欢简洁的回复'));
 const memory=library.agentState().memories.find(m=>m.id===proposed.id);library.memoryDecide({id:memory.id,revision:memory.revision,accept:true});assert.ok(personalContext(library.agentState()).includes('已确认记忆：喜欢简洁的回复'));
 const confirmed=library.agentState().memories.find(m=>m.id===proposed.id);library.memoryDelete({id:confirmed.id,revision:confirmed.revision});assert.ok(!personalContext(library.agentState()).includes('已确认记忆：喜欢简洁的回复'));
});
