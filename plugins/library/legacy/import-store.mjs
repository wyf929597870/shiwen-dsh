import {randomUUID} from 'node:crypto';
import {plainDoc,readDoc} from './content.mjs';

export const importDDL=`CREATE TABLE IF NOT EXISTS imports(
  record TEXT PRIMARY KEY REFERENCES records(id),root TEXT NOT NULL,path TEXT NOT NULL,
  sha256 TEXT NOT NULL,day TEXT,date_basis TEXT NOT NULL,chars INTEGER NOT NULL,
  duplicate_of TEXT,metadata TEXT NOT NULL,links TEXT NOT NULL,imported TEXT NOT NULL,
  UNIQUE(root,path));`;

// The scanner is a trusted local CLI operation, never exposed as renderer IPC.
export function importWiki(db,scan){
  return db.transaction(()=>{
    const now=new Date().toISOString(),existing=db.prepare('SELECT * FROM imports WHERE root=?').all(scan.root);
    const prior=new Map(existing.map(r=>[r.path,r])),ids=new Map(existing.map(r=>[r.path,r.record]));
    const added=[],skipped=[],conflicts=[];
    for(const note of scan.notes){const old=prior.get(note.path);if(old){(old.sha256===note.sha256?skipped:conflicts).push(note.path);}else{ids.set(note.path,randomUUID());added.push(note);}}
    const addRecord=(id,kind,title,doc,origin,url,at)=>{
      const {text}=readDoc(doc,origin);
      db.prepare('INSERT INTO records(id,kind,title,doc,body,origin,url,revision,created,updated) VALUES(?,?,?,?,?,?,?,1,?,?)').run(id,kind,title,JSON.stringify(doc),text,origin,url,at,at);
      db.prepare('INSERT INTO versions VALUES(?,?,1,?,?,?,?)').run(randomUUID(),id,JSON.stringify(doc),title,now,'导入原始快照');
    };
    const addInfo=(id,n)=>db.prepare('INSERT INTO imports VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id,scan.root,n.path,n.sha256,n.day,n.dateBasis,n.chars,n.duplicateOf??null,JSON.stringify(n.metadata),JSON.stringify(n.links??[]),now);
    const originalIds=new Map();
    for(const note of added){
      const id=ids.get(note.path),at=note.day?note.day+'T12:00:00+08:00':now;
      addRecord(id,note.kind,note.title,note.doc,note.origin,note.url,at);
      const attachment=randomUUID();originalIds.set(note.path,attachment);
      db.prepare('INSERT INTO attachments VALUES(?,?,?,?,?)').run(attachment,id,note.path,note.data,now);
    }
    const assets=scan.files.filter(f=>!scan.notes.some(n=>n.path===f.path));
    let assetId=ids.get(':assets');
    if(assets.length&&!assetId){assetId=randomUUID();ids.set(':assets',assetId);addRecord(assetId,'reference','Wiki 导入附件',plainDoc('随 Wiki 导入的图片、文档和其他文件。可在下方附件列表导出原件。','unknown'),'unknown','',now);addInfo(assetId,{path:':assets',sha256:'',day:null,dateBasis:'附件归档，不计入统计',chars:0,metadata:{assetArchive:true}});}
    const assetManifest=assetId?JSON.parse(db.prepare('SELECT metadata FROM imports WHERE record=?').get(assetId)?.metadata??'{}'):{};
    assetManifest.files??=[];
    for(const asset of assets){
      const old=assetManifest.files.find(f=>f.path===asset.path);
      if(old){if(old.sha256!==asset.sha256)conflicts.push(asset.path);continue;}
      const id=randomUUID();db.prepare('INSERT INTO attachments VALUES(?,?,?,?,?)').run(id,assetId,asset.path,asset.data,now);
      assetManifest.files.push({path:asset.path,sha256:asset.sha256,id,bytes:asset.bytes});
    }
    if(assetId)db.prepare('UPDATE imports SET metadata=? WHERE record=?').run(JSON.stringify(assetManifest),assetId);
    const assetsByPath=new Map(assetManifest.files.map(f=>[f.path,f.id]));
    for(const note of added){
      const id=ids.get(note.path);
      const links=note.links.map(l=>({...l,record:l.path?ids.get(l.path)??null:null,attachment:l.path?assetsByPath.get(l.path)??null:null}));
      addInfo(id,{...note,metadata:{...note.metadata,_import:{dateCandidates:note.candidates,warnings:note.warnings,originalAttachment:originalIds.get(note.path)}},links});
      if(note.kind==='article')for(const target of new Set(links.map(l=>l.record).filter(Boolean))){const r=db.prepare('SELECT kind FROM records WHERE id=?').get(target);if(r?.kind!=='article')db.prepare('INSERT OR IGNORE INTO links VALUES(?,?)').run(id,target);}
    }
    return {added:added.length,skipped:skipped.length,conflicts,assetFiles:assetManifest.files.length,records:Object.fromEntries(ids)};
  })();
}
