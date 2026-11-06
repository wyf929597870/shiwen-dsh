import {randomUUID} from 'node:crypto';
import {DEFAULT_IDENTITY,DEFAULT_SOUL,PREVIOUS_IDENTITY,PREVIOUS_SOUL,PERSONA_MAX_BYTES} from '../src/persona.mjs';
export {DEFAULT_IDENTITY,DEFAULT_SOUL};
export const DEFAULT_POLICY={contextWindow:32000,outputTokens:4000,autoSummary:true};
const stamp=()=>new Date().toISOString();
const text=(v,max=10000)=>{if(typeof v!=='string'||v.length>max)throw new Error('内容格式或长度不正确');return v.trim();};
export const agentDDL=`
CREATE TABLE IF NOT EXISTS agent_documents(name TEXT NOT NULL,scope TEXT NOT NULL,body TEXT NOT NULL,revision INTEGER NOT NULL,updated TEXT NOT NULL,PRIMARY KEY(name,scope));
CREATE TABLE IF NOT EXISTS agent_sessions(thread TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS memory_events(id TEXT PRIMARY KEY,memory TEXT NOT NULL,action TEXT NOT NULL,before_json TEXT NOT NULL,after_json TEXT NOT NULL,at TEXT NOT NULL);
`;
export const memoryDefaults={category:'memory',status:'active',source:'manual',evidence:'',revision:1};
export function createAgentStore(db,get){
  // Upgrade untouched shipped defaults; preserve any customized identity or style.
  db.transaction(()=>{
    for(const [name,previous,next] of [['IDENTITY.md',PREVIOUS_IDENTITY,DEFAULT_IDENTITY],['SOUL.md',PREVIOUS_SOUL,DEFAULT_SOUL]]){
      db.prepare('UPDATE agent_documents SET body=?,revision=revision+1,updated=? WHERE name=? AND scope=? AND body=?').run(next,stamp(),name,'global',previous);
    }
  })();
  const all=()=>db.prepare('SELECT * FROM memories ORDER BY updated DESC,rowid DESC').all();
  const one=id=>db.prepare('SELECT * FROM memories WHERE id=?').get(id);
  const scopeCheck=scope=>{text(scope,100);if(scope!=='global'){const r=get(scope);if(!r||r.deleted||r.kind!=='article')throw new Error('请选择有效文章项目');}};
  const audit=(before,after,action)=>db.prepare('INSERT INTO memory_events VALUES(?,?,?,?,?,?)').run(randomUUID(),after?.id??before.id,action,JSON.stringify(before??null),JSON.stringify(after??null),stamp());
  function writeMemory(input,{status='active',source='manual',evidence=''}={}){
    const body=text(input.body);if(!body)throw new Error('请填写记忆内容');const scope=input.scope??'global';scopeCheck(scope);
    const category=input.category??(scope==='global'?'memory':'project');
    if(!['user','memory','project'].includes(category)||((scope!=='global')!==(category==='project')))throw new Error('记忆类型与范围不一致');
    const old=input.id?one(input.id):null;if(input.id&&!old)throw new Error('记忆不存在');
    if(old&&input.revision!==old.revision)throw new Error('记忆已变更，请刷新后再保存');
    const duplicate=all().find(m=>m.id!==input.id&&m.scope===scope&&m.category===category&&m.body===body&&m.status===status);if(duplicate)return duplicate;
    const at=stamp(),id=old?.id??randomUUID();
    db.prepare(`INSERT INTO memories(id,scope,body,created,updated,category,status,source,evidence,revision) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET scope=excluded.scope,body=excluded.body,updated=excluded.updated,category=excluded.category,status=excluded.status,source=excluded.source,evidence=excluded.evidence,revision=excluded.revision`).run(id,scope,body,old?.created??at,at,category,status,source,evidence,(old?.revision??0)+1);
    const result=one(id);audit(old,result,old?'edit':'add');return result;
  }
  const document=(name,scope='global')=>db.prepare('SELECT * FROM agent_documents WHERE name=? AND scope=?').get(name,scope)??{name,scope,body:name==='SOUL.md'?DEFAULT_SOUL:name==='IDENTITY.md'?DEFAULT_IDENTITY:name==='policy'?JSON.stringify(DEFAULT_POLICY):'',revision:0,updated:null};
  function agentDocumentSave(input){return db.transaction(()=>{
    const {name,scope='global',revision}=input;scopeCheck(scope);
    if(!['IDENTITY.md','SOUL.md','PROJECT.md','policy'].includes(name)||(name==='PROJECT.md')!==(scope!=='global'))throw new Error('无效配置文件');
    let body=text(input.body,20000);
    if(name==='policy'){const p=JSON.parse(body);if(!Number.isInteger(p.contextWindow)||p.contextWindow<16000||p.contextWindow>200000||!Number.isInteger(p.outputTokens)||p.outputTokens<1000||p.outputTokens>8000||p.outputTokens>p.contextWindow/3||typeof p.autoSummary!=='boolean')throw new Error('上下文窗口须为 16000–200000，输出预算须为 1000–8000 且不超过窗口的三分之一');body=JSON.stringify({contextWindow:p.contextWindow,outputTokens:p.outputTokens,autoSummary:p.autoSummary});}
    if(['SOUL.md','IDENTITY.md'].includes(name)&&(!body||Buffer.byteLength(body,'utf8')>PERSONA_MAX_BYTES))throw new Error('身份和交流方式不能为空，且不能超过 12000 字节');
    const old=document(name,scope);if(old.revision!==revision)throw new Error('配置已变更，请刷新后再保存');
    db.prepare('INSERT INTO agent_documents VALUES(?,?,?,?,?) ON CONFLICT(name,scope) DO UPDATE SET body=excluded.body,revision=excluded.revision,updated=excluded.updated').run(name,scope,body,revision+1,stamp());return document(name,scope);
  })();}
  return {
    agentState:()=>({documents:db.prepare('SELECT * FROM agent_documents').all(),identity:document('IDENTITY.md'),soul:document('SOUL.md'),policy:document('policy'),memories:all().filter(m=>!['deleted','rejected'].includes(m.status)),events:db.prepare('SELECT * FROM memory_events ORDER BY at DESC,rowid DESC LIMIT 100').all().map(e=>({...e,before:JSON.parse(e.before_json),after:JSON.parse(e.after_json)}))}),
    agentDocumentSave,
    memorySave:input=>db.transaction(()=>writeMemory(input))(),
    memoryPropose:input=>db.transaction(()=>writeMemory(input,{status:'pending',source:'dsh-session',evidence:text(input.evidence,2000)}))(),
    memoryDelete:({id,revision})=>db.transaction(()=>{const old=one(id);if(!old)return true;if(revision!==undefined&&revision!==old.revision)throw new Error('记忆已变更');db.prepare("UPDATE memories SET status='deleted',revision=revision+1,updated=? WHERE id=?").run(stamp(),id);audit(old,one(id),'delete');return true;})(),
    memoryDecide:({id,revision,accept})=>db.transaction(()=>{const old=one(id);if(!old||old.status!=='pending'||old.revision!==revision)throw new Error('候选记忆已变更，请刷新');scopeCheck(old.scope);db.prepare('UPDATE memories SET status=?,revision=revision+1,updated=? WHERE id=?').run(accept?'active':'rejected',stamp(),id);audit(old,one(id),accept?'approve':'reject');return one(id);})(),
    // Worker cannot supply prompt/source/thread: the main process binds these to the active user turn.
    agentRemember:({body,category='memory',scope='global',evidence='',thread,messageId})=>db.transaction(()=>{
      const message=db.prepare("SELECT * FROM messages WHERE id=? AND thread=? AND role='user'").get(messageId,thread);
      if(!message)throw new Error('记忆缺少用户来源');
      if(scope!=='global'&&scope!==thread)throw new Error('只能记录当前文章的要求');
      text(evidence,2000);if(!evidence||!message.body.includes(evidence))throw new Error('请引用当前用户消息中的原话作为记忆依据');
      const explicit=/^(?:请|帮我|请帮我)?(?:记住|保存为记忆)[：:,，\s]/u.test(message.body.trim())&&!/不要记|别记|不用记/.test(message.body);
      // Direct saves require a standalone explicit command and verbatim content; inferred paraphrases remain proposals.
      const requested=message.body.trim().replace(/^(?:请|帮我|请帮我)?(?:记住|保存为记忆)[：:,，\s]+/u,'').trim();
      if(/这篇|本篇|本文|当前文章|这次文章/.test(body)){if(get(thread)?.kind!=='article')throw new Error('文章专属要求请在对应文章讨论中保存');scope=thread;category='project';}
      const direct=explicit&&text(body)===requested&&evidence.trim()===requested;
      const result=writeMemory({body,category,scope},{status:direct?'active':'pending',source:`message:${message.id}`,evidence});
      return {id:result.id,status:result.status,message:result.status==='active'?'记忆已保存':'已提出候选记忆，需用户在记忆管理中确认后才会注入'};
    })(),
    agentUpdateMemory:({thread,messageId,id,revision,body,forget=false})=>db.transaction(()=>{
      const message=db.prepare("SELECT body FROM messages WHERE id=? AND thread=? AND role='user'").get(messageId,thread);const old=one(id);
      if(!message||!old||old.status!=='active'||old.revision!==revision)throw new Error('记忆不存在或版本已改变');
      if(old.scope!=='global'&&old.scope!==thread)throw new Error('只能修改当前范围的记忆');
      const command=message.body.trim(),newBody=forget?'':text(body,2000);
      const expected=forget?`忘记「${old.body}」`:`把记忆「${old.body}」改为「${newBody}」`;
      if(!newBody&&!forget||command!==expected)throw new Error('请在记忆管理中确认具体修改目标');
      db.prepare('UPDATE memories SET body=?,status=?,source=?,evidence=?,revision=revision+1,updated=? WHERE id=?').run(forget?old.body:newBody,forget?'deleted':'active',`message:${messageId}`,command,stamp(),id);const updated=one(id);audit(old,updated,forget?'delete':'edit');return {id,status:updated.status,body:updated.body,revision:updated.revision};
    })(),
    agentSession:({thread})=>{const row=db.prepare('SELECT value FROM agent_sessions WHERE thread=?').get(thread);return row?JSON.parse(row.value):{};},
    agentSessionSave:({thread,value})=>{text(thread,100);db.prepare('INSERT INTO agent_sessions VALUES(?,?) ON CONFLICT(thread) DO UPDATE SET value=excluded.value').run(thread,JSON.stringify(value));return true;},
    sessionSearch:({query,thread,allThreads=false})=>{text(query,100);if(!query.trim())return [];const rows=db.prepare(`SELECT id,thread,role,body,created FROM messages WHERE status='done' AND body LIKE ? ESCAPE '\\' ${allThreads?'':'AND thread=?'} ORDER BY created DESC,rowid DESC LIMIT 8`).all('%'+query.replace(/[\\%_]/g,'\\$&')+'%',...(allThreads?[]:[thread]));return rows.map(r=>{const at=r.body.toLowerCase().indexOf(query.toLowerCase());return {...r,body:r.body.slice(Math.max(0,at-120),Math.max(0,at-120)+650)};});},
  };
}
