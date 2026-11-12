import test from 'node:test';
import assert from 'node:assert/strict';
import {conflictTextDiff} from '../android/web/conflict-diff.mjs';

test('conflict summary highlights Chinese changes and keeps short context',()=>{
  const prefix='相同内容'.repeat(80),suffix='结尾内容'.repeat(80);
  const result=conflictTextDiff(prefix+'手机🐱版本'+suffix,prefix+'服务🐶版本'+suffix);
  assert.equal(result.same,false);
  assert.match(result.local.filter(x=>x.changed).map(x=>x.text).join(''),/手机🐱/u);
  assert.match(result.remote.filter(x=>x.changed).map(x=>x.text).join(''),/服务🐶/u);
  assert.ok(result.local.map(x=>x.text).join('').length<160);
  assert.ok(result.remote.map(x=>x.text).join('').length<160);
});
test('identical text and excessive comparisons are explicit',()=>{
  assert.equal(conflictTextDiff('相同','相同').same,true);
  assert.equal(conflictTextDiff('甲'.repeat(100001),'乙').unavailable,true);
  assert.equal(conflictTextDiff('abc','xyz',{maxEditLength:0}).unavailable,true);
});
