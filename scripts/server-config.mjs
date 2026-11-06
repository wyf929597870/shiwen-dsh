import {homedir,networkInterfaces} from 'node:os';
import {isIP} from 'node:net';
import {join,resolve} from 'node:path';
import {parseArgs} from 'node:util';
export function serverOptions(argv,env=process.env,interfaces=networkInterfaces()){
 const {values}=parseArgs({args:argv,options:{root:{type:'string'},host:{type:'string'},lan:{type:'boolean'},port:{type:'string'},'tls-cert':{type:'string'},'tls-key':{type:'string'}}});
 if(values.host&&values.lan)throw Error('Use --host or --lan, not both');
 const candidates=[...new Set(Object.values(interfaces).flat().filter(v=>v&&!v.internal&&v.family==='IPv4'&&/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(v.address)).map(v=>v.address))];
 if(values.lan&&candidates.length!==1)throw Error(`无法自动选择局域网地址，请使用 --host <IP> / Choose a LAN address: ${candidates.join(', ')||'none'}`);
 const host=values.host??(values.lan?candidates[0]:'127.0.0.1');
 if(!isIP(host)||['0.0.0.0','::'].includes(host))throw Error('--host must be a concrete local IP address');
 const port=values.port===undefined?3080:Number(values.port);
 if(!/^\d+$/.test(String(values.port??3080))||!Number.isInteger(port)||port<0||port>65535)throw Error('Invalid port');
 if(!!values['tls-cert']!==!!values['tls-key'])throw Error('TLS requires both --tls-cert and --tls-key');
 const root=resolve(values.root??env.SHIWEN_ROOT_DIR??join(env.XDG_DATA_HOME??join(homedir(),'.local/share'),'shiwen-dsh'));
 return {root,host,port,...(values['tls-cert']?{cert:resolve(values['tls-cert']),key:resolve(values['tls-key'])}:{})};
}
