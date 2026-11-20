// Reproducible, synthetic-content benchmark. Requires already downloaded,
// checksum-verified real model assets; never touches the user's library.
// Usage: node scripts/benchmark-pc-search.mjs /absolute/model-parent-directory
import {cpus,totalmem,freemem,platform,release,arch,tmpdir} from 'node:os';
import {mkdtemp,rm,mkdir,link,copyFile} from 'node:fs/promises';
import {join,resolve,isAbsolute} from 'node:path';
import {performance} from 'node:perf_hooks';
import {DatabaseSync} from 'node:sqlite';
import {createModel,MODEL_VERSION,MODEL_FILES} from '../plugins/library/src/search/model.mjs';
import {createContentSearch} from '../plugins/library/src/search/service.mjs';
import {createStore} from '../plugins/library/legacy/store.mjs';

const modelDirectory=process.argv[2];
if(!modelDirectory||!isAbsolute(modelDirectory))throw Error('Pass the absolute directory containing the prepared bge-small-zh-v1.5 model directory');
const model=createModel({directory:resolve(modelDirectory)});
if(!await model.available())throw Error('Model assets missing or invalid; prepare them separately before benchmarking');
await model.close();
const directory=await mkdtemp(join(tmpdir(),'shiwen-search-benchmark-'));
let service,library,peakRss=process.memoryUsage.rss();
const sampler=setInterval(()=>{peakRss=Math.max(peakRss,process.memoryUsage.rss());},100);sampler.unref();
const clock=()=>performance.now();
const elapsed=start=>Math.round((clock()-start)*100)/100;
try{
 const target=join(directory,'search-model','bge-small-zh-v1.5');await mkdir(target,{recursive:true});
 for(const file of MODEL_FILES){const from=join(modelDirectory,'bge-small-zh-v1.5',file.name),to=join(target,file.name);try{await link(from,to);}catch(e){if(e.code!=='EXDEV')throw e;await copyFile(from,to);}}
 const libraryDir=join(directory,'library');await mkdir(libraryDir);library=createStore(join(libraryDir,'library.sqlite'));library.paths={root:directory,library:libraryDir};
 const populateStart=clock();for(let i=0;i<5000;i++)library.save({kind:'freewrite',title:`虚构记录 ${i}`,body:`第 ${i} 个虚构样本：反复思考后开始尝试，用小小的行动推动事情。`});const populateMs=elapsed(populateStart);
 const coldStart=clock();service=createContentSearch({library});await service.enable();const coldModelMs=elapsed(coldStart);
 const buildStart=clock();
 while(true){const s=service.status();if(s.state==='failed')throw Error(s.error?.message||'index failed');if(s.state==='ready')break;if(clock()-buildStart>3600000)throw Error('Index build exceeded one hour');await new Promise(r=>setTimeout(r,250));}
 const indexMs=elapsed(buildStart);
 const inspect=new DatabaseSync(join(libraryDir,'search','search.sqlite'),{readOnly:true});const chunks=inspect.prepare('SELECT count(*) AS n FROM chunks').get().n;inspect.close();
 if(chunks!==10000)throw Error(`Expected 10000 chunks, got ${chunks}`);
 const queries=['从犹豫到行动','以前如何开始做事','慢慢尝试的经历','怎样迈出第一步','行动比反复考虑重要'];
 const query=async text=>service.search({query:text,mode:'semantic',scope:'materials',offset:0,limit:20});
 const firstStart=clock();await query(queries[0]);const firstQueryMs=elapsed(firstStart);
 for(const value of queries)await query(value);
 const times=[];for(let n=0;n<30;n++){const start=clock();await query(queries[n%queries.length]);times.push(elapsed(start));}
 times.sort((a,b)=>a-b);peakRss=Math.max(peakRss,process.memoryUsage.rss(),process.resourceUsage().maxRSS*1024);
 console.log(JSON.stringify({kind:'isolated-sqlite-library-service-real-onnx',timestamp:new Date().toISOString(),hardware:{cpu:cpus()[0]?.model,logicalCpus:cpus().length,totalMemoryBytes:totalmem(),freeMemoryBytesAtEnd:freemem(),platform:platform(),release:release(),arch:arch(),node:process.version},modelVersion:MODEL_VERSION,onnxThreads:2,records:5000,chunks,populateMs,coldModelMs,indexMs,firstQueryMs,warmQueryMs:{count:times.length,p50:times[Math.ceil(times.length*.5)-1],p95:times[Math.ceil(times.length*.95)-1],max:times.at(-1)},peakProcessRssBytes:peakRss,notes:['Synthetic content in an isolated real SQLite library; actual content service and ONNX CPU inference, without HTTP transport.','Cold model means worker/model initialization with already cached files, not OS page-cache cold.','Peak RSS includes worker threads; package size and HTTP transport are not measured.']},null,2));
}finally{clearInterval(sampler);if(service)await service.close();library?.close();await rm(directory,{recursive:true,force:true});}
