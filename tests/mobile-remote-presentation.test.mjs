import test from 'node:test';
import assert from 'node:assert/strict';
import {mergeSessionEvents,sessionEventPresentation} from '../android/web/remote-session-state.mjs';
test('remote history merges overlap by durable seq without hiding tool records',()=>{
  const a={type:'event',event:{seq:2,type:'user/message',data:{content:[{type:'text',text:'original'}]}}};
  const b={type:'event',event:{seq:3,type:'assistant/message',data:{message:{content:[{type:'text',text:'reply'}]},interrupted:true}}};
  const merged=mergeSessionEvents([a],[a,b]);assert.equal(merged.length,2);
  assert.deepEqual(merged.map(row=>row.event.seq),[2,3]);assert.equal(sessionEventPresentation(b).interrupted,true);
  assert.equal(sessionEventPresentation(a).text,'original');
  assert.equal(sessionEventPresentation({event:{seq:4,type:'tool/result',data:{status:'done'}}}).role,'tool');
});
