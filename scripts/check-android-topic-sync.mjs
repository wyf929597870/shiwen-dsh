import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {promisify} from 'node:util';
import {startServer,stopServer} from './server-control.mjs';

// Run with the debug application and its instrumented tests on an explicitly selected USB device.
// Optional arguments select the packaged service runtime and its bundled Node binary.
const serial=process.env.ANDROID_SERIAL;
assert.ok(serial,'Set ANDROID_SERIAL to the test device');
const adb=(...args)=>promisify(execFile)('adb',['-s',serial,...args],{timeout:120000,maxBuffer:4e6});
const root=await mkdtemp(join(tmpdir(),'shiwen-device-topics-'));
const runtime=resolve(process.argv[2]??join(import.meta.dirname,'..'));
const launch=process.argv[3]?{runtime,worker:join(runtime,'scripts/server-worker.mjs'),node:resolve(process.argv[3])}:{runtime};
const password=randomUUID();
let service,endpoint,mapped=false,cleanup,failed=false;
try {
  service=await startServer({root,host:'127.0.0.1',port:0},launch);
  const base=new URL(service.url).origin;
  const post=(path,body,cookie)=>fetch(base+path,{method:'POST',redirect:'manual',headers:{
    'content-type':'application/json',origin:base,cookie},body:JSON.stringify(body)});
  const cookies=res=>res.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');
  const bootstrap=await fetch(service.loginUrl,{redirect:'manual'});
  assert.equal(bootstrap.status,303);
  const login=await post('/auth/password',{password},cookies(bootstrap));
  assert.equal(login.status,200);
  const cookie=cookies(login);
  async function rpc(method,args={}) {
    const res=await post('/api/shiwen',{method,args},cookie);
    const data=await res.json();
    assert.equal(res.status,200,JSON.stringify(data));
    return data.result;
  }
  const {libraryId}=await rpc('themeContext');
  const topic=(method,args)=>rpc(method,{...args,expectedLibraryId:libraryId});
  const body='desktop passage|phone passage|parallel';
  const source=await rpc('saveMarkdown',{kind:'idea',body,title:'Synthetic quotation source'});
  const {id}=await topic('themeSave',{title:'desktop original',summary:'initial'});
  const read=()=>topic('themeRead',{id});
  async function add(quote) {
    const start=body.indexOf(quote);
    return topic('themeMemberAdd',{themeId:id,revision:(await read()).revision,sourceRecordId:source.id,
      sourceRevision:source.revision,field:'body',quote,start,end:start+quote.length});
  }
  async function rename(title,summary) {return topic('themeSave',{id,revision:(await read()).revision,title,summary});}
  await add('desktop passage');
  endpoint='tcp:'+new URL(service.url).port;
  async function connect(){await adb('reverse',endpoint,endpoint);mapped=true;}
  async function disconnect(){await adb('reverse','--remove',endpoint);mapped=false;}
  async function phase(name){
    console.log('Starting Android phase:',name);
    const params={class:'io.github.wyf929597870.shiwen.library.TopicSyncHostTest',
      topicPhase:name,host:base,password,library:libraryId,theme:id,source:source.id};
    const {stdout}=await adb('shell','am','instrument','-w',...Object.entries(params).flatMap(([k,v])=>['-e',k,v]),
      'io.github.wyf929597870.shiwen.probe.test/androidx.test.runner.AndroidJUnitRunner');
    assert.match(stdout,/OK \(1 test\)/,name+' '+stdout.replaceAll(password,'[redacted]'));
    console.log('Verified Android phase:',name);
  }
  cleanup=()=>phase('cleanup');
  await connect();
  await phase('initial');
  await disconnect();
  await phase('offline');
  assert.equal((await read()).title,'desktop original');
  assert.equal((await read()).members.length,1);
  await rename('desktop later','desktop description');
  await add('parallel');
  await connect();
  await phase('desktopWins');
  let row=await read();
  assert.equal(row.title,'desktop later');
  assert.deepEqual(row.members.map(x=>x.quote).sort(),['desktop passage','parallel','phone passage']);
  assert.ok(row.members.every(x=>x.location.status==='current'));
  const all=await topic('themeList');
  assert.equal(all.length,2);
  const created=all.find(x=>x.id!==id);
  assert.equal(created.title,'phone-created');
  assert.equal(created.summary,'created offline');
  await rename('desktop before phone','new desktop summary');
  await phase('phoneWins');
  row=await read();
  assert.equal(row.title,'phone latest');
  assert.equal(row.summary,'new desktop summary');
  assert.deepEqual(row.members.map(x=>x.quote).sort(),['parallel','phone passage']);
  await topic('themeDelete',{id:created.id,revision:created.revision});
  await phase('delete');
  assert.deepEqual(await topic('themeList'),[]);
  console.log('Passed desktop/Android bidirectional topics, offline reopen and passage editing, both conflict orders, deletion and repeated sync.');
} catch (error) {
  failed=true;
  console.error('Device test failed:',String(error.message).replaceAll(password,'[redacted]'));
  throw error;
} finally {
  try {if(cleanup)await cleanup().catch(error=>{if(!failed)throw error;});}
  finally {
    if(mapped)await adb('reverse','--remove',endpoint);
    if(service)await stopServer(root);
    await rm(root,{recursive:true,force:true});
  }
}
