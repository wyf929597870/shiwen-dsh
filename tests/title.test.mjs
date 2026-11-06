import {test} from 'node:test';
import assert from 'node:assert/strict';
import {brandedTitle} from '../plugins/theme/src/title.mjs';
test('brand follows native panel, session and locale title changes',()=>{
  for(const product of ['DSH 本地构建','DSH Local Build','DeepSeek Harness']){
    assert.equal(brandedTitle(product),'拾文 · Shiwen');
    assert.equal(brandedTitle(`今天的想法 — ${product}`),'今天的想法 — 拾文 · Shiwen');
  }
});
test('branding is idempotent and preserves user content and unrelated titles',()=>{
  for(const title of ['拾文 · Shiwen','DSH 本地构建怎么安装 — 拾文 · Shiwen','其他插件'])assert.equal(brandedTitle(title),title);
  assert.equal(brandedTitle('DSH Local Build — DSH Local Build'),'DSH Local Build — 拾文 · Shiwen');
});
