import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {join,resolve} from 'node:path';
import {writeFile} from 'node:fs/promises';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {startExternalServer} from '../../integration/http-server.mjs';

export async function checkExplorationInterop({root,store,library,source,write,read,phone}){
 const server=await startExternalServer({store,root,command:'test-bridge',skillPath:'test-skill'});
 const client=new Client({name:'three-client-acceptance',version:'1.0.0'});
 try{
  const tokenFile=join(root,'interop-token');
  const issued=store.externalClientCreate({name:'联调',scopes:['read','create','update']});
  await writeFile(tokenFile,issued.token,{mode:0o600});
  const env={...process.env,SHIWEN_ROOT_DIR:root,SHIWEN_TOKEN_FILE:tokenFile};delete env.SHIWEN_TOKEN;
  await client.connect(new StdioClientTransport({command:process.execPath,args:[resolve('integration/cli.mjs'),'mcp'],env,stderr:'pipe'}));
  async function mcp(method,args={}){
   const r=await client.callTool({name:'shiwen_'+method,arguments:args});
   assert.ok(!r.isError,r.content[0].text);return JSON.parse(r.content[0].text);
  }
  const get=id=>mcp('exploration_read',{expectedLibraryId:library,questionId:id});
  const mutate=(method,args)=>mcp(method,{expectedLibraryId:library,requestId:randomUUID(),...args});
  const ref={recordId:source,revision:1};
  const suggest=(text,sources)=>write('suggest',{suggestions:[{externalItemId:randomUUID(),text,type:'explore',sources}]}).items[0];
  const review=(id,action,args={})=>write('review',{questionId:id,expectedRevision:read(id).revision,action,...args});
  const left=suggest('我该怎样安排散步？',[ref]).questionId;
  const right=suggest('我该怎样安排散步时间？',[ref]).questionId;
  assert.ok(read(left).possibleDuplicates.some(row=>row.questionId===right));
  const merged=review(left,'merge',{targetQuestionId:right,expectedTargetRevision:read(right).revision});
  assert.equal((await get(left)).questionId,right);
  await phone('interopMerged',{left,right});
  const previous=merged.mergedQuestions.find(x=>x.questionId===left);
  await mutate('exploration_review',{questionId:left,expectedRevision:previous.revision,action:'undo_merge',
   targetQuestionId:right,expectedTargetRevision:merged.revision,decisionId:previous.decisionId});
  assert.equal(read(left).questionId,left);
  function placement(id,period){
   const q=read(id),p=q.placements[period];
   return {questionId:id,expectedRevision:q.revision,period,periodKey:p.key,expectedPlacementRevision:p.revision};
  }
  write('place',{...placement(right,'day'),action:'pin',accept:true});
  write('place',{...placement(right,'week'),action:'pin'});
  await mutate('exploration_place',{...placement(right,'week'),action:'unpin'});
  const unresolved=await mutate('save',{kind:'idea',origin:'personal',body:'一条待核对出处的材料。',suggestions:[{externalItemId:randomUUID(),text:'这件往事记在哪篇？',
   type:'follow_up',sources:[{externalSourceId:'unmapped-source'}]}]});
  const reviewId=unresolved.items[0].reviewItemId;
  await phone('interopDecisions',{left,right,reviewId});
  assert.equal(suggest('我该怎样安排散步？',[ref]).questionId,left);
  for(const q of [read(left),await get(left)])assert.ok(!q.possibleDuplicates.some(x=>x.questionId===right));
  for(const q of [read(right),await get(right)])assert.deepEqual([q.placements.day.pinned,q.placements.week.pinned],[true,false]);
  const resolved=await mcp('exploration_read',{expectedLibraryId:library,reviewItemId:reviewId});
  const linked=resolved.resolution.questionId;assert.equal(read(linked).sources[0].recordId,source);
  const note=await mutate('save',{kind:'reading_note',origin:'personal',title:'散步的笔记',body:'我也想去看看。',
   readingNote:{excerpts:[{text:'走进树林。'}]}});
  const mixed=suggest('树林里的路怎么样？',[{recordId:note.id,revision:note.revision}]).questionId;
  review(mixed,'accept');
  const settings=await mcp('recommendation_settings');
  await mutate('recommendation_settings',{revision:settings.revision,enabled:true});
  const weekly=async()=>{await mutate('recommendation_refresh',{});return (await mcp('recommendation_list',{view:'week'})).items;};
  assert.ok(!(await weekly()).some(x=>x.questionId===mixed));
  review(mixed,'confirm_personal_context',{recordId:note.id,sourceRevision:note.revision});
  assert.ok((await weekly()).some(x=>x.questionId===mixed));
  for(const q of [read(mixed),await get(mixed)])assert.equal(q.sources[0].confirmed,true);
  await phone('interopFinal',{left,right,linked,mixed,note:note.id});
  return {left,right,linked,mixed};
 }finally{await client.close();await server.close();}
}
