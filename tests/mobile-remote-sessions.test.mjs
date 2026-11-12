import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRemoteSessionsAdapter,SqliteSessionLedger,createInteractionRelay} from '../plugins/mobile/src/remote-sessions-adapter.mjs';

test('production ledger survives restart, binds exact prompt, and never resends unknown admission',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'shiwen-sessions-'));let calls=0;
  const c={prompt:async()=>{calls++;throw Error('ACK lost');},state:async()=>({cursor:0,queue:[{rpcId:'r1'}]}),events:async()=>({records:[],hasMore:false})};
  const make=()=>createRemoteSessionsAdapter({ctx:{get:key=>key==='sessionController'?c:undefined},library:{paths:{library:dir}},relay:{snapshot:async()=>({items:[]}),close(){}}});
  const request={requestId:'r1',sessionId:'s1',mode:'queue',content:[{type:'text',text:'private draft'}]};
  let adapter=make();
  try{
    assert.equal((await adapter.execute('send',request)).data.status,'unknown');adapter.close();adapter=make();
    assert.equal((await adapter.execute('send',request)).data.status,'unknown');assert.equal(calls,1);
    await assert.rejects(adapter.execute('send',{...request,content:[{type:'text',text:'changed'}]}),{code:'REQUEST_ID_REUSED'});
    const reconciled=(await adapter.execute('status',{requestId:'r1'})).data;
    assert.equal(reconciled.request.requestId,'r1');assert.equal(reconciled.request.status,'accepted');
    assert.equal((await adapter.execute('send',request)).data.status,'accepted');assert.equal(calls,1);
  }finally{adapter.close();rmSync(dir,{recursive:true,force:true});}
});

test('new session creation is durable and never retried with a new identity after lost acknowledgement',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'shiwen-session-create-'));let calls=0;
  const ctx={get:()=>({create:async()=>{calls++;throw Error('lost');}})};
  const make=()=>createRemoteSessionsAdapter({ctx,library:{paths:{library:dir}},relay:{close(){}}});
  let adapter=make();const request={requestId:'c1',sessionId:'s1',workspaceId:'w1'};
  try{assert.equal((await adapter.execute('create',request)).data.status,'unknown');adapter.close();adapter=make();
    assert.equal((await adapter.execute('create',request)).data.status,'unknown');assert.equal(calls,1);
    await assert.rejects(adapter.execute('create',{...request,workspaceId:'w2'}),{code:'REQUEST_ID_REUSED'});
  }finally{adapter.close();rmSync(dir,{recursive:true,force:true});}
});

test('session read adapter forwards pinned DSH history cursors and rejects invalid actions',async()=>{
  const seen=[];const c={events:async request=>{seen.push(request);return {cursor:12,records:[],hasMore:true};}};
  const adapter=createRemoteSessionsAdapter({ctx:{get:()=>c},library:{},relay:{close(){}}});
  try{const result=await adapter.execute('events',{sessionId:'s1',throughSeq:12,beforeSeq:9});
    assert.equal(result.data.cursor,12);assert.deepEqual(seen[0],{address:{kind:'session',sessionId:'s1'},maxMessages:30,throughSeq:12,beforeSeq:9});
    await assert.rejects(adapter.execute('events',{sessionId:'s1',beforeSeq:-1}),{code:'INVALID_REQUEST'});
    await assert.rejects(adapter.execute('shell',{command:'ignored'}),{code:'INVALID_REQUEST'});
  }finally{adapter.close();}
});

test('session archive forwards to the workspace registry and reports the durable archive set',async()=>{
  const archived=[],calls=[];
  const registry={
    get archivedSessionIds(){return [...archived];},
    archiveSession:async(id,options)=>{calls.push({id,options});if(!archived.includes(id))archived.push(id);},
    unarchiveSession:async id=>{calls.push({id,unarchive:true});archived.splice(archived.indexOf(id),1);}
  };
  const c={list:async()=>({items:[{sessionId:'s1'},{sessionId:'s2'}]})};
  const adapter=createRemoteSessionsAdapter({
    ctx:{get:key=>key==='sessionController'?c:key==='workspaceRegistry'?registry:undefined},
    library:{},relay:{close(){}}});
  try{
    const listed=await adapter.execute('list',{});
    assert.deepEqual(listed.data.items.map(row=>row.sessionId),['s1','s2']);
    assert.deepEqual(listed.data.archivedSessionIds,[]);
    const result=await adapter.execute('archive',{sessionId:'s2',stopActivity:true});
    assert.deepEqual(result.data.archivedSessionIds,['s2']);
    assert.deepEqual(calls[0],{id:'s2',options:{stopActivity:true}});
    assert.deepEqual((await adapter.execute('list',{})).data.archivedSessionIds,['s2']);
    assert.deepEqual((await adapter.execute('unarchive',{sessionId:'s2'})).data.archivedSessionIds,[]);
    assert.deepEqual(archived,[]);
  }finally{adapter.close();}
});

test('session archive refuses without a registry or when the host rejects it',async()=>{
  const adapter=createRemoteSessionsAdapter({
    ctx:{get:key=>key==='sessionController'?{}:undefined},library:{},relay:{close(){}}});
  try{await assert.rejects(adapter.execute('archive',{sessionId:'s1'}),{code:'SESSIONS_UNAVAILABLE'});}
  finally{adapter.close();}
  const refusing=createRemoteSessionsAdapter({
    ctx:{get:key=>key==='sessionController'?{}:key==='workspaceRegistry'
      ?{archivedSessionIds:[],archiveSession:async()=>{throw Error('session still running');}}
      :undefined},library:{},relay:{close(){}}});
  try{
    await assert.rejects(refusing.execute('archive',{sessionId:'s1'}),{code:'SESSION_CONFLICT'});
    await assert.rejects(refusing.execute('archive',{}),{code:'INVALID_REQUEST'});
  }finally{refusing.close();}
});

test('interaction relay only accepts explicit single-use decisions and respects stream generation',async()=>{
  let wake,stopped=false;const received=[];const frames=[{type:'waterfall',eventId:'e1',agentId:'s1',event:'approval/request',request:{toolName:'edit_file'}}];
  const peer={principal:{kind:'owner'}};
  const ctx={get:()=>({wireStream:{open:async(_endpoint,_payload,_uplink,_peer,signal)=>(async function*(){
    signal.addEventListener('abort',()=>{stopped=true;wake?.();});yield {type:'ready',clientId:'g1'};
    while(!stopped){if(frames.length)yield frames.shift();else await new Promise(resolve=>{wake=resolve;});}
  })()}}),connection:{browserPeer:peer,createSharedFetchHandler:()=>({fetch:async(request,actualPeer)=>{
    assert.equal(actualPeer,peer);received.push(await request.json());return Response.json({result:{ok:true}});
  }})}};
  const relay=createInteractionRelay(ctx);
  try{await relay.snapshot();await new Promise(resolve=>setImmediate(resolve));
    assert.equal((await relay.snapshot()).items.length,1);
    await assert.rejects(relay.respond({clientId:'old',eventId:'e1',value:'allowed-once'}),{code:'INTERACTION_EXPIRED'});
    await assert.rejects(relay.respond({clientId:'g1',eventId:'e1',value:'always'}),{code:'INVALID_REQUEST'});
    await relay.respond({clientId:'g1',eventId:'e1',value:'rejected'});
    assert.equal(received[0].payload.args.outcome.value,'rejected');assert.equal((await relay.snapshot()).items.length,0);
  }finally{relay.close();}
});
