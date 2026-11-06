import test from 'node:test';
import assert from 'node:assert/strict';
import {remoteTarget,connectionPreference,connectionPartition,quitConnection,recognizedLocalPreference} from '../desktop/connection.mjs';
test('远端地址只接受服务根 HTTP(S)；配置不持久化登录凭据',()=>{
 const input={mode:'remote',address:'http://192.168.1.2:3080/?token=synthetic'};
 assert.equal(remoteTarget(input.address).url,input.address);
 assert.deepEqual(connectionPreference(input),{mode:'remote',address:'http://192.168.1.2:3080/'});
 for(const value of ['file:///tmp/test','javascript:alert(1)','https://user:pass@example.test/','http://example.test/path','http://example.test/?other=x','http://example.test/?token=a&token=b'])assert.throws(()=>remoteTarget(value));
 assert.notEqual(connectionPartition('local','http://127.0.0.1:3080'),connectionPartition('remote','http://127.0.0.1:3080'));
 assert.notEqual(connectionPartition('remote','http://192.168.1.2:3080'),connectionPartition('remote','http://192.168.1.3:3080'));
});
test('退出本机连接：保留、停止、取消、停止失败各自保持正确生命周期',async()=>{
 for(const [choice,expected] of [['keep',['quit']],['stop',['stop','quit']],['cancel',[]]]){
  const calls=[];await quitConnection({local:{},choose:async()=>choice,stop:async()=>calls.push('stop'),quit:()=>calls.push('quit')});assert.deepEqual(calls,expected);
 }
 let quit=false;await assert.rejects(()=>quitConnection({local:{},choose:async()=>'stop',stop:async()=>{throw Error('not stopped');},quit:()=>{quit=true;}}),/not stopped/);assert.equal(quit,false);
});
test('远端模式退出不会查询、启动或停止本机/远端服务',async()=>{
 const calls=[];await quitConnection({local:null,choose:async()=>{calls.push('choose');},stop:async()=>calls.push('stop'),quit:()=>calls.push('quit')});assert.deepEqual(calls,['quit']);
});

test('远端地址指向已认证的本机监听地址时按本机管理；不凭 IP 单独认定服务',()=>{
 const interfaces={wifi:[{address:'192.168.1.2'}]};
 const server={state:{secret:'synthetic'},url:'http://192.168.1.2:3080/'};
 assert.deepEqual(recognizedLocalPreference('http://192.168.1.2:3080/?token=old',server,interfaces),{mode:'local',lan:true,port:3080});
 for(const address of ['http://192.168.1.3:3080/','http://192.168.1.2:3081/','https://192.168.1.2:3080/','http://my-computer.example:3080/'])assert.equal(recognizedLocalPreference(address,server,interfaces),null);
 assert.equal(recognizedLocalPreference(server.url,null,interfaces),null);
 assert.equal(recognizedLocalPreference(server.url,{url:server.url},interfaces),null);
 assert.equal(recognizedLocalPreference(server.url,server,{}),null);
 assert.deepEqual(recognizedLocalPreference('http://localhost:3080/',{...server,url:'http://127.0.0.1:3080/'},{}),{mode:'local',lan:false,port:3080});
 assert.deepEqual(recognizedLocalPreference('https://[::1]/',{...server,url:'https://[::1]/'},{}),{mode:'local',lan:false,port:443,manualStart:true});
 assert.equal(connectionPreference({mode:'local',port:443,manualStart:true}).manualStart,true);
});

test('远端连接配置不保存密码或记住设备选项',()=>{assert.deepEqual(connectionPreference({mode:'remote',address:'http://192.168.1.2:3080/',password:'temporary-password',remember:true}),{mode:'remote',address:'http://192.168.1.2:3080/'});});
