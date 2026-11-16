// Reading-note reflections remain the record body. This versioned metadata uses
// the existing portable annotation field, so excerpts survive sync and backups
// without entering original-character or edit counts.
const v1='shiwen.reading-note.v1',v2='shiwen.reading-note.v2';
const text=(value,max,label)=>{if(typeof value!=='string'||value.length>max)throw Error(`${label}格式或长度不正确`);return value;};
export function readingNoteMetadata({chapter='',page='',excerpts=[],noteType,schema}={}){
 text(chapter,200,'章节');text(page,80,'页码');
 if(!Array.isArray(excerpts)||excerpts.length>30)throw Error('每条笔记最多保存 30 段摘录');
 const cleaned=excerpts.map(x=>({text:text(x.text,9000,'摘录'),page:text(x.page??'',80,'摘录页码')})).filter(x=>x.text.trim());
 if(schema===v2||schema!==v1&&noteType!==undefined){if(!['excerpt','reflection','question'].includes(noteType))throw Error('笔记类型无效');return {schema:v2,noteType,chapter,page,excerpts:cleaned};}
 return {schema:v1,chapter,page,excerpts:cleaned};
}
export function encodeReadingNote(value){const result=JSON.stringify(readingNoteMetadata(value));if(result.length>10000)throw Error('本条笔记的摘录和章节信息过长，请拆成两条笔记');return result;}
export function decodeReadingNote(value){
 if(!value)return {...readingNoteMetadata(),noteType:'reflection'};
 try{const data=JSON.parse(value);if(![v1,v2].includes(data.schema))return null;const result=readingNoteMetadata(data);return result.schema===v1?{...result,noteType:result.excerpts.length?'excerpt':'reflection'}:result;}catch{return null;}
}
export function validateReadingNote(input){
 const book=text(input.book,200,'书名').trim().normalize('NFC');if(!book)throw Error('请先选择或输入书名');
 const reflection=text(input.reflection,1000000,'感想');
 const day=text(input.day,10,'日期');if(!/^\d{4}-\d{2}-\d{2}$/.test(day)||!Number.isFinite(Date.parse(day))||new Date(day).toISOString().slice(0,10)!==day)throw Error('请选择有效的记录日期');
 const annotation=encodeReadingNote(input);if(!reflection.trim()&&!decodeReadingNote(annotation).excerpts.length)throw Error('请先写下摘录或感想');
 return {book,reflection,day,annotation};
}
export function readingNoteDraft(record){
 const metadata=decodeReadingNote(record.annotation);if(!metadata)throw Error('这条笔记包含其他格式的备注，请先在素材页核对');
 return {id:record.id,revision:record.revision,book:record.title,day:record.contentDay??'',reflection:record.markdown??record.body??'',noteType:metadata.noteType??'reflection',chapter:metadata.chapter,page:metadata.page,excerpts:metadata.excerpts,baseline:{markdown:record.markdown??record.body??'',sources:record.sources??[]}};
}

// Tool writes use the same portable representation as the editor. Merge only
// explicitly supplied metadata fields; a supplied excerpts array replaces it.
export function readingNoteFields(input,current=null){
 const {readingNote,...fields}=input;
 const kind=fields.kind??current?.kind;
 if(readingNote!==undefined&&kind!=='reading_note')throw Error('readingNote 仅适用于读书笔记');
 if(kind!=='reading_note')return fields;
 const book=text(fields.title??current?.title??'',200,'书名').trim().normalize('NFC');
 if(!book)throw Error('读书笔记需要书名 title');
 if(fields.title!==undefined||!current)fields.title=book;
 if(fields.body!==undefined)text(fields.body,1000000,'感想');
 if(readingNote!==undefined&&fields.annotation!==undefined)throw Error('readingNote 与 annotation 不能同时提交');
 if(readingNote!==undefined){
  if(!readingNote||typeof readingNote!=='object'||Array.isArray(readingNote)||Object.keys(readingNote).some(k=>!['chapter','page','excerpts','noteType'].includes(k)))throw Error('无效的 readingNote 字段');
  const previous=decodeReadingNote(current?.annotation);
  if(!previous)throw Error('已有备注格式无法识别，请先核对，不能覆盖');
  fields.annotation=encodeReadingNote({...previous,...readingNote,...(readingNote.noteType!==undefined?{schema:v2}:{})});
 }else if(fields.annotation!==undefined||!current||current.kind!=='reading_note'){
  const metadata=decodeReadingNote(fields.annotation??current?.annotation);
  if(!metadata)throw Error('读书笔记备注格式无效，请使用 readingNote');
  fields.annotation=encodeReadingNote(metadata);
 }
 const metadata=decodeReadingNote(fields.annotation??current?.annotation);const body=fields.body??current?.body??'';
 if(metadata&&metadata.excerpts.length>1&&(!current||(decodeReadingNote(current.annotation)?.excerpts.length??0)<=1))throw Error('每条读书笔记只能包含一条划线，请逐条保存');
 if(metadata&&!body.trim()&&!metadata.excerpts.length)throw Error('请先写下摘录或感想');
 return fields;
}
export const readingNoteInfo=row=>row.kind==='reading_note'?{readingNote:decodeReadingNote(row.annotation)}:{};
