import test from 'node:test';
import assert from 'node:assert/strict';
import {readPending,markPending,clearPending} from '../android/web/management-pending.mjs';
const storage=()=>{const map=new Map();return {map,getItem:key=>map.get(key)??null,setItem:(key,value)=>map.set(key,value),removeItem:key=>map.delete(key)};};

test('an unanswered operation survives component remount and is isolated by node and menu',()=>{
  const store=storage();
  markPending('node-a','schedules',{action:'schedules.create'},store);
  assert.equal(readPending('node-a','schedules',store).action,'schedules.create');
  assert.throws(()=>markPending('node-a','schedules',{action:'schedules.create'},store));
  assert.equal(readPending('node-b','schedules',store),null);
  assert.equal(readPending('node-a','plugins',store),null);
  clearPending('node-a','schedules',store);assert.equal(readPending('node-a','schedules',store),null);
});

test('only non-secret metadata and the install query ID are persisted',()=>{
  const store=storage();
  markPending('node','plugins',{action:'plugins.install',installId:'test-install-1',token:'must-not-save',body:'private-content'},store);
  assert.equal(readPending('node','plugins',store).installId,'test-install-1');
  const text=[...store.map.values()].join('');assert.ok(!text.includes('must-not-save'));assert.ok(!text.includes('private-content'));
});

test('unreadable markers and unavailable storage do not silently allow new writes',()=>{
  const store=storage();markPending('node','external',{action:'externalClientCreate'},store);
  const key=[...store.map.keys()][0];store.setItem(key,'broken-json');
  assert.equal(readPending('node','external',store).action,'unknown');
  const failed={getItem(){throw Error()},setItem(){throw Error()},removeItem(){throw Error()}};
  assert.throws(()=>readPending('node','plugins',failed));
  assert.throws(()=>markPending('node','plugins',{action:'plugins.install'},failed));
  assert.throws(()=>markPending('node','external',{action:'arbitrary'},store));
});
