export const inject=['systemPrompt','shiwenLibrary'];
export function personalContext(state){
 const lines=['以下是用户可管理的个人助手设置，用户当前明确表达与历史记忆冲突时，以当前表达为准。',`身份：${state.identity.body}`,`交流方式：${state.soul.body}`];
 let budget=1800;
 for(const memory of state.memories.filter(row=>row.status==='active'&&row.scope==='global')){
  const text=String(memory.body).trim();if(!text||text.length>budget)continue;lines.push(`已确认记忆：${text}`);budget-=text.length;
 }
 return lines.join('\n');
}
export function apply(ctx){ctx.effect(()=>ctx.systemPrompt.section({name:'shiwen-personal-context',order:70,text:()=>personalContext(ctx.shiwenLibrary.agentState())}));}
