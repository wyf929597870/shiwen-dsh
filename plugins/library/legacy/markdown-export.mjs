import yaml from 'js-yaml';
import {markdownSource} from './markdown.mjs';
import {toMarkdown} from './content.mjs';

export function exportRecordMarkdown(record,sources=[]){
  if(record.importInfo&&record.importInfo.path!==':assets'){
    const metadata={...record.importInfo.metadata,title:record.title};delete metadata._import;
    if(record.importInfo.day)metadata.date=record.importInfo.day;
    else if(record.importInfo.date_basis==='人工修正')metadata.date=null;
    return `---\n${yaml.dump(metadata,{schema:yaml.JSON_SCHEMA,lineWidth:-1,noRefs:true})}---\n\n${markdownSource(record.doc)}`;
  }
  return `# ${record.title}\n\n${toMarkdown(record.doc)}\n\n${sources.length?'## 参考素材\n\n'+sources.filter(Boolean).map((s,i)=>`${i+1}. ${s.title}${s.url?' — '+s.url:''}`).join('\n'):''}`;
}
