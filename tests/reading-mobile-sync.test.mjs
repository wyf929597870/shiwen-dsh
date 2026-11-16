import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {createStore} from '../plugins/library/legacy/store.mjs';
import {encodeReadingNote,decodeReadingNote} from '../plugins/library/legacy/reading-note.mjs';
import {protocolVersion} from '../contracts/mobile/v1/schema.mjs';

test('mobile excerpt-only note syncs, updates and propagates without writing activity',t=>{
 const dir=mkdtempSync(join(tmpdir(),'reading-mobile-sync-')),store=createStore(join(dir,'library.sqlite'));
 t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
 const sync=store.mobileSync(),deviceId=randomUUID(),identity=sync.identity({protocolVersion,deviceId}),id=randomUUID(),at='2026-11-10T01:00:00.000Z';
 const payload={id,kind:'reading_note',title:'同步书目',markdown:'',origin:'personal',processing:'original',contentDay:'2026-11-10',dateBasis:'读书笔记记录日期',url:'',annotation:encodeReadingNote({excerpts:[{text:'原文'}]}),stage:'draft',sourceIds:[],sources:[],attachmentDescriptors:[],createdAt:at,updatedAt:at,deleted:false,createdByDevice:deviceId};
 const create={operationId:randomUUID(),recordId:id,changeId:randomUUID(),versionId:randomUUID(),baseVersionId:null,parentVersionIds:[],originDeviceId:deviceId,action:'create',baseRevision:null,localGeneration:1,occurredAt:at,timeZone:'Asia/Shanghai',payload,activities:[]};
 const push=op=>sync.push({libraryId:identity.libraryId,epoch:identity.epoch,deviceId,operations:[{inlineBody:op}]}).receipts[0];
 const first=push(create);assert.equal(first.status,'applied');assert.deepEqual(push(create),first);
 const annotation=encodeReadingNote({excerpts:[{text:'更新的摘录'}]});
 const update={...create,operationId:randomUUID(),changeId:randomUUID(),versionId:randomUUID(),baseVersionId:first.versionId,parentVersionIds:[first.versionId],action:'update',baseRevision:first.revision,localGeneration:2,payload:{...payload,annotation}};
 assert.equal(push(update).status,'applied');
 const events=sync.changes({libraryId:identity.libraryId,epoch:identity.epoch,deviceId,cursor:0}).events;
 assert.equal(events.length,2);assert.equal(events.at(-1).record.markdown,'');assert.deepEqual(events.at(-1).record.sources,[]);assert.equal(decodeReadingNote(events.at(-1).record.annotation).excerpts[0].text,'更新的摘录');
 assert.equal(JSON.parse(store.exportBackup()).payload.tables.edits.length,0);
});
