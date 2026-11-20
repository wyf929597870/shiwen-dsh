import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {splitText} from '../plugins/library/src/search/chunk.mjs';
import {createSearchIndex,searchExact} from '../plugins/library/src/search/index.mjs';
import {createStore} from '../plugins/library/legacy/store.mjs';
import {plainDoc} from '../plugins/library/legacy/content.mjs';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';

const countTokens=async text=>Array.from(text).length*4+2;
const doc=text=>({type:'doc',content:[{type:'paragraph',content:[{type:'text',text}]}]});
const embed=async texts=>texts.map(text=>text.includes('开始')||text.includes('行动')?[1,0]:[0,1]);
const delay=()=>new Promise(resolve=>setTimeout(resolve,10));
async function waitReady(index){for(let n=0;n<300;n++){if(index.status().state==='ready')return;await delay();}throw Error(JSON.stringify(index.status()));}
function setup(t,records){
 const directory=mkdtempSync(join(tmpdir(),'shiwen-search-test-'));const rows=new Map(records.map(r=>[r.id,r]));
 const library={snapshot:()=>({records:[...rows.values()].filter(r=>!r.deleted)}),get:id=>rows.get(id)};
 const index=createSearchIndex({library,directory,embed,countTokens,modelVersion:'test-v1'});
 t.after(()=>{index.close();rmSync(directory,{recursive:true,force:true});});return {index,rows,directory,library};
}
const row=(id,text,extra={})=>({id,kind:'freewrite',title:'标题',revision:1,doc:doc(text),origin:'personal',contentDay:'2026-01-01',...extra});

test('token bound, Unicode offsets and full long-document coverage',async()=>{
 const text='前😀**行动**。'.repeat(100), chunks=await splitText(text,{countTokens,prefix:'标题\n'});
 assert.ok(chunks.length>1);for(const c of chunks){assert.equal(c.text,text.slice(c.start,c.end));assert.ok(await countTokens('标题\n'+c.text)<=512);assert.ok(!/^[\uDC00-\uDFFF]/u.test(c.text));}
 assert.equal(chunks[0].start,0);assert.equal(chunks.at(-1).end,text.length);
});

test('exact fallback reads library without any index or model',()=>{
 const record=row('a','保留原文',{title:'记录'}),library={snapshot:()=>({records:[record]})};
 const result=searchExact({library},{query:'原文',scope:'materials',mode:'exact',filters:{kind:'freewrite'}});
 assert.equal(result.total,1);assert.equal(result.items[0].recordId,'a');assert.equal(result.items[0].match.text,'保留原文');
});

test('invalid index schema fails construction and leaves the database usable for recovery',t=>{
 const directory=mkdtempSync(join(tmpdir(),'shiwen-search-invalid-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const path=join(directory,'search.sqlite'),broken=new DatabaseSync(path);broken.exec('CREATE TABLE meta(wrong TEXT)');broken.close();
 const library={snapshot:()=>({records:[]}),get:()=>null};assert.throws(()=>createSearchIndex({library,directory,embed,countTokens,modelVersion:'test'}));
 const repaired=new DatabaseSync(path);repaired.exec('DROP TABLE meta');repaired.close();const index=createSearchIndex({library,directory,embed,countTokens,modelVersion:'test'});index.close();
});

test('exact remains available without model; semantic filters and reading anchors',async t=>{
 const annotation=JSON.stringify({schema:'shiwen.reading-note.v1',chapter:'独特章节',page:'10',excerpts:[{text:'第一段',page:'11'},{text:'第二次开始',page:'12'}]});
 const {index}=setup(t,[row('a','以前开始行动'),row('b','无关内容',{kind:'article',stage:'draft'}),row('r','我的想法',{kind:'reading_note',title:'一本书',annotation})]);
 const exact=await index.search({query:'开始',scope:'reading',mode:'exact',filters:{book:'一本书'}});
 assert.equal(exact.items.length,1);assert.equal(exact.items[0].cardId,'r:1');assert.equal(exact.items[0].match.anchor.excerptIndex,1);assert.equal(exact.items[0].page,'12');
 const chapter=await index.search({query:'独特章节',scope:'reading',mode:'exact',filters:{book:'一本书'}});assert.equal(chapter.total,2);assert.equal(chapter.items[0].match.field,'chapter');assert.equal(chapter.items[0].match.text,'独特章节');
 await assert.rejects(index.search({query:'行动',scope:'materials',mode:'semantic'}),{code:'SEMANTIC_NOT_READY'});
 index.start();await waitReady(index);
 const semantic=await index.search({query:'行动',scope:'materials',mode:'semantic',filters:{kind:'freewrite'}});
 assert.deepEqual(semantic.items.map(x=>x.recordId),['a']);
 const linked=await index.search({query:'开始',scope:'writingSources',mode:'exact',filters:{sourceScope:'linked',selectedIds:[]}});assert.equal(linked.total,0);
});

test('edits, deletion, recovery, and restart never return stale vectors',async t=>{
 const {index,rows,library,directory}=setup(t,[row('a','开始行动')]);index.start();await waitReady(index);
 assert.equal((await index.search({query:'行动',scope:'materials',mode:'semantic'})).total,1);
 rows.set('a',row('a','全新内容',{revision:1}));
 let result=await index.search({query:'行动',scope:'materials',mode:'semantic'});assert.equal(result.total,0);
 await waitReady(index);rows.set('a',{...rows.get('a'),deleted:1});result=await index.search({query:'行动',scope:'materials',mode:'semantic'});assert.equal(result.total,0);
 rows.set('a',row('a','再次开始',{revision:2}));index.notifyChange();await waitReady(index);index.close();
 const reopened=createSearchIndex({library,directory,embed,countTokens,modelVersion:'test-v1'});t.after(()=>reopened.close());reopened.start();await waitReady(reopened);
 result=await reopened.search({query:'行动',scope:'materials',mode:'semantic'});assert.equal(result.items[0].revision,2);
});

test('an old embedding completing after an edit is discarded',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'shiwen-search-race-'));let release,started;
 const gate=new Promise(resolve=>release=resolve),entered=new Promise(resolve=>started=resolve);let first=true;
 const slow=async texts=>{if(first){first=false;started();await gate;}return embed(texts);};
 const rows=new Map([['a',row('a','开始行动')]]),library={snapshot:()=>({records:[...rows.values()]}),get:id=>rows.get(id)};
 const index=createSearchIndex({library,directory,embed:slow,countTokens,modelVersion:'test'});t.after(()=>{index.close();rmSync(directory,{recursive:true,force:true});});
 index.start();await entered;rows.set('a',row('a','新的开始',{revision:2}));index.notifyChange();release();await waitReady(index);
 const result=await index.search({query:'行动',scope:'materials',mode:'semantic'});assert.equal(result.items[0].revision,2);assert.match(result.items[0].match.text,/新/);
});

