import {parentPort,workerData} from 'node:worker_threads';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {Tokenizer} from '@huggingface/tokenizers';
import * as ort from 'onnxruntime-node';
const read=async name=>JSON.parse(await readFile(join(workerData.directory,name),'utf8'));
const tokenizer=new Tokenizer(await read('tokenizer.json'),await read('tokenizer_config.json'));
const session=await ort.InferenceSession.create(join(workerData.directory,'model.onnx'),{executionProviders:['cpu'],intraOpNumThreads:2,interOpNumThreads:1});
const queue=[];let running=false;
parentPort.postMessage({ready:true});
parentPort.on('message',job=>{queue.push(job);queue.sort((a,b)=>(a.priority==='query'?0:1)-(b.priority==='query'?0:1));void run();});
async function run(){if(running)return;running=true;while(queue.length){const job=queue.shift();try{
 if(job.type==='count')parentPort.postMessage({id:job.id,result:tokenizer.encode(job.text).ids.length});
 else {
  job.vectors??=[];const text=job.texts[job.vectors.length];
  if(text!==undefined){const ids=tokenizer.encode(text).ids;if(ids.length>512)throw Error('搜索文本过长，请缩短后重试');const toTensor=v=>new ort.Tensor('int64',BigInt64Array.from(v,BigInt),[1,ids.length]);const input={input_ids:toTensor(ids),attention_mask:toTensor(ids.map(()=>1))};if(session.inputNames.includes('token_type_ids'))input.token_type_ids=toTensor(ids.map(()=>0));const output=await session.run(input);const raw=output.last_hidden_state??Object.values(output)[0];const data=raw.data,dimension=raw.dims.at(-1),vector=Array.from(data.slice(0,dimension));const norm=Math.hypot(...vector);if(!norm)throw Error('模型向量无效');job.vectors.push(vector.map(v=>v/norm));}
  if(job.vectors.length===job.texts.length)parentPort.postMessage({id:job.id,result:job.vectors});else {queue.push(job);await new Promise(resolve=>setImmediate(resolve));queue.sort((a,b)=>(a.priority==='query'?0:1)-(b.priority==='query'?0:1));}
 }
 }catch(error){parentPort.postMessage({id:job.id,error:String(error.message??error)});}}
 running=false;
}
