import test from 'node:test';
import assert from 'node:assert/strict';
import {readingPageSelection,readingSavedSelection} from '../plugins/workbench/src/reading/navigation.mjs';
const cards=Array.from({length:45},(_,i)=>({id:`record-${i}`,cardId:`card-${i}`}));
test('page navigation selects the first visible card and clamps empty or invalid pages',()=>{
 assert.deepEqual(readingPageSelection(cards,2),{page:2,cardId:'card-20'});
 assert.deepEqual(readingPageSelection(cards,99),{page:3,cardId:'card-40'});
 assert.deepEqual(readingPageSelection([],1),{page:1,cardId:''});
});
test('save locates its visible card and preserves the selected shared excerpt',()=>{
 const shared=[...cards,{id:'old',cardId:'old:0'},{id:'old',cardId:'old:1'}];
 assert.deepEqual(readingSavedSelection(shared,'old','old:1'),{page:3,cardId:'old:1'});
 assert.deepEqual(readingSavedSelection(shared,'old','missing'),{page:3,cardId:'old:0'});
 assert.equal(readingSavedSelection(shared,'filtered-out','filtered-out:0'),null);
});
