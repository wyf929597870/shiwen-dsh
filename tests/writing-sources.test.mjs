import test from 'node:test';
import assert from 'node:assert/strict';
import {encodeReadingNote} from '../plugins/library/legacy/reading-note.mjs';
import MarkdownIt from 'markdown-it';
import {readingSourceCards,sourceCitation,insertSourceQuote,matchesSource,materialTypes} from '../plugins/workbench/src/writing-source-helpers.mjs';

test('projects old excerpts separately while retaining shared reflection and real provenance',()=>{
 const cards=readingSourceCards([{id:'n1',title:'一本书',markdown:'我的感想',annotation:encodeReadingNote({chapter:'第二章',page:'12',excerpts:[{text:'原文一',page:''},{text:'原文二',page:'15'}]})}]);
 assert.equal(cards.length,2);assert.equal(cards[0].markdown,'我的感想');assert.equal(cards[0].excerpt.text,'原文一');assert.equal(cards[1].sharedReflection,true);
 assert.equal(sourceCitation(cards[0]),'《一本书》 · 第二章 · 页码 12');assert.equal(sourceCitation(cards[1]),'《一本书》 · 第二章 · 页码 15');
 const noPage=readingSourceCards([{id:'n2',title:'无页码',markdown:'感想',annotation:encodeReadingNote({excerpts:[{text:'原文'}]})}])[0];assert.equal(sourceCitation(noPage),'《无页码》');
});
test('quote is a snapshot inserted at saved cursor and links record once',()=>{
 const first=insertSourceQuote('前文后文',2,[],{id:'n1',citation:'《书》 · 第一章'},'所选原文');
 assert.equal(first.body,'前文\n\n> 所选原文\n>\n> — 《书》 · 第一章\n\n后文');assert.deepEqual(first.sources,['n1']);assert.equal(first.body.slice(first.cursor),'后文');
 const next=insertSourceQuote(first.body,first.cursor,first.sources,{id:'n1',citation:'《书》'},'另一段');assert.deepEqual(next.sources,['n1']);assert.match(next.body,/> 所选原文/);
});

test('search targets each old excerpt and duplicate records do not duplicate cards',()=>{
 const row={id:'old',title:'书',markdown:'共同感想',annotation:encodeReadingNote({excerpts:[{text:'苹果'},{text:'香蕉'}]})};
 const cards=readingSourceCards([row,row]);
 assert.deepEqual(cards.filter(card=>matchesSource(card,'香蕉')).map(card=>card.excerpt.text),['香蕉']);
 assert.equal(cards.filter(card=>matchesSource(card,'共同感想')).length,2);
});
test('reflection-only attribution and hostile citation remain inside a safe quote',()=>{
 const card=readingSourceCards([{id:'thought',title:'书',markdown:'自己的想法',annotation:encodeReadingNote({})}])[0];
 assert.equal(sourceCitation(card),'个人感想 · 《书》');
 const source={id:'thought',citation:'个人感想 · 《书》\n# 标题 [link](https://example.test) <script>alert(1)</script>'};
 const result=insertSourceQuote('',0,[],source,'自己的想法');
 const html=new MarkdownIt({html:false}).render(result.body);
 assert.equal((html.match(/<blockquote>/g)||[]).length,1);
 assert.doesNotMatch(html,/<h1>|<a |<script>/);
 assert.match(html,/个人感想/);assert.deepEqual(result.sources,['thought']);
});

test('type options exclude empty and duplicate kinds',()=>{
 assert.deepEqual(materialTypes([{kind:''},{},{kind:null},{kind:'  '},{kind:'reading_note'},{kind:'idea'},{kind:'idea'}]),['idea']);
});