test('close waits for in-flight indexing and is idempotent',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'shiwen-search-close-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
 let release,started;const gate=new Promise(resolve=>release=resolve),entered=new Promise(resolve=>started=resolve);
 const rows=[row('a','开始行动')],library={snapshot:()=>({records:rows}),get:id=>rows.find(row=>row.id===id)};
 const slow=async texts=>{started();await gate;return embed(texts);};
 const index=createSearchIndex({library,directory,embed:slow,countTokens,modelVersion:'test'});index.start();await entered;
 let complete=false;const closing=index.close().then(()=>{complete=true;});assert.equal(index.close(),index.close());await delay();assert.equal(complete,false);release();await closing;assert.equal(complete,true);
 const db=new DatabaseSync(join(directory,'search.sqlite'));db.exec('PRAGMA wal_checkpoint(TRUNCATE)');db.close();
});

test('close aborts a stalled background embedding before closing the database',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'shiwen-search-abort-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
 let started;const entered=new Promise(resolve=>started=resolve),rows=[row('a','开始行动')],library={snapshot:()=>({records:rows}),get:id=>rows.find(row=>row.id===id)};
 const hanging=(_texts,{signal})=>new Promise((resolve,reject)=>{started();signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});
 const index=createSearchIndex({library,directory,embed:hanging,countTokens,modelVersion:'test'});index.start();await entered;await index.close();
 const db=new DatabaseSync(join(directory,'search.sqlite'));db.exec('PRAGMA wal_checkpoint(TRUNCATE)');db.close();
});

test('query rechecks current state after asynchronous embedding',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'shiwen-search-query-race-'));let release,started;
 const gate=new Promise(resolve=>release=resolve),entered=new Promise(resolve=>started=resolve);
 const rows=new Map([['a',row('a','开始行动')]]),library={snapshot:()=>({records:[...rows.values()]}),get:id=>rows.get(id)};
 const slow=async(texts,options)=>{if(options.priority==='query'){started();await gate;}return embed(texts);};
 const index=createSearchIndex({library,directory,embed:slow,countTokens,modelVersion:'test'});t.after(()=>{index.close();rmSync(directory,{recursive:true,force:true});});index.start();await waitReady(index);
 const pending=index.search({query:'行动',scope:'materials',mode:'semantic'});await entered;rows.set('a',{...rows.get('a'),deleted:1});release();assert.equal((await pending).total,0);
});

test('real isolated library additions and deletion are reconciled',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'shiwen-search-real-')),library=createStore(join(directory,'library.sqlite'));
 const index=createSearchIndex({library,directory:join(directory,'search'),embed,countTokens,modelVersion:'test'});
 t.after(()=>{index.close();library.close();rmSync(directory,{recursive:true,force:true});});
 const saved=library.save({kind:'freewrite',title:'隔离样本',body:'开始行动'});index.start();await waitReady(index);
 assert.equal((await index.search({query:'行动',scope:'materials',mode:'semantic'})).items[0].recordId,saved.id);
 library.remove({id:saved.id,revision:saved.revision});assert.equal((await index.search({query:'行动',scope:'materials',mode:'semantic'})).total,0);
});

