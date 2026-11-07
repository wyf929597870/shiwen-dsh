import test from 'node:test';
import assert from 'node:assert/strict';
import {createManagementAdapter} from '../plugins/mobile/src/management-adapter.mjs';

function fixture(overrides={}) {
  const calls=[];
  const pluginManager={
    listBundles:async()=>[{name:'bundle'}],
    listPlugins:async()=>[{entryId:'entry'}],
    installBundle:async(spec,options)=>{calls.push(['installBundle',spec,options]);return {changed:true,application:'applied',stage:'install',target:spec};},
    cancelInstall:async id=>({status:'not-running',id}),
    setBundleEnabled:async(...args)=>({args}),
    setPluginEnabled:async(...args)=>({args}),
    removeBundle:async name=>({removed:name}),
  };
  const pluginMarket={
    listIndexes:async()=>[{url:'https://catalog.test/index.json'}],
    search:async(url,query)=>({url,query,entries:[]}),
  };
  const schedule={
    remoteList:async request=>({items:[],request}),catalog:async()=>[],
    view:async request=>({request}),remoteHistory:async request=>({request}),
    remoteCreate:async(request,signal)=>({request,signal:!!signal}),
    remoteEdit:async(request)=>{calls.push(['remoteEdit',request]);return {id:request.id,code:'schedule_conflict',expectedUpdatedAt:request.expectedUpdatedAt};},
    run:async(request)=>({request}),deleteInactive:async()=>({deleted:0}),
  };
  const services={pluginManager,pluginMarket,schedule,...overrides};
  const ctx={get:name=>services[name]};
  return {adapter:createManagementAdapter(ctx),calls};
}

test('capabilities list supported actions and unavailable services without making calls',async()=>{
  const ctx={get:name=>name==='schedule'?{catalog:async()=>[]}:undefined};
  const adapter=createManagementAdapter(ctx);
  const result=await adapter.execute('capabilities');
  assert.ok(result.data.supportedActions.includes('schedules.catalog'));
  assert.ok(!result.data.supportedActions.includes('plugins.listBundles'));
  assert.ok(result.data.unavailableServices.some(item=>item.service==='pluginManager'));
});

test('rejects unknown actions and malformed requests before host service calls',async()=>{
  const {adapter}=fixture();
  await assert.rejects(()=>adapter.execute('plugins.unknown'),{code:'INVALID_REQUEST'});
  await assert.rejects(()=>adapter.execute('plugins.removeBundle',{}),{code:'INVALID_REQUEST'});
  await assert.rejects(()=>adapter.execute('plugins.marketSearch',{url:'https://other.test/index.json',query:{offset:0,limit:10,sort:'relevance'}}),{code:'INVALID_REQUEST'});
  await assert.rejects(()=>adapter.execute('plugins.enableBundle',{name:'bundle',enabled:'false'}),{code:'INVALID_REQUEST'});
  await assert.rejects(()=>adapter.execute('plugins.install',{spec:'x',options:{requestId:'override'}}),{code:'INVALID_REQUEST'});
});

test('reads plugin inventory and only searches configured market indexes',async()=>{
  const {adapter}=fixture();
  assert.deepEqual((await adapter.execute('plugins.listBundles')).data,[{name:'bundle'}]);
  assert.deepEqual((await adapter.execute('plugins.listPlugins')).data,[{entryId:'entry'}]);
  const market=await adapter.execute('plugins.marketSearch',{url:'https://catalog.test/index.json',query:{offset:0,limit:10,sort:'relevance'}});
  assert.equal(market.data.url,'https://catalog.test/index.json');
});

test('plugin install is an explicit action with queryable state and cancellation',async()=>{
  const {adapter,calls}=fixture();
  const started=await adapter.execute('plugins.install',{spec:'example-bundle',installId:'test-install-1'});
  assert.deepEqual(started.data,{installId:'test-install-1',status:'running'});
  await new Promise(resolve=>setImmediate(resolve));
  const progress=await adapter.execute('plugins.installProgress',{installId:'test-install-1'});
  assert.equal(progress.data.status,'completed');
  assert.equal(progress.data.result.target,'example-bundle');
  assert.equal('packageResult' in progress.data.result,false);
  assert.equal(calls[0][0],'installBundle');
  assert.equal(calls[0][2].requestId,'test-install-1');
  assert.deepEqual((await adapter.execute('plugins.install',{spec:'example-bundle',installId:'test-install-1'})).data,{installId:'test-install-1',status:'completed'});
  await assert.rejects(()=>adapter.execute('plugins.install',{spec:'different-package',installId:'test-install-1'}),{code:'CONFLICT'});
  assert.equal((await adapter.execute('plugins.cancelInstall',{installId:'test-install-1'})).data.status,'not-running');
});

