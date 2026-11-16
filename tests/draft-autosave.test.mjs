import test from 'node:test';
import assert from 'node:assert/strict';
import {createDraftAutosave} from '../plugins/workbench/src/draft-autosave.mjs';

test('typing resets the idle period and writes only the latest draft',t=>{
 t.mock.timers.enable({apis:['setTimeout']});const writes=[];
 const save=createDraftAutosave(value=>writes.push(value));
 for(let i=0;i<20;i++){save.schedule({body:'字'.repeat(i+1)});t.mock.timers.tick(200);}
 assert.deepEqual(writes,[]);t.mock.timers.tick(799);assert.deepEqual(writes,[]);
 t.mock.timers.tick(1);assert.deepEqual(writes,[{body:'字'.repeat(20)}]);
});
test('leaving flushes synchronously once; explicit clears prevent stale resurrection',t=>{
 t.mock.timers.enable({apis:['setTimeout']});const writes=[];
 const save=createDraftAutosave(value=>writes.push(value));
 save.schedule('last character');save.flush();assert.deepEqual(writes,['last character']);
 save.flush();t.mock.timers.tick(1000);assert.equal(writes.length,1);
 save.schedule('discarded');save.cancel();t.mock.timers.tick(1000);assert.equal(writes.length,1);
});
test('storage and sync failures are reported without throwing from a timer',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const errors=[];
 const local=createDraftAutosave(()=>{throw Error('quota');},{onError:e=>errors.push(e.message)});
 local.schedule('a');t.mock.timers.tick(1000);
 const remote=createDraftAutosave(()=>Promise.reject(Error('offline')),{onError:e=>errors.push(e.message)});
 remote.schedule('b');remote.flush();await Promise.resolve();assert.deepEqual(errors,['quota','offline']);
});
