import test from 'node:test';
import assert from 'node:assert/strict';
import {mobileReadingNotes} from '../plugins/workbench/src/reading/adapters.mjs';

test('mobile reading list reports batches and reuses only matching revisions',async()=>{
 const rows=Array.from({length:10},(_,i)=>({id:String(i),kind:'reading_note',origin:'personal',revision:1,updatedAt:'one'}));
 const reads=[];const request=async(method,args)=>method==='recordList'?{items:rows}: (reads.push(args.id),{...rows.find(x=>x.id===args.id),markdown:'body',sources:[]});
 const api=mobileReadingNotes(request,'one'),progress=[];
 assert.equal((await api.list({onProgress:p=>progress.push([p.loaded,p.total,p.records.length])})).records.length,10);
 assert.deepEqual(progress,[[0,10,0],[8,10,8],[10,10,10]]);
 await mobileReadingNotes(request,'one').list();assert.equal(reads.length,10);
 rows[0]={...rows[0],revision:2,updatedAt:'two'};await api.list();assert.deepEqual(reads.slice(10),['0']);
 await mobileReadingNotes(request,'other').list();assert.equal(reads.length,21);
});

test('aborting an outstanding batch prevents further batches and progress',async()=>{
 const rows=Array.from({length:12},(_,i)=>({id:String(i),kind:'reading_note',origin:'personal',revision:1}));
 let release;const gate=new Promise(resolve=>{release=resolve;}),reads=[];
 const request=async(method,args)=>{if(method==='recordList')return {items:rows};reads.push(args.id);await gate;return rows.find(x=>x.id===args.id);};
 const api=mobileReadingNotes(request,'one'),controller=new AbortController(),progress=[];
 const pending=api.list({signal:controller.signal,onProgress:p=>progress.push(p.loaded)});
 await new Promise(resolve=>setImmediate(resolve));controller.abort();release();
 await assert.rejects(pending,{name:'AbortError'});assert.equal(reads.length,8);assert.deepEqual(progress,[0]);
});

test('delete uses the same idempotency key and invalidates the cached highlight',async()=>{
 let revision=1,deleted=false,reads=0;const calls=[];
 const request=async(method,args)=>{calls.push({method,args});if(method==='recordList')return {items:deleted?[]:[{id:'x',kind:'reading_note',origin:'external',revision,updatedAt:'one'}]};if(method==='recordRead'){reads++;return {id:'x',kind:'reading_note',origin:'external',revision,updatedAt:'one',markdown:'',sources:[]};}if(method==='recordDelete'){deleted=true;return {record:{id:'x',deleted:true}};}throw Error(method);};
 const api=mobileReadingNotes(request,'one');assert.equal((await api.list()).records.length,1);const action={id:'x',revision:1,requestId:'same'};await api.remove(action);await api.remove(action);
 assert.deepEqual(calls.filter(c=>c.method==='recordDelete').map(c=>c.args),[{libraryId:'one',id:'x',expectedRevision:1,requestId:'same'},{libraryId:'one',id:'x',expectedRevision:1,requestId:'same'}]);assert.equal((await api.list()).records.length,0);assert.equal(reads,1);
});
