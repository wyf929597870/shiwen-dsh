import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {createStore} from '../plugins/library/legacy/store.mjs';
import {exportDocumentBundle} from '../integration/document-export.mjs';

function entries(base64){
  const zip=Buffer.from(base64,'base64'),files=new Map();let offset=0;
  while(zip.readUInt32LE(offset)===0x04034b50){
    const size=zip.readUInt32LE(offset+18),nameLength=zip.readUInt16LE(offset+26),extra=zip.readUInt16LE(offset+28),start=offset+30+nameLength+extra;
    files.set(zip.subarray(offset+30,offset+30+nameLength).toString(),zip.subarray(start,start+size));offset=start+size;
  }
  assert.equal(zip.readUInt32LE(offset),0x02014b50);assert.equal(zip.readUInt32LE(zip.length-22),0x06054b50);return files;
}
test('document export keeps originals, annotations, version anchors and images separate without changing the library',t=>{
  const dir=mkdtempSync(join(tmpdir(),'shiwen-export-test-')),store=createStore(join(dir,'library.sqlite'));
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  const original=store.save({kind:'reference',origin:'personal',body:'# 原文\n自己的文字'});
  const anchor=store.originalVersionInfo({id:original.id});
  const note=store.annotationCreate({originalId:original.id,originalVersionId:anchor.versionId,body:'AI 建议',requestId:randomUUID()});
  const image=Buffer.from('89504e470d0a1a0a00010203','hex');
  const imageId=store.attachmentAdd({record:note.id,name:'图.png',data:image.toString('base64')});
  const current=store.get(note.id);
  store.annotationUpdate({id:note.id,revision:current.revision,body:`AI 建议\n![图](attachment:${imageId})`,requestId:randomUUID()});
  store.updateRecord({id:original.id,revision:original.revision,body:'已修改的原文'});
  const removed=store.annotationCreate({originalId:original.id,originalVersionId:anchor.versionId,body:'删除的标注',requestId:randomUUID()});
  store.annotationDelete({id:removed.id,revision:removed.revision,requestId:randomUUID()});
  const before=store.exportBackup(),result=exportDocumentBundle(store,{id:original.id}),files=entries(result.dataBase64),manifest=JSON.parse(files.get('manifest.json'));
  assert.equal(result.mimeType,'application/zip');
  assert.equal(files.get(`originals/${original.id}.md`).toString(),'已修改的原文');
  assert.equal(files.get(`annotations/${note.id}.md`).toString(),`AI 建议\n![图](../assets/${imageId}.png)`);
  assert.equal(files.get(`versions/${anchor.versionId}.md`).toString(),'# 原文\n自己的文字');
  assert.deepEqual(files.get(`assets/${imageId}.png`),image);
  assert.deepEqual(manifest.relations,[{annotationId:note.id,originalId:original.id,originalVersionId:anchor.versionId,originalContentHash:anchor.contentHash}]);
  assert.equal(manifest.assets[0].sha256,createHash('sha256').update(image).digest('hex'));
  assert.equal(files.has(`annotations/${removed.id}.md`),false);
  assert.deepEqual(JSON.parse(store.exportBackup()).payload.tables,JSON.parse(before).payload.tables);
  assert.throws(()=>exportDocumentBundle(store,{id:note.id}),/原文不存在/);
});
