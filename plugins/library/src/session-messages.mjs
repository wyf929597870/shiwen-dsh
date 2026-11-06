const textOf=message=>(message?.content??[]).filter(block=>block.type==='text').map(block=>block.text).join('\n');
export async function readSessionMessages(ctx,sessionId,signal){
  if(!sessionId||typeof sessionId!=='string'||sessionId.length>100)throw new Error('无效会话');
  const observation=await ctx.sessionQuery.observeSession(sessionId,{signal,projectionMode:'none'});
  try{return observation.events.flatMap(event=>{
    if(event.type==='user/message'&&event.data.source?.kind==='user')return [{id:event.data.id,role:'user',body:textOf(event.data)}];
    if(event.type==='assistant/message'&&!event.data.interrupted)return [{id:event.data.message.id,role:'assistant',body:textOf(event.data.message)}];
    return [];
  }).filter(message=>message.body.trim());}finally{observation[Symbol.dispose]();}
}