test('real diary append, import, sync push and restore reconcile the index',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'shiwen-search-paths-')),library=createStore(join(directory,'library.sqlite'));
 const index=createSearchIndex({library,directory:join(directory,'search'),embed,countTokens,modelVersion:'test'});
 t.after(()=>{index.close();library.close();rmSync(directory,{recursive:true,force:true});});
 const search=()=>index.search({query:'行动',scope:'materials',mode:'semantic'});
 const first=library.save({kind:'journal',day:'2025-01-01',body:'最初开始'});index.start();await waitReady(index);
 const appended=library.save({kind:'journal',day:'2025-01-01',body:'后来行动'});assert.equal(appended.id,first.id);
 assert.equal((await search()).total,0);await waitReady(index);assert.equal((await search()).items[0].revision,appended.revision);assert.equal((await index.search({query:'后来行动',scope:'materials',mode:'exact'})).items[0].recordId,first.id);
 const deleted=library.remove({id:first.id,revision:appended.revision});assert.equal((await search()).total,0);
 library.restoreRemoved(deleted);assert.equal((await search()).total,0);await waitReady(index);assert.equal((await search()).items[0].recordId,first.id);
 library.importWiki({root:'/synthetic/wiki',files:[],notes:[{path:'memo.md',sha256:'fixture',kind:'reference',title:'导入材料',doc:plainDoc('导入后行动','external'),origin:'external',url:'',day:'2025-02-01',data:'fixture',dateBasis:'原文日期',chars:5,metadata:{tags:[]},links:[],candidates:[],warnings:[]}]});
 await search();await waitReady(index);assert.ok((await search()).items.some(x=>x.title==='导入材料'));
 const sync=library.mobileSync(),deviceId=randomUUID(),id=randomUUID(),identity=sync.identity({protocolVersion:'1.0.0-draft.3',deviceId}),at='2025-03-01T00:00:00.000Z',text='同步后行动';
 const payload={id,kind:'idea',title:'同步材料',markdown:text,origin:'personal',processing:'original',contentDay:null,dateBasis:'',url:'',annotation:'',stage:'idea',sourceIds:[],sources:[{text,origin:'personal'}],attachmentDescriptors:[],createdAt:at,updatedAt:at,deleted:false,createdByDevice:deviceId};
 const op={operationId:randomUUID(),recordId:id,changeId:randomUUID(),versionId:randomUUID(),baseVersionId:null,parentVersionIds:[],originDeviceId:deviceId,action:'create',baseRevision:null,localGeneration:1,occurredAt:at,timeZone:'UTC',payload,activities:[]};
 assert.equal(sync.push({libraryId:identity.libraryId,epoch:identity.epoch,deviceId,operations:[{inlineBody:op}]}).receipts[0].status,'applied');
 await search();await waitReady(index);assert.ok((await search()).items.some(x=>x.recordId===id));
});

test('idea canvas suggests relevant passages and title-only ideas across the library',async t=>{
 const {index}=setup(t,[
   row('idea','',{kind:'idea',title:'开始'}),
   row('article','开始行动',{kind:'article'}),
   row('reading','',{
     kind:'reading_note',annotation:JSON.stringify({schema:'shiwen.reading-note.v1',excerpts:[{text:'开始阅读',page:'8'}]})
   }),
   row('unrelated','完全无关')
 ]);
 index.start();await waitReady(index);
 const result=await index.search({query:'开始',mode:'semantic',scope:'ideaCanvas'});
 assert.deepEqual(result.items.map(x=>[x.recordId,x.match.field]),[['article','body'],['idea','title'],['reading','excerpt']]);
 assert.equal(result.items[2].match.text,'开始阅读');
});

test('category search filters before ranking and global results locate the matching legacy excerpt',async t=>{
 const {index}=setup(t,[
   row('r','开始记录',{kind:'journal'}),row('w','开始收藏',{kind:'web'}),
   row('a','开始创作',{kind:'article'}),row('b','',{kind:'reading_note',annotation:JSON.stringify({schema:'shiwen.reading-note.v1',excerpts:[{text:'第一页'},{text:'开始读书'}]})})
 ]);
 index.start();await waitReady(index);
 for(const mode of ['exact','semantic']){
   for(const [scope,id] of [['records','r'],['collections','w'],['articles','a']]){
     const found=await index.search({query:'开始',mode,scope,limit:1});
     assert.equal(found.total,1);assert.equal(found.items[0].recordId,id);
   }
 }
 const global=await index.search({query:'开始',mode:'exact',scope:'global'});
 assert.equal(global.total,4);
 assert.equal(global.items.find(item=>item.recordId==='b').cardId,'b:1');
});
