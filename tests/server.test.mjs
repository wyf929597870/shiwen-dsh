import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {serverOptions,desktopServerOptions} from '../scripts/server-config.mjs';
import {acquireOwnership} from '../plugins/library/src/ownership.mjs';
const network={wifi:[{internal:false,family:'IPv4',address:'192.168.1.2'}],tun:[{internal:false,family:'IPv4',address:'198.18.0.1'}]};
test('服务默认复用桌面数据，LAN 排除隧道地址且多网卡要求明确选择',()=>{
 assert.equal(serverOptions([],{XDG_DATA_HOME:'/synthetic/data'},network).root,'/synthetic/data/shiwen-dsh');
 assert.equal(serverOptions([],{},network).host,'127.0.0.1');
 assert.equal(serverOptions(['--lan'],{},network).host,'192.168.1.2');
 assert.equal(serverOptions(['--lan'],{},{...network,'br-docker':[{internal:false,family:'IPv4',address:'172.19.0.1'}],docker0:[{internal:false,family:'IPv4',address:'172.17.0.1'}]}).host,'192.168.1.2');
 assert.throws(()=>serverOptions(['--lan'],{},{docker0:[{internal:false,family:'IPv4',address:'172.17.0.1'}]}),/Choose/);
 assert.throws(()=>serverOptions(['--lan'],{},{...network,extra:[{internal:false,family:'IPv4',address:'10.0.0.2'}]}),/Choose/);
 for(const args of [['--host','0.0.0.0'],['--port','-1'],['--port',''],['--tls-cert','a'],['--lan','--host','127.0.0.1']])assert.throws(()=>serverOptions(args,{},network));
});
test('资料库锁拒绝另一进程，释放和异常退出后可重新获取',async()=>{
 const root=await mkdtemp(join(tmpdir(),'shiwen-owner-'));
 const module=new URL('../plugins/library/src/ownership.mjs',import.meta.url).href;
 const child=()=>spawn(process.execPath,['--input-type=module','-e',`import {acquireOwnership} from ${JSON.stringify(module)};acquireOwnership(${JSON.stringify(root)});process.send('locked');setInterval(()=>{},1000);`],{stdio:['ignore','ignore','pipe','ipc']});
 try{
  const release=acquireOwnership(root),nested=acquireOwnership(root);
  release();
  const rejected=child();assert.equal(await new Promise(resolve=>rejected.once('exit',resolve)),1);
  nested();
  const accepted=child();await new Promise((yes,no)=>{accepted.once('message',yes);accepted.once('error',no);accepted.once('exit',()=>no(Error('Owner exited')));});
  assert.throws(()=>acquireOwnership(root),/already in use/);
  const exit=new Promise(yes=>accepted.once('exit',yes));accepted.kill('SIGKILL');await exit;
  acquireOwnership(root)();
 }finally{await rm(root,{recursive:true,force:true});}
});

test('桌面多物理网卡时回退本机，手选有效地址仍支持局域网',()=>{
 const multi={...network,ethernet:[{internal:false,family:'IPv4',address:'10.0.0.2'}]};
 assert.equal(desktopServerOptions([],true,'',multi).options.host,'127.0.0.1');
 assert.equal(desktopServerOptions([],true,'',multi).lanFallback,true);
 assert.equal(desktopServerOptions([],true,'10.0.0.2',multi).options.host,'10.0.0.2');
 assert.equal(desktopServerOptions([],true,'10.0.0.3',multi).lanFallback,true);
 assert.equal(desktopServerOptions([],false,'',multi).lanFallback,false);
});
