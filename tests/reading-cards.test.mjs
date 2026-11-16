import test from 'node:test';
import assert from 'node:assert/strict';
import {readingCards} from '../plugins/workbench/src/reading/cards.mjs';
import {encodeReadingNote} from '../plugins/library/legacy/reading-note.mjs';

test('each highlight produces a card without changing the original record or losing its page',()=>{
 const note={id:'n',title:'书',markdown:'原笔记的想法',revision:2,annotation:encodeReadingNote({excerpts:[{text:'第一条',page:'1'},{text:'第二条',page:'2'}]})};
 const cards=readingCards([note]);
 assert.equal(cards.length,2);
 assert.deepEqual(cards.map(card=>card.excerpt),[{text:'第一条',page:'1'},{text:'第二条',page:'2'}]);
 assert.deepEqual(cards.map(card=>card.cardId),['n:0','n:1']);
 assert(cards.every(card=>card.sharedReflection&&card.markdown===note.markdown&&card.revision===2));
 assert.equal(JSON.parse(note.annotation).excerpts.length,2);
});
test('one highlight has an optional reflection and historic thought-only notes remain accessible',()=>{
 const noThought={id:'a',markdown:'',annotation:encodeReadingNote({excerpts:[{text:'划线',page:''}]})};
 const thoughtOnly={id:'b',markdown:'旧想法',annotation:encodeReadingNote({})};
 const cards=readingCards([noThought,thoughtOnly]);
 assert.equal(cards[0].excerpt.text,'划线');assert.equal(cards[0].sharedReflection,false);assert.equal(cards[0].markdown,'');
 assert.equal(cards[1].excerpt,null);assert.equal(cards[1].markdown,'旧想法');
});
