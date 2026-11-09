import {homedir,networkInterfaces} from 'node:os';
import {isIP} from 'node:net';
import {join,resolve} from 'node:path';
import {parseArgs} from 'node:util';
// Prefer ordinary network adapters over container, bridge and tunnel interfaces.
export function lanAddresses(interfaces=networkInterfaces()){
 const virtual=/^(docker|br-|veth|virbr|vnet|vmnet|vboxnet|cni|flannel|tailscale|tun|tap|wg|zt|podman|lxc)/i;
 return Object.entries(interfaces).flatMap(([name,items])=>(items??[]).filter(v=>v&&!v.internal&&v.family==='IPv4'&&/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(v.address)).map(v=>({name,address:v.address,virtual:virtual.test(name)})));
}
export function preferredLanAddress(interfaces=networkInterfaces()){
 const physical=[...new Set(lanAddresses(interfaces).filter(v=>!v.virtual).map(v=>v.address))];
 if(physical.length===1)return physical[0];
 throw Error(`无法自动选择局域网地址，请手动选择 / Choose a LAN address: ${physical.join(', ')||'none'}`);
}
export function serverOptions(argv,env=process.env,interfaces=networkInterfaces()){
 const {values}=parseArgs({args:argv,options:{root:{type:'string'},host:{type:'string'},lan:{type:'boolean'},port:{type:'string'},'tls-cert':{type:'string'},'tls-key':{type:'string'}}});
 if(values.host&&values.lan)throw Error('Use --host or --lan, not both');
 const host=values.host??(values.lan?preferredLanAddress(interfaces):'127.0.0.1');
 if(!isIP(host)||['0.0.0.0','::'].includes(host))throw Error('--host must be a concrete local IP address');
 const port=values.port===undefined?3080:Number(values.port);
 if(!/^\d+$/.test(String(values.port??3080))||!Number.isInteger(port)||port<0||port>65535)throw Error('Invalid port');
 if(!!values['tls-cert']!==!!values['tls-key'])throw Error('TLS requires both --tls-cert and --tls-key');
 const root=resolve(values.root??env.SHIWEN_ROOT_DIR??join(env.XDG_DATA_HOME??join(homedir(),'.local/share'),'shiwen-dsh'));
 return {root,host,port,discoverLan:!!values.lan||!['127.0.0.1','::1'].includes(host),...(values['tls-cert']?{cert:resolve(values['tls-cert']),key:resolve(values['tls-key'])}:{})};
}

// Desktop can still start on loopback when the requested LAN address is ambiguous or gone.
export function desktopServerOptions(args,lan,lanHost,interfaces=networkInterfaces()){
 if(lanHost&&lanAddresses(interfaces).some(item=>item.address===lanHost))return {options:serverOptions([...args,'--host',lanHost],process.env,interfaces),lanFallback:false};
 if(lanHost)return {options:{...serverOptions(args,process.env,interfaces),discoverLan:!!lan||!!lanHost},lanFallback:true};
 if(lan){try{return {options:serverOptions([...args,'--lan'],process.env,interfaces),lanFallback:false};}catch(error){if(!String(error.message).includes('Choose a LAN address'))throw error;return {options:{...serverOptions(args,process.env,interfaces),discoverLan:!!lan||!!lanHost},lanFallback:true};}}
 return {options:serverOptions(args,process.env,interfaces),lanFallback:false};
}
