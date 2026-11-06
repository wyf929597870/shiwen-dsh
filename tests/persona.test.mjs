import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createStore} from '../plugins/library/legacy/store.mjs';
import {DEFAULT_IDENTITY,DEFAULT_SOUL,PREVIOUS_IDENTITY,PERSONA_MAX_BYTES} from '../plugins/library/src/persona.mjs';
import {personalContext} from '../plugins/personal-context/src/index.mjs';

test('皮皮默认人格进入上下文，完整性格可在设置中保存',t=>{
 const dir=mkdtempSync(join(tmpdir(),'shiwen-persona-')),store=createStore(join(dir,'library.sqlite'));
 t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
 const state=store.agentState();assert.equal(state.identity.body,DEFAULT_IDENTITY);assert.equal(state.soul.body,DEFAULT_SOUL);
 assert.ok(Buffer.byteLength(DEFAULT_SOUL)<PERSONA_MAX_BYTES);
 const saved=store.agentDocumentSave({name:'SOUL.md',revision:0,body:DEFAULT_SOUL});assert.equal(saved.body,DEFAULT_SOUL);
 const context=personalContext(store.agentState());assert.ok(context.includes('皮皮'));assert.ok(context.includes('只用于对话'));assert.ok(context.includes('不扩大工具权限'));
});
test('仅升级旧版默认人格，不覆盖用户自定义设置',t=>{
 const dir=mkdtempSync(join(tmpdir(),'shiwen-persona-upgrade-')),path=join(dir,'library.sqlite');let store=createStore(path);
 t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
 store.agentDocumentSave({name:'IDENTITY.md',revision:0,body:PREVIOUS_IDENTITY});
 store.agentDocumentSave({name:'SOUL.md',revision:0,body:'请使用我自定义的正式风格。'});
 store.close();store=createStore(path);
 let state=store.agentState();assert.equal(state.identity.body,DEFAULT_IDENTITY);assert.equal(state.identity.revision,2);assert.equal(state.soul.body,'请使用我自定义的正式风格。');assert.equal(state.soul.revision,1);
 store.close();store=createStore(path);assert.equal(store.agentState().identity.revision,2);
});
