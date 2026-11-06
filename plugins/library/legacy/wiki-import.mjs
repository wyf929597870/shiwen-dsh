import {readdirSync,readFileSync} from 'node:fs';
import {resolve,posix,extname} from 'node:path';
import {createHash} from 'node:crypto';
import yaml from 'js-yaml';
import {plainDoc,count} from './content.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
export function validDay(value){
  const match=String(value??'').match(/^(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})(?:日|\b|T)/);
  if(!match)return null;
  const day=`${match[1]}-${match[2].padStart(2,'0')}-${match[3].padStart(2,'0')}`;
  const parsed=new Date(day+'T12:00:00Z');
  return Number.isFinite(+parsed)&&parsed.toISOString().slice(0,10)===day?day:null;
}
export function parseNote(path,raw){
  const text=raw.replace(/^\uFEFF/,'').replace(/\r\n/g,'\n');
  const fm=text.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  let metadata={},warnings=[];
  if(fm)try{metadata=yaml.load(fm[1],{schema:yaml.JSON_SCHEMA})??{};if(typeof metadata!=='object'||Array.isArray(metadata))metadata={};}catch{warnings.push('元数据格式异常，原件完整保留');}
  const body=fm?text.slice(fm[0].length).trim():text.trim();
  const name=posix.basename(path,'.md');
  const heading=body.match(/^#{1,6}\s+(.+)$/m)?.[1];
  const title=String(metadata.title||heading||name).slice(0,200);
  const compact=name.match(/(?:^|[^0-9])(20\d{2})([01]\d)([0-3]\d)(?:$|[^0-9])/);
  const monthDirectory=posix.basename(posix.dirname(path));
  const filenameDay=validDay(name.match(/\d{4}-\d{2}-\d{2}/)?.[0])??validDay(compact?`${compact[1]}-${compact[2]}-${compact[3]}`:null)??validDay(/^\d{1,2}$/.test(name)&&/^\d{4}-\d{2}$/.test(monthDirectory)?`${monthDirectory}-${name}`:null);
  let kind='reference';
  if(path.startsWith('private/日记/')&&filenameDay)kind='journal';
  else if((path.startsWith('private/归档-自由书写/')||path.startsWith('raw/insights/')&&/自由书写/.test(name))&&!/模板|索引|计划|README|对话/i.test(name))kind='freewrite';
  else if(path.startsWith('raw/clippings/'))kind='web';
  else if(path.startsWith('articles/')&&(['article','generic/article'].includes(metadata.type)||!metadata.type&&!path.includes('/prompts/')&&(/^(正文|初稿|草稿)$/.test(name)||name===posix.basename(posix.dirname(path))))&&!metadata.source_url&&!metadata.source)kind='article';
  const origin=metadata.translated_by?'translation':kind==='web'?'external':'unknown';
  // No inference of authorship from the folder: diaries and drafts may have AI edits.
  const candidates=[];
  const candidate=(value,basis)=>{const day=validDay(value);if(day)candidates.push({day,basis});};
  candidate(metadata.date,'文档 date');
  if(kind==='web'){candidate(metadata.captured,'收集 captured');candidate(metadata.ingested,'入库 ingested');}
  if(kind==='article')candidate(metadata.published,'发布 published');
  if(filenameDay)candidate(filenameDay,'文件名日期');
  candidate(heading?.match(/\d{4}[-/年]\d{1,2}[-/月]\d{1,2}/)?.[0],'正文标题日期');
  candidate(body.match(/^(?:\*\*)?日期[：:]?(?:\*\*)?\s*(\d{4}-\d{2}-\d{2})/m)?.[1],'正文日期字段');
  candidate(metadata.created,'文档 created');
  if(kind!=='web')candidate(metadata.ingested,'入库 ingested');
  const date=candidates[0]??{day:null,basis:'日期待确认'};
  const url=[metadata.source_url,metadata.url,metadata.source].find(v=>typeof v==='string'&&/^https?:\/\/\S+$/.test(v))??'';
  return {path,title,body,kind,origin,doc:plainDoc(body,origin),url,day:date.day,dateBasis:date.basis,metadata,candidates,warnings,chars:count(body),links:[]};
}

export function scanWiki(directory){
  const root=resolve(directory),files=[],skipped=[];
  function walk(relative=''){
    for(const entry of readdirSync(resolve(root,relative),{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
      const path=posix.join(relative,entry.name);
      if(entry.name.startsWith('.')||entry.isSymbolicLink()){skipped.push(path);continue;}
      if(entry.isDirectory())walk(path);
      else if(entry.isFile()){const data=readFileSync(resolve(root,path));files.push({path,sha256:hash(data),bytes:data.length,data:data.toString('base64')});}
    }
  }
  walk();
  const notes=files.filter(f=>extname(f.path).toLowerCase()==='.md').map(f=>({...parseNote(f.path,Buffer.from(f.data,'base64').toString('utf8')),sha256:f.sha256,data:f.data}));
  const paths=new Set(files.map(f=>f.path));
  const aliases=new Map();
  for(const file of files){const key=posix.basename(file.path).replace(/\.md$/i,'');aliases.set(key,[...(aliases.get(key)??[]),file.path]);}
  const resolveLink=(from,target)=>{
    let value=target.split('|')[0].trim();
    if(value.startsWith('obsidian://')){try{const u=new URL(value);value=u.searchParams.get('file')??'';}catch{return null;}}
    else {try{value=decodeURIComponent(value);}catch{}}
    value=value.split('#')[0].replace(/^<|>$/g,'').replaceAll('\\','/');
    const prefix=root.replaceAll('\\','/').replace(/\/$/,'')+'/';
    if((process.platform==='win32'?value.toLowerCase().startsWith(prefix.toLowerCase()):value.startsWith(prefix)))value=value.slice(prefix.length);
    if(!value)return from;
    if(/^[a-z]+:/i.test(value)||value.startsWith('/'))return null;
    const choices=[posix.normalize(posix.join(posix.dirname(from),value)),posix.normalize(value)];
    for(const choice of choices)for(const path of [choice,choice+'.md'])if(paths.has(path))return path;
    const matches=aliases.get(value.replace(/\.md$/i,''));
    return matches?.length===1?matches[0]:null;
  };
  for(const note of notes){
    const targets=[...note.body.matchAll(/!?\[\[([^\]]+)\]\]/g)].map(m=>m[1]);
    targets.push(...[...note.body.matchAll(/!?\[[^\]]*\]\(([^\n]+?)\)/g)].map(m=>m[1].replace(/\s+"[^"]*"$/,'')));
    for(const target of new Set(targets)){if(/^https?:|^mailto:|^data:/i.test(target))continue;const resolved=resolveLink(note.path,target);note.links.push({target,path:resolved});}
  }
  // Preserve duplicate files, but do not count identical archived body text twice.
  const bodies=new Map();
  for(const note of notes){const fingerprint=hash(note.body.replace(/\s/g,''));note.duplicateOf=bodies.get(fingerprint)??null;if(!note.duplicateOf)bodies.set(fingerprint,note.path);}
  return {root,files,notes,skipped};
}

export function importSummary(scan){
  const byKind={},byMonth={};
  for(const note of scan.notes){byKind[note.kind]=(byKind[note.kind]??0)+1;const month=note.day?.slice(0,7)??'日期待确认';byMonth[month]=(byMonth[month]??0)+1;}
  return {root:scan.root,files:scan.files.length,notes:scan.notes.length,assets:scan.files.length-scan.notes.length,bytes:scan.files.reduce((n,f)=>n+f.bytes,0),dated:scan.notes.filter(n=>n.day).length,undated:scan.notes.filter(n=>!n.day).length,byKind,byMonth,duplicates:scan.notes.filter(n=>n.duplicateOf).length,resolvedLinks:scan.notes.flatMap(n=>n.links).filter(l=>l.path).length,unresolvedLinks:scan.notes.flatMap(n=>n.links).filter(l=>!l.path).length,skipped:scan.skipped};
}
