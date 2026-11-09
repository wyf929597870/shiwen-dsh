import {createServer} from 'node:https';
import {hostname} from 'node:os';
import {Bonjour} from 'bonjour-service';
import {lanAddresses} from '../scripts/server-config.mjs';
import {loadServiceIdentity,serviceCertificate} from './service-identity.mjs';
import {createPairingTickets} from './pairing-tickets.mjs';
import QRCode from 'qrcode';

const json=(res,status,body)=>res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'}).end(JSON.stringify(body));
async function body(req){
 let size=0;const parts=[];
 for await(const part of req){size+=part.length;if(size>4096)throw Error('INVALID_REQUEST');parts.push(part);}
 return JSON.parse(Buffer.concat(parts).toString());
}
// Each concrete address gets a listener, but every request uses the SAME host,
// auth store and database. A NIC change never restarts the library owner.
export async function startServiceNetwork({directory,store,dispatch,includeAddress,addresses=()=>lanAddresses().filter(a=>!a.virtual||a.address===includeAddress).map(a=>a.address),port=3081,discovery=true,logger=console}){
 const identity=loadServiceIdentity(directory),tls=await serviceCertificate(identity);
 const audience='service:'+identity.fingerprint,tickets=createPairingTickets(),listeners=new Map();
 let closed=false,refreshing=false;
 const endpoints=()=>[...listeners].filter(([,v])=>v.server.listening).map(([ip,v])=>`https://${ip}:${v.server.address().port}/`);
 async function handle(req,res){
  try{
   const path=new URL(req.url,'https://service.invalid').pathname;
   const token=/^Bearer ([\w-]{43})$/.exec(req.headers.authorization??'')?.[1];
   const own=store.authenticate(token,audience);
   if(req.method==='GET'&&path==='/auth/status')return json(res,200,{version:1,fingerprint:identity.fingerprint,authenticated:!!own,configured:store.configured(),...(own?{endpoints:endpoints()}: {})});
   if(req.method==='POST'&&(path==='/auth/pair'||path==='/auth/login')){
    const data=await body(req);let issued;
    if(path==='/auth/pair'){
     if(!tickets.consume(data.id,data.secret))return json(res,401,{error:'PAIRING_EXPIRED'});
     issued=store.issue({audience,name:'Shiwen Android',remember:true});
    }else issued=await store.login(data.password,req.socket.remoteAddress,{audience,name:'Shiwen Android',remember:true});
    return json(res,200,{token:issued.token,fingerprint:identity.fingerprint,endpoints:endpoints()});
   }
   if(!own)return json(res,401,{error:'NODE_LOGIN_REQUIRED'});
   // No generic proxy, web assets, owner bootstrap, or websocket credential path.
   // Native mobile API carries sessions, sync chunks and management in this RPC.
   if(req.method!=='POST'||req.url!=='/api/shiwen')return json(res,404,{error:'NOT_FOUND'});
   dispatch(req,res,own);
  }catch(error){if(!res.headersSent)json(res,error.status??400,{error:error.status===429?'NODE_RATE_LIMITED':'INVALID_REQUEST'});else res.destroy();}
 }
 function retire(row){
  row.advert?.stop();row.bonjour?.destroy();row.server.close();row.server.closeIdleConnections();
  const timer=setTimeout(()=>{for(const socket of row.sockets)socket.destroy();},30000);timer.unref();
 }
 async function refresh(){
  if(closed||refreshing)return;refreshing=true;
  try{
   const wanted=new Set(['127.0.0.1',...addresses()]);
   // New endpoints must finish listen() before they can be discovered.
   for(const ip of wanted){
    if(listeners.has(ip)||closed)continue;
    const server=createServer({...tls,handshakeTimeout:5000},handle),sockets=new Set();
    server.requestTimeout=60000;server.headersTimeout=10000;
    server.on('connection',s=>{sockets.add(s);s.once('close',()=>sockets.delete(s));});
    try{await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,ip,()=>{server.removeListener('error',reject);resolve();});});}
    catch(error){server.close();logger.warn(`Shiwen secure entry unavailable (${ip}, ${error.code??'listen'}).`);continue;}
    server.on('error',()=>logger.warn('Shiwen secure listener error.'));
    const row={server,sockets};
    if(closed){retire(row);break;}
    listeners.set(ip,row);
    if(discovery&&ip!=='127.0.0.1')try{
     // Linux receives multicast on a wildcard UDP bind; membership and outgoing
     // interface stay scoped to this NIC. HTTPS above still binds a concrete IP.
     row.bonjour=new Bonjour({interface:ip,bind:'0.0.0.0'},()=>logger.warn('Shiwen LAN discovery unavailable.'));
     row.advert=row.bonjour.publish({name:`Shiwen-${identity.fingerprint.slice(0,12)}-${ip.replaceAll('.','-')}`,host:`shiwen-${identity.fingerprint.slice(0,12)}-${ip.replaceAll('.','-')}.local`,type:'shiwen',port:server.address().port,txt:{v:'1',fp:identity.fingerprint},disableIPv6:true,probe:true});
     // bonjour otherwise publishes all NICs, including virtual adapters.
     const records=row.advert.records.bind(row.advert);
     row.advert.records=()=>records().filter(r=>r.type!=='AAAA'&&(r.type!=='A'||r.data===ip));
    }catch{logger.warn('Shiwen LAN discovery unavailable.');}
   }
   for(const [ip,row]of listeners)if(!wanted.has(ip)){listeners.delete(ip);retire(row);}
  }finally{refreshing=false;}
 }
 await refresh();const timer=setInterval(()=>void refresh(),10000);timer.unref();
 return {fingerprint:identity.fingerprint,certificate:tls.cert,endpoints,refresh,
  async pairing(){
   const available=endpoints().filter(url=>!url.includes('127.0.0.1'));
   if(!available.length)throw Object.assign(Error('暂无可用局域网入口，请检查网络或 3081 端口'),{status:503});
   const ticket=tickets.issue(),payload={version:1,fingerprint:identity.fingerprint,name:hostname(),endpoints:available,...ticket};
   const code=JSON.stringify(payload);
   return {code,qr:await QRCode.toDataURL(code,{width:360,margin:2}),expiresAt:ticket.expiresAt};
  },revokeTickets:()=>tickets.revokeAll(),
  close(){closed=true;clearInterval(timer);tickets.revokeAll();for(const row of listeners.values())retire(row);listeners.clear();}
 };
}