test('schedule edit preserves the Host optimistic concurrency token',async()=>{
  const {adapter,calls}=fixture();
  const request={id:'schedule-test',action:'update',patch:{active:false},expectedUpdatedAt:'2026-11-06T12:00:00.000Z'};
  const result=await adapter.execute('schedules.edit',{request});
  assert.deepEqual(calls.find(call=>call[0]==='remoteEdit')[1],request);
  assert.equal(result.data.expectedUpdatedAt,request.expectedUpdatedAt);
  const stale={...request,expectedUpdatedAt:'2000-01-01T00:00:00Z'};
  assert.equal((await adapter.execute('schedules.edit',{request:stale})).data.code,'schedule_conflict');
});

test('schedules are forwarded to Host Remote forms',async()=>{
  const {adapter}=fixture();
  const created=await adapter.execute('schedules.create',{request:{title:'Safe test',prompt:'No model call in adapter test',timing:{kind:'at',at:'2027-11-06T12:00:00.000Z'}}});
  assert.equal(created.data.request.title,'Safe test');
  assert.equal((await adapter.execute('schedules.run',{request:{id:'schedule-test'}})).data.request.id,'schedule-test');
});

test('updates retain original request id and expose failure and restoration outcomes',async()=>{
  const calls=[];
  const {adapter}=fixture({pluginManager:{updateBundle:async(name,version,options)=>{calls.push({name,version,options});return {from:'1.0.0',to:version,step:'install',result:{application:'failed'},restore:{application:'applied'}};}}});
  const args={name:'fixture',version:'2.0.0',installId:'update-one'};
  assert.equal((await adapter.execute('plugins.update',args)).data.status,'running');
  await new Promise(resolve=>setImmediate(resolve));
  const progress=(await adapter.execute('plugins.installProgress',{installId:args.installId})).data;
  assert.equal(progress.result.result.application,'failed');assert.equal(progress.result.restore.application,'applied');
  await adapter.execute('plugins.update',args);assert.equal(calls.length,1);
  await assert.rejects(()=>adapter.execute('plugins.update',{...args,version:'3.0.0'}),{code:'CONFLICT'});
});

test('configuration edits require revision and cannot replace secret-bearing parents or new secret array entries',async()=>{
  const calls=[];
  const secret={type:'string',meta:{role:'secret'}};
  const descriptor={ns:'model',revision:4,value:{label:'Private model',providers:[]},
    secrets:[{path:['key'],set:true}],schema:{type:'object',dict:{
      key:secret,label:{type:'string'},providers:{type:'array',inner:{type:'object',dict:{token:secret}}}
    }}};
  const {adapter}=fixture({settings:{writable:true,describe:options=>{assert.equal(options.redactSecrets,true);return [descriptor];},mutate:async(...args)=>calls.push(args)}});
  assert.equal((await adapter.execute('settings.describe')).data.namespaces[0].value.label,'Private model');
  for(const path of [[],['key'],['providers'],['providers','0','token'],['__proto__']])await assert.rejects(()=>adapter.execute('settings.mutate',{ns:'model',expectedRevision:4,ops:[{op:'set',path,value:'bad'}]}),{code:'INVALID_REQUEST'});
  await assert.rejects(()=>adapter.execute('settings.mutate',{ns:'model',ops:[{op:'set',path:['label'],value:'New'}]}),{code:'INVALID_REQUEST'});
  assert.equal((await adapter.execute('settings.mutate',{ns:'model',expectedRevision:4,ops:[{op:'set',path:['label'],value:'New'}]})).data.ok,true);
  assert.equal(calls.length,1);assert.equal(calls[0][2],4);
});

test('native credential writes accept only declared secret paths and never echo the value',async()=>{
  const calls=[];
  const {adapter}=fixture({settings:{writable:true,describe:()=>[{ns:'model',revision:2,secrets:[{path:['apiKey'],set:false}]}],mutate:async(...args)=>calls.push(args)}});
  const args={ns:'model',expectedRevision:2,path:['apiKey'],value:'synthetic-credential'};
  const result=await adapter.execute('settings.secretSet',args);
  assert.deepEqual(result.data,{ok:true});assert.ok(!JSON.stringify(result).includes(args.value));
  assert.deepEqual(calls[0],['model',[{op:'set',path:['apiKey'],value:args.value}],2]);
  for(const patch of [{path:['label']},{path:['__proto__']},{value:''},{expectedRevision:-1}])await assert.rejects(()=>adapter.execute('settings.secretSet',{...args,...patch}),{code:'INVALID_REQUEST'});
  assert.equal(calls.length,1);
});
