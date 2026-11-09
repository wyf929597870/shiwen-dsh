import {createHash} from 'node:crypto';
import {markdownSource} from '../plugins/library/legacy/markdown.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const safeId = id => encodeURIComponent(String(id));
const crcTable = Uint32Array.from({length:256},(_,n)=>{
  for(let i=0;i<8;i++)n=n&1?0xedb88320^(n>>>1):n>>>1;
  return n>>>0;
});
function crc32(bytes){let crc=0xffffffff;for(const b of bytes)crc=crcTable[(crc^b)&255]^(crc>>>8);return (crc^0xffffffff)>>>0;}

// Stored ZIP entries keep this export independent of platform-specific archivers.
export function zipDocuments(files){
  const entries=[],central=[];let offset=0,size=0;
  if(files.length>65535)throw Error('导出文件过多，请分批导出');
  for(const {path,data} of files){
    if(path.startsWith('/')||path.split('/').some(p=>p==='..'||!p))throw Error('无效导出路径');
    const name=Buffer.from(path),bytes=Buffer.from(data),crc=crc32(bytes);
    size+=bytes.length;if(size>128*1024*1024)throw Error('导出内容超过 128 MB，请使用完整资料库备份');
    const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt16LE(0x800,6);
    local.writeUInt16LE(0x21,12);local.writeUInt32LE(crc,14);local.writeUInt32LE(bytes.length,18);local.writeUInt32LE(bytes.length,22);local.writeUInt16LE(name.length,26);
    entries.push(local,name,bytes);
    const header=Buffer.alloc(46);header.writeUInt32LE(0x02014b50);header.writeUInt16LE(20,4);header.writeUInt16LE(20,6);header.writeUInt16LE(0x800,8);
    header.writeUInt16LE(0x21,14);header.writeUInt32LE(crc,16);header.writeUInt32LE(bytes.length,20);header.writeUInt32LE(bytes.length,24);header.writeUInt16LE(name.length,28);header.writeUInt32LE(offset,42);
    central.push(header,name);offset+=local.length+name.length+bytes.length;
  }
  const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(files.length,8);end.writeUInt16LE(files.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...entries,directory,end]);
}

/** Read-only export. Original text and annotation text never share a document. */
export function exportDocumentBundle(library,{id}){
  const original=library.get(id);
  if(!original||original.deleted||original.kind==='ai_annotation')throw Error('原文不存在');
  const annotations=library.annotationList({originalId:id});
  const files=[],assets=new Map(),missing=new Set(),documents=[],relations=[];
  const records=[original,...annotations],versions=library.versions({id});
  for(const record of records){
    const attachments=[...library.attachments({record:record.id})];
    for(const link of record.importInfo?.links??[])if(link.attachment)attachments.push({id:link.attachment});
    for(const attachment of attachments){
      const item=library.attachment({id:attachment.id});if(!item)continue;
      const extension=/\.(png|jpe?g|gif|webp|svg|pdf|txt|md)$/i.exec(item.name)?.[0]?.toLowerCase()||'.bin';
      const path=`assets/${safeId(item.id)}${extension}`,data=Buffer.from(item.data,'base64');
      if(!assets.has(item.id)){files.push({path,data});assets.set(item.id,{id:item.id,name:item.name,path,sha256:digest(data)});}
    }
  }
  const rewrite=(markdown,record)=>{
    let result=markdown.replace(/attachment:([a-zA-Z0-9_-]+)/g,(reference,attachmentId)=>{
      const asset=assets.get(attachmentId);if(!asset){missing.add(attachmentId);return reference;}return '../'+asset.path;
    });
    for(const link of record?.importInfo?.links??[]){const asset=assets.get(link.attachment);if(asset&&link.target)result=result.split(link.target).join('../'+asset.path);}
    return result;
  };
  for(const record of records){
    const markdown=markdownSource(record.doc),path=`${record.kind==='ai_annotation'?'annotations':'originals'}/${safeId(record.id)}.md`;
    files.push({path,data:rewrite(markdown,record)});
    documents.push({id:record.id,path,title:record.title,kind:record.kind,origin:record.origin,revision:record.revision,contentHash:digest(markdown)});
    if(record.annotationOf)relations.push({annotationId:record.id,originalId:record.annotationOf.recordId,originalVersionId:record.annotationOf.versionId,originalContentHash:record.annotationOf.contentHash});
  }
  for(const versionId of new Set(relations.map(item=>item.originalVersionId))){
    const version=versions.find(item=>item.id===versionId);if(!version)throw Error('标注关联的原文版本缺失，无法完整导出');
    const markdown=markdownSource(version.doc),path=`versions/${safeId(versionId)}.md`;
    files.push({path,data:rewrite(markdown,original)});
  }
  const manifest={format:'shiwen-documents',version:1,originalId:id,documents,relations,assets:[...assets.values()],missingAttachmentIds:[...missing],note:'contentHash is SHA-256 of original UTF-8 Markdown before exported attachment paths are rewritten. Remote URLs are preserved.'};
  files.push({path:'manifest.json',data:JSON.stringify(manifest,null,2)});
  return {name:`shiwen-${safeId(id)}.zip`,mimeType:'application/zip',dataBase64:zipDocuments(files).toString('base64')};
}
