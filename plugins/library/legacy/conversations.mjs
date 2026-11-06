import {randomUUID} from 'node:crypto';
import {plainDoc} from './content.mjs';
import {validDay} from './wiki-import.mjs';
const now=()=>new Date().toISOString();
const validate=(s,max=200)=>{if(typeof s!=='string'||s.length>max)throw new Error('输入格式或长度不正确');return s.trim();};
export const conversationDDL=`
CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY,title TEXT NOT NULL,kind TEXT NOT NULL,record TEXT,created TEXT NOT NULL,updated TEXT NOT NULL,archived INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS conversation_sources(thread TEXT NOT NULL REFERENCES conversations(id),record TEXT NOT NULL REFERENCES records(id),PRIMARY KEY(thread,record));
CREATE TABLE IF NOT EXISTS conversation_drafts(thread TEXT PRIMARY KEY REFERENCES conversations(id),body TEXT NOT NULL,updated TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS record_sources(id TEXT PRIMARY KEY,record TEXT NOT NULL REFERENCES records(id),source_record TEXT,source_message TEXT,source_role TEXT NOT NULL,source_revision INTEGER,excerpt TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS record_dates(record TEXT PRIMARY KEY REFERENCES records(id),day TEXT,basis TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS agent_actions(id TEXT PRIMARY KEY,thread TEXT NOT NULL,message TEXT NOT NULL,kind TEXT NOT NULL,status TEXT NOT NULL,result TEXT NOT NULL,created TEXT NOT NULL,updated TEXT NOT NULL);
`;
export function migrateConversations(db){
 db.exec(conversationDDL);
 const rows=db.prepare(`SELECT thread,MIN(created) AS created,MAX(created) AS updated FROM (SELECT thread,created FROM messages UNION ALL SELECT thread,created FROM runs) GROUP BY thread`).all();
 const insert=db.prepare('INSERT OR IGNORE INTO conversations VALUES(?,?,?,?,?,?,0)');
 for(const row of rows){const r=db.prepare('SELECT id,title,kind FROM records WHERE id=?').get(row.thread);insert.run(row.thread,row.thread==='global'?'历史对话':r?.title??'历史对话',r?.kind==='article'?'article':r?'material':'chat',r?.id??null,row.created??now(),row.updated??now());}
}
export function conversationStore(db,get,save){
 const one=id=>db.prepare('SELECT * FROM conversations WHERE id=?').get(id);
 const requireConversation=id=>{const c=one(validate(id,100));if(!c)throw new Error('会话不存在');return c;};
 function create({title='',record=null}={}){title=validate(title);if(record){const r=get(record);if(!r||r.deleted)throw new Error('关联记录不存在');}const id='chat:'+randomUUID(),at=now();db.prepare('INSERT INTO conversations VALUES(?,?,?,?,?,?,0)').run(id,title||'新对话',record?'material':'chat',record,at,at);return one(id);}
 function ensure({thread}){const old=one(thread);if(old)return old;const r=get(thread);if(thread!=='global'&&(!r||r.deleted))throw new Error('会话不存在');const at=now();db.prepare('INSERT INTO conversations VALUES(?,?,?,?,?,?,0)').run(thread,thread==='global'?'历史对话':r.title,r?.kind==='article'?'article':r?'material':'chat',r?.id??null,at,at);return one(thread);}
 function sources({thread,ids}){requireConversation(thread);if(!Array.isArray(ids)||ids.length>100)throw new Error('关联素材格式不正确');return db.transaction(()=>{db.prepare('DELETE FROM conversation_sources WHERE thread=?').run(thread);for(const id of new Set(ids)){const r=get(id);if(!r||r.deleted||r.kind==='article')throw new Error('关联素材不存在');db.prepare('INSERT INTO conversation_sources VALUES(?,?)').run(thread,id);}return true;})();}
 function saveMessage({thread,messageId,kind='ai',title='',operationId}){requireConversation(thread);validate(operationId,150);if(!operationId)throw new Error('操作标识不能为空');return db.transaction(()=>{
  const prior=db.prepare('SELECT * FROM agent_actions WHERE id=?').get(operationId);if(prior){if(prior.thread!==thread||prior.message!==messageId||prior.kind!=='save_message')throw new Error('操作标识已被使用');return JSON.parse(prior.result);}
  const m=db.prepare("SELECT * FROM messages WHERE id=? AND thread=? AND status='done'").get(messageId,thread);if(!m||!m.body.trim())throw new Error('消息不存在或尚未完成');
  if(!['journal','freewrite','idea','ai'].includes(kind))throw new Error('无效记录类型');
  const origin=m.role==='user'?'personal':'ai';const r=save({kind,origin,title:validate(title)||m.body.split('\n')[0].slice(0,32),doc:plainDoc(m.body,origin),reason:'保存对话'}, {inTransaction:true,archive:true});
  db.prepare('INSERT INTO record_sources VALUES(?,?,?,?,?,?,?)').run(randomUUID(),r.id,null,m.id,m.role,null,m.body);
  db.prepare('INSERT INTO record_dates VALUES(?,?,?)').run(r.id,null,'对话归档，内容日期待确认');
  const result={id:r.id,title:r.title,kind:r.kind};const at=now();db.prepare('INSERT INTO agent_actions VALUES(?,?,?,?,?,?,?,?)').run(operationId,thread,messageId,'save_message','done',JSON.stringify(result),at,at);return result;
 })();}
 return {
  conversations:({archived=false}={})=>db.prepare('SELECT * FROM conversations WHERE archived=? ORDER BY updated DESC,rowid DESC').all(archived?1:0),
  conversationCreate:create,conversationEnsure:ensure,
  conversationUpdate:({thread,title,archived})=>{const c=requireConversation(thread);const next=title===undefined?c.title:validate(title);if(!next)throw new Error('请输入对话标题');if(archived!==undefined&&typeof archived!=='boolean')throw new Error('归档状态无效');db.prepare('UPDATE conversations SET title=?,archived=?,updated=? WHERE id=?').run(next,archived===undefined?c.archived:Number(archived),now(),thread);return one(thread);},
  conversationSources:({thread})=>{requireConversation(thread);return db.prepare('SELECT record FROM conversation_sources WHERE thread=?').all(thread).map(x=>x.record);},conversationSourcesSave:sources,
  conversationDraft:({thread,body})=>{requireConversation(thread);if(body===undefined)return db.prepare('SELECT body FROM conversation_drafts WHERE thread=?').get(thread)?.body??'';validate(body,30000);db.prepare('INSERT INTO conversation_drafts VALUES(?,?,?) ON CONFLICT(thread) DO UPDATE SET body=excluded.body,updated=excluded.updated').run(thread,body,now());return true;},
  saveMessageRecord:saveMessage,
  saveConversationRecord:({thread,operationId})=>{const conversation=requireConversation(thread);validate(operationId,150);if(!operationId)throw new Error('操作标识不能为空');return db.transaction(()=>{
   const prior=db.prepare('SELECT * FROM agent_actions WHERE id=?').get(operationId);if(prior){if(prior.thread!==thread||prior.kind!=='save_conversation')throw new Error('操作标识已被使用');return JSON.parse(prior.result);}
   const messages=db.prepare("SELECT * FROM messages WHERE thread=? AND status='done' AND body!='' ORDER BY created,rowid").all(thread);if(!messages.length)throw new Error('没有可保存的完整消息');
   const content=[];for(const m of messages){const label=m.role==='user'?'用户':'AI';content.push(...plainDoc(label, 'unknown').content,...plainDoc(m.body,m.role==='user'?'personal':'ai').content);}
   const r=save({kind:'ai',origin:'ai',title:conversation.title,doc:{type:'doc',content},reason:'保存完整对话'}, {inTransaction:true,archive:true});
   const insert=db.prepare('INSERT INTO record_sources VALUES(?,?,?,?,?,?,?)');for(const m of messages)insert.run(randomUUID(),r.id,null,m.id,m.role,null,m.body);
   db.prepare('INSERT INTO record_dates VALUES(?,?,?)').run(r.id,null,'对话归档，内容日期待确认');const result={id:r.id,title:r.title,kind:r.kind},at=now();db.prepare('INSERT INTO agent_actions VALUES(?,?,?,?,?,?,?,?)').run(operationId,thread,'','save_conversation','done',JSON.stringify(result),at,at);return result;
  })();},
  agentSaveMessage:({thread,messageId,sourceMessageId,kind='ai'})=>{
   const request=db.prepare("SELECT body FROM messages WHERE id=? AND thread=? AND role='user' AND status='done'").get(messageId,thread);
   if(!request)throw new Error('缺少当前用户请求');
   if(sourceMessageId===messageId)throw new Error('请选择需要保存的历史消息');
   const command=request.body.trim();
   if(!/^(?:请|帮我|请帮我)?(?:把|将)(?:刚才|上面|上一条|这段|这条|你的回复|我的话)[^。！？!?]{0,80}(?:记下来|保存|保存下来|存下来)[。！!]?$/u.test(command)||/不要|别|不用|如果|假如|引用/u.test(command))throw new Error('保存范围或意图不明确，请请用户点击消息下的保存按钮');
   return saveMessage({thread,messageId:sourceMessageId,kind,operationId:`request:${messageId}:source:${sourceMessageId}`});
  },
  agentCreateArticle:({thread,messageId,sourceMessageId,title=''})=>{
   requireConversation(thread);if(sourceMessageId===messageId)throw new Error('请选择需要整理的历史消息');const request=db.prepare("SELECT body FROM messages WHERE id=? AND thread=? AND role='user' AND status='done'").get(messageId,thread);
   if(!request||!/^(?:请|帮我|请帮我)?(?:把|将)(?:刚才|上面|上一条|这段|这条|你的回复|我的话)[^。！？!?]{0,80}(?:写成文章|转为文章|创建文章|建立文章项目)[。！!]?$/u.test(request.body.trim())||/不要|别|不用|如果|假如|引用/u.test(request.body))throw new Error('创建文章的意图或范围不明确，请点击消息下的转为文章');
   return db.transaction(()=>{const operationId=`article-request:${messageId}`;const previous=db.prepare('SELECT * FROM agent_actions WHERE id=?').get(operationId);if(previous)return JSON.parse(previous.result);
    const m=db.prepare("SELECT * FROM messages WHERE id=? AND thread=? AND status='done'").get(sourceMessageId,thread);if(!m||!m.body.trim())throw new Error('来源消息不存在或尚未完成');const origin=m.role==='user'?'personal':'ai';
    const source=save({kind:origin==='personal'?'freewrite':'ai',origin,title:m.body.split('\n')[0].slice(0,32),doc:plainDoc(m.body,origin),reason:'对话转文章'}, {inTransaction:true,archive:true});
    db.prepare('INSERT INTO record_sources VALUES(?,?,?,?,?,?,?)').run(randomUUID(),source.id,null,m.id,m.role,null,m.body);
    db.prepare('INSERT INTO record_dates VALUES(?,?,?)').run(source.id,null,'对话归档，内容日期待确认');
    const article=save({kind:'article',title:validate(title)||'未命名文章',body:'',sourceIds:[source.id],reason:'对话转文章'}, {inTransaction:true});
    const result={id:article.id,title:article.title,sourceId:source.id},at=now();db.prepare('INSERT INTO agent_actions VALUES(?,?,?,?,?,?,?,?)').run(operationId,thread,messageId,'create_article','done',JSON.stringify(result),at,at);return result;
   })();
  },
  recentMessages:({thread})=>{requireConversation(thread);return db.prepare("SELECT id,role,body,created FROM messages WHERE thread=? AND status='done' ORDER BY created DESC,rowid DESC LIMIT 8").all(thread).reverse();},
  recordDate:({id,day})=>{const r=get(id);if(!r||r.deleted)throw new Error('记录不存在');if(day===undefined)return db.prepare('SELECT * FROM record_dates WHERE record=?').get(id)??null;if(day!==null&&validDay(day)!==day)throw new Error('请输入有效日期');if(!db.prepare('SELECT 1 FROM record_dates WHERE record=?').get(id))throw new Error('该记录不能设置归档日期');db.prepare("UPDATE record_dates SET day=?,basis='人工确认' WHERE record=?").run(day,id);return db.prepare('SELECT * FROM record_dates WHERE record=?').get(id);},
  recordSources:({id})=>db.prepare('SELECT s.*,m.thread FROM record_sources s LEFT JOIN messages m ON m.id=s.source_message WHERE s.record=?').all(id),
  touchConversation:({thread})=>{requireConversation(thread);db.prepare('UPDATE conversations SET updated=? WHERE id=?').run(now(),thread);return true;},
 };
}
