import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createStore} from '../plugins/library/legacy/store.mjs';
import {apply} from '../plugins/workbench/src/index.mjs';

test('profile route requires browser authentication and reflects actual stored persona and confirmed memory',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'shiwen-mobile-profile-'));
 const library=createStore(join(directory,'library.sqlite'));
 t.after(()=>{library.close();rmSync(directory,{recursive:true,force:true});});
 const browserPeer={};let admission={rejection:401},handler;
 apply({shiwenLibrary:library,effect:fn=>fn(),connection:{browserPeer,admit:()=>admission,
   fetch:{register:route=>{handler=route.fetch;return ()=>{};}}}});
 const request=(method='mobileAgentProfile',args={})=>new Request('http://localhost/api/shiwen',{method:'POST',headers:{'Content-Type':'application/json'},
   body:JSON.stringify({method,args})});
 assert.equal((await handler(request())).status,401);
 admission={peer:{}};assert.equal((await handler(request())).status,403);
 for(const method of ['agentState','agentDocumentSave','memorySave','memoryDelete','memoryDecide','externalStatus','externalClientCreate','externalClientRevoke']) {
   assert.equal((await handler(request(method))).status,403,method);
 }
 admission={peer:browserPeer};
 const before=await (await handler(request())).json();
 library.agentDocumentSave({name:'SOUL.md',revision:0,body:'请保持直接并用简洁中文交流。'});
 library.memorySave({body:'用户喜欢晨间写作。',category:'user'});
 library.memoryPropose({body:'尚未确认的推断。',evidence:'fixture'});
 const response=await handler(request());assert.equal(response.status,200);
 assert.equal(response.headers.get('cache-control'),'no-store');
 const {result}=await response.json();
 assert.equal(result.agentId,'shiwen');assert.notEqual(result.revision,before.result.revision);
 assert.ok(result.systemContext.includes('请保持直接'));
 assert.ok(result.systemContext.includes('用户喜欢晨间写作'));
 assert.ok(!result.systemContext.includes('尚未确认'));
 assert.ok(!('events' in result));assert.ok(!('policy' in result));
});
