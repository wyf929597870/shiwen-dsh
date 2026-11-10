import MarkdownIt from 'markdown-it';

const md=new MarkdownIt({html:false});
export const goalDefinitions=[
 {id:'reading',label:'阅读',en:'Reading',unit:'分钟',unitEn:'min',aliases:['阅读','看书','读书']},
 {id:'exercise',label:'运动',en:'Exercise',unit:'分钟',unitEn:'min',aliases:['运动','锻炼']},
 {id:'notes',label:'读书笔记',en:'Reading notes',unit:'字',unitEn:'chars',aliases:['读书笔记','读书感想','阅读笔记']},
 {id:'journal',label:'日记',en:'Journal',unit:'字',unitEn:'chars',aliases:['日记','日记正文']},
 {id:'freewrite',label:'自由书写',en:'Freewriting',unit:'字',unitEn:'chars',aliases:['自由书写']},
 {id:'publication',label:'公众号',en:'Publication',unit:'天',unitEn:'days',aliases:['公众号']}
];
const clean=s=>s.replace(/[*_`\s]/g,'').replace(/[：:]$/,'');
const definition=s=>goalDefinitions.find(g=>g.aliases.includes(clean(s)));
const empty=()=>({value:null,completed:false,recorded:false});
function quantity(text,goal){
 const s=text.replace(/[,，*_`]/g,'').replace(/[✓✔√✅☑]/gu,'').trim();
 if(goal.unit==='分钟'){
  const m=/^(?:(\d+(?:\.\d+)?)\s*(?:小时|h)\s*)?(?:(\d+(?:\.\d+)?)\s*(?:分钟|分|min))?$/i.exec(s);
  return m&&(m[1]!=null||m[2]!=null)?Number(m[1]||0)*60+Number(m[2]||0):null;
 }
 if(goal.unit==='字'){const m=/^(\d+)\s*字$/.exec(s);return m?Number(m[1]):null;}
 return null;
}

// Only actual Markdown tables are parsed; fenced examples and ordinary prose are ignored.
export function parseJournalGoals(markdown){
 const tokens=md.parse(markdown,{}),goals={};
 for(let i=0;i<tokens.length;i++){
  if(tokens[i].type!=='table_open'||tokens[i].level!==0)continue;
  const rows=[];let row;
  for(i++;i<tokens.length&&tokens[i].type!=='table_close';i++){
   if(tokens[i].type==='tr_open'){row=[];rows.push(row);}
   if(tokens[i].type==='inline')row?.push(tokens[i].content);
  }
  const headers=rows.shift()?.map(clean)||[];
  const project=headers.findIndex(h=>['项目','事项','目标'].includes(h));
  const status=headers.findIndex(h=>['状态','完成','完成情况'].includes(h));
  const numeric=headers.findIndex(h=>['时长','分钟','时长(分钟)','时长（分钟）','字数','数值'].includes(h));
  if(project<0||(status<0&&numeric<0))continue;
  for(const cells of rows){
   const goal=definition(cells[project]||'');if(!goal)continue;
   const state=cells[status]||'',raw=cells[numeric]||'';
   const numericText=/^\d+(?:\.\d+)?$/.test(raw.trim())&&/分钟/.test(headers[numeric]||'')?raw+' 分钟':/^\d+$/.test(raw.trim())&&headers[numeric]==='字数'?raw+' 字':raw;
   const reported=quantity(numericText,goal)??quantity(state,goal);
   // These two metrics belong to separate files. Checklist numbers may indicate
   // completion, but must never replace or add to their saved document counts.
   const value=['journal','freewrite'].includes(goal.id)?null:reported;
   // Duplicate rows/tables describe the same daily goal, not additional sessions.
   const previous=goals[goal.id]||empty();
   goals[goal.id]={value:value??previous.value,source:value!=null?'explicit':previous.source,recorded:true,completed:previous.completed||/[✓✔√✅☑]/u.test(state)||/^\s*\[x\]\s*$/i.test(state)||clean(state)==='已完成'||(reported!=null&&reported>0)};
  }
 }
 return goals;
}

export function reviewGoalDays(preview){
 const days=new Map((preview?.daily||[]).map(d=>[d.day,{day:d.day,goals:{},records:[]} ]));
 const seen=new Set();
 for(const record of preview?.records||[]){
  const day=days.get(record.contentDay);if(!day||seen.has(record.id))continue;seen.add(record.id);day.records.push(record);
  let goals=record.kind==='journal'?parseJournalGoals(record.goalMarkdown||''):{};
  // Reuse the existing count of each independent document, by its content day.
  if(record.kind==='journal')goals.journal={value:record.characters,recorded:true,completed:Boolean(goals.journal?.completed)||record.characters>0};
  if(record.kind==='freewrite')goals={freewrite:{value:record.characters,recorded:true,completed:record.characters>0}};
  // Reserved for independent reading notes. Historical references are never inferred
  // from titles or headings. Saved notes take precedence over checklist quantities.
  if(record.kind==='reading_note')goals={notes:{value:record.characters,source:'document',recorded:true,completed:record.characters>0}};
  for(const [id,goal] of Object.entries(goals)){
   const previous=day.goals[id]||empty();
   const document=goal.source==='document'||previous.source==='document';
   const value=document?(goal.source==='document'?goal.value+(previous.source==='document'?previous.value:0):previous.value):goal.source==='explicit'?goal.value:previous.source==='explicit'?previous.value:goal.value==null?previous.value:(previous.value??0)+goal.value;
   day.goals[id]={recorded:previous.recorded||goal.recorded,completed:previous.completed||goal.completed,value,source:document?'document':goal.source==='explicit'||previous.source==='explicit'?'explicit':goal.source};
  }
 }
 return [...days.values()];
}
export function goalSummary(days,id){
 const values=days.map(d=>d.goals[id]||empty()),numeric=values.filter(v=>v.value!=null);
 const total=numeric.reduce((n,v)=>n+v.value,0);
 return {total:numeric.length?total:null,numericDays:numeric.length,average:numeric.length?total/numeric.length:null,completedDays:values.filter(v=>v.completed).length,recordedDays:values.filter(v=>v.recorded).length,checkOnlyDays:values.filter(v=>v.completed&&v.value==null).length};
}
