import {join,resolve,dirname} from 'node:path';
import {homedir} from 'node:os';
import Schema from '@deepseek-ai/schemastery';
import {createStore} from '../legacy/store.mjs';
import {acquireOwnership} from './ownership.mjs';
import {createContentSearch} from './search/service.mjs';
export const Config=Schema.object({dataDir:Schema.string().description('资料库目录；留空时使用当前 DSH profile 的拾文目录。')});
export function libraryPaths(ctx,config={},env=process.env){
  const profile=ctx.get?.('profileContext');
  const home=profile?.home??env.DSH_HOME??join(homedir(),'.dsh');
  const library=resolve(config.dataDir||env.SHIWEN_DATA_DIR||join(home,'shiwen',profile?.name??'default','library'));
  return {library,root:dirname(library)};
}
export function apply(ctx,config={}){
  const paths=libraryPaths(ctx,config);
  const release=acquireOwnership(paths.library);
  let store;
  try{store=createStore(join(paths.library,'library.sqlite'));}catch(error){release();throw error;}
  store.paths=paths;
  let search;
  try{search=createContentSearch({library:store});}catch(error){store.close();release();throw error;}
  store.contentSearch=search;
  const shutdown=new AbortController();
  store.generateAssist=async(system,input,signal)=>{
    const model=ctx.get('agentDefaultModel')?.currentSelection(),llm=ctx.get('llm');
    if(!model?.provider||!model.model||!llm)throw Error('请先在 DSH 设置中配置默认模型');
    let text='',complete=false;
    const callSignal=AbortSignal.any([AbortSignal.timeout(120000),shutdown.signal,...(signal?[signal]:[])]);
    const call=await llm.prepareCall(model,callSignal,(controls,info)=>{
      // Leave room for reasoning before the JSON, respecting smaller adapter defaults.
      if(info.defaultMaxTokens===undefined)return controls;
      return {...controls,maxTokens:Math.min(info.defaultMaxTokens,16384)};
    });
    for await(const chunk of call.stream({...call.config,system,signal:callSignal,messages:[{role:'user',content:[{type:'text',text:input}]}]})){
      if(chunk.type==='text-delta')text+=chunk.text;
      if(chunk.type==='finish'){
        complete=chunk.reason.kind==='stop';
        if(chunk.reason.kind==='max-tokens')throw Error('分析达到模型输出上限，推荐尚未生成。可降低默认模型的推理强度后重试');
        if(!complete){
          const reason=chunk.reason.failure?.code??chunk.reason.kind;
          throw Error('默认模型未完成分析（'+String(reason).slice(0,80)+'），请检查模型配置后重试');
        }
      }
    }
    if(!complete||!text.trim())throw Error('模型回复未完成，请重试');
    return text;
  };
  ctx.effect(()=>()=>shutdown.abort());
  ctx.effect(()=>()=>{void search.close();try{store.close();}finally{release();}});
  store.exploration.discovery.startLifecycle();
  ctx.provide('shiwenLibrary',store);
}
