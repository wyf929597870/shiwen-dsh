// Password admission for the standalone Shiwen host. DSH still owns Host/Origin
// validation, API peers, RPC and WebSocket transport. No upstream files are edited.
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,chmodSync} from 'node:fs';
import {join} from 'node:path';
import {randomBytes,createHash,scrypt as derive,timingSafeEqual} from 'node:crypto';
import {promisify} from 'node:util';
import {authPage} from './password-page.mjs';
const scrypt=promisify(derive),day=86400000;
const hash=value=>createHash('sha256').update(value).digest('hex');
const secret=()=>randomBytes(32).toString('base64url');
const header=(req,key)=>req.headers instanceof Headers?req.headers.get(key):req.headers[key];
const fail=(status,message)=>Object.assign(Error(message),{status});
// The standalone worker installs this gate BEFORE profile boot. Until the
// password plugin is active (including during reload), no native browser or API
// connection can sneak through an upstream route while plugins are settling.
let gateReady=false;
export function guardPasswordHost(HostConnectionService){
 const prototype=HostConnectionService.prototype;
 for(const name of ['admit','authorizeIndex','authorizeConnect']){
  const original=prototype[name];
  prototype[name]=function(request,response){
   if(!gateReady){
    if(name==='admit')return {rejection:401};
    response.writeHead(503,{'Cache-Control':'no-store'});response.end('Authentication is starting');return false;
   }
   return original.call(this,request,response);
  };
 }
}
function deviceName(agent=''){
 const browser=/Edg\//.test(agent)?'Edge':/Firefox\//.test(agent)?'Firefox':/Chrome\//.test(agent)?'Chrome':/Safari\//.test(agent)?'Safari':'Browser';
 const platform=/Android/.test(agent)?'Android':/iPhone|iPad/.test(agent)?'iOS':/Windows/.test(agent)?'Windows':/Macintosh/.test(agent)?'macOS':/Linux/.test(agent)?'Linux':'';
 return [browser,platform].filter(Boolean).join(' · ');
}
export class PasswordStore{
 constructor(directory,{now=Date.now}={}){
  mkdirSync(directory,{recursive:true,mode:0o700});
  const file=join(directory,'access.sqlite');this.db=new DatabaseSync(file);chmodSync(file,0o600);this.now=now;
  this.db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS password (id INTEGER PRIMARY KEY CHECK(id=1), salt TEXT NOT NULL, digest TEXT NOT NULL); CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, digest TEXT UNIQUE NOT NULL, audience TEXT NOT NULL, name TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL, owner INTEGER NOT NULL);');
  this.attempts=new Map();this.active=0;this.changing=false;
 }
 configured(){return !!this.db.prepare('SELECT 1 FROM password WHERE id=1').get();}
 async verify(value){
  if(typeof value!=='string'||Buffer.byteLength(value)>1024)return false;
  const row=this.db.prepare('SELECT * FROM password WHERE id=1').get();
  if(!row)return false;
  const actual=await scrypt(value,Buffer.from(row.salt,'hex'),64,{N:32768,r:8,p:1,maxmem:64*1024*1024});
  return timingSafeEqual(actual,Buffer.from(row.digest,'hex'));
 }
 throttle(ip){
  const now=this.now();
  for(const [key,row]of this.attempts)if(row.until<=now)this.attempts.delete(key);
  for(const [key,limit]of [['all',40],['ip:'+ip,8]]){
   const row=this.attempts.get(key)??{count:0,until:now+10*60*1000};
   if(row.count>=limit||this.attempts.size>4096)throw fail(429,'尝试过于频繁，请十分钟后重试 / Too many attempts. Try again in ten minutes.');
   row.count++;this.attempts.set(key,row);
  }
  if(this.active>=2)throw fail(429,'服务忙，请稍后重试 / Please try again shortly');
 }
 async login(password,ip,options){
  this.throttle(ip);this.active++;
  try{
   // Password changes must not race a login against a revoked credential.
   const before=this.db.prepare('SELECT digest FROM password WHERE id=1').get()?.digest;
   if(!await this.verify(password)||before!==this.db.prepare('SELECT digest FROM password WHERE id=1').get()?.digest)throw fail(401,'密码不正确 / Incorrect password');
   this.attempts.delete('ip:'+ip);return this.issue(options);
  }finally{this.active--;}
 }
 async change({password,currentPassword,owner=false}){
  if(this.changing)throw fail(409,'正在修改密码 / Password change in progress');
  if(typeof password!=='string'||password.length<10||Buffer.byteLength(password)>1024)throw fail(400,'密码需至少 10 个字符，最多 1024 字节 / Use at least 10 characters, at most 1024 bytes');
  this.changing=true;
  try{
   if(this.configured()){if(!await this.verify(currentPassword))throw fail(401,'当前密码不正确 / Incorrect current password');}
   else if(!owner)throw fail(403,'请从服务所在电脑设置首次密码 / Set the first password from the server computer');
   const salt=randomBytes(16),digest=await scrypt(password,salt,64,{N:32768,r:8,p:1,maxmem:64*1024*1024});
   this.db.exec('BEGIN IMMEDIATE');
   try{this.db.prepare('INSERT OR REPLACE INTO password VALUES(1,?,?)').run(salt.toString('hex'),digest.toString('hex'));this.db.exec('DELETE FROM sessions; COMMIT');}catch(e){this.db.exec('ROLLBACK');throw e;}
  }finally{this.changing=false;}
 }
 issue({audience,name='Browser',remember=false,owner=false}){
  const token=secret(),id=randomBytes(16).toString('hex'),created=this.now(),expires=created+(remember?30*day:12*60*60*1000);
  this.db.prepare('DELETE FROM sessions WHERE expires<=?').run(created);
  if(this.db.prepare('SELECT count(*) AS count FROM sessions').get().count>=200)throw fail(409,'设备数量已达上限，请撤销旧设备 / Revoke an old device first');
  this.db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?,?)').run(id,hash(token),audience,String(name).slice(0,100),created,expires,owner?1:0);
  return {id,token,expires,remember};
 }
 authenticate(token,audience){return typeof token==='string'&&token.length===43?this.db.prepare('SELECT id,name,created,expires,owner FROM sessions WHERE digest=? AND audience=? AND expires>?').get(hash(token),audience,this.now()):undefined;}
 list(){return this.db.prepare('SELECT id,name,created,expires FROM sessions WHERE expires>? ORDER BY created DESC').all(this.now());}
 revoke(id){this.db.prepare('DELETE FROM sessions WHERE id=?').run(id);}
 valid(id){return !!this.db.prepare('SELECT 1 FROM sessions WHERE id=? AND expires>?').get(id,this.now());}
 close(){this.db.close();}
}

export function installPasswordAuth(ctx,directory){
 const connection=ctx.connection,server=ctx.webServer,store=new PasswordStore(directory);
 const original={admit:connection.admit.bind(connection),index:connection.authorizeIndex.bind(connection),url:connection.authenticatedUrl.bind(connection)};
 const bootstrap=new Map(),sockets=new Map(),disposers=[];
 const audience=req=>`${server.protocol}//${header(req,'host')}`;
 const cookieName=req=>'shiwen-session-'+hash(audience(req)).slice(0,16);
 const session=req=>{
  const name=cookieName(req)+'=';
  const token=String(header(req,'cookie')??'').split(';').map(s=>s.trim()).find(s=>s.startsWith(name))?.slice(name.length);
  return store.authenticate(token,audience(req));
 };
 const cookie=(req,issued)=>`${cookieName(req)}=${issued?.token??''}; Path=/; HttpOnly; SameSite=Strict${server.protocol==='https:'?'; Secure':''}${!issued?'; Max-Age=0':issued.remember?'; Max-Age=2592000':''}`;
 // Mint a DSH cookie only inside the adapter. It never leaves this process.
 // Passing it through original.admit preserves the pinned DSH trust fence.
 function trusted(req,navigation=false){
  let value;
  const requestHeaders=req.headers instanceof Headers?Object.fromEntries(req.headers):{...req.headers};
  // A link from another page may open the login document. This exception never
  // applies to API requests, credential POSTs, embedded documents or upgrades.
  if(navigation&&req.method==='GET'&&header(req,'sec-fetch-mode')==='navigate'&&header(req,'sec-fetch-dest')==='document')delete requestHeaders['sec-fetch-site'];
  original.index({method:'GET',url:new URL(original.url('http://internal/')).search,headers:requestHeaders},{writeHead(_status,headers){value=headers?.['set-cookie'];},end(){}});
  return original.admit({headers:{...requestHeaders,cookie:typeof value==='string'?value.split(';')[0]:''}});
 }
 function track(req,id){
  if(!req.socket||req.socket.destroyed)return;
  let set=sockets.get(id);if(!set)sockets.set(id,set=new Set());
  if(set.has(req.socket))return;
  const socket=req.socket;set.add(socket);socket.once('close',()=>{set.delete(socket);if(!set.size)sockets.delete(id);});
 }
 function disconnectRevoked(){for(const [id,set]of sockets)if(!store.valid(id)){for(const socket of set)socket.destroy();sockets.delete(id);}}
 const timer=setInterval(disconnectRevoked,15000);timer.unref();
 connection.admit=function(req){
  const own=session(req);
  if(own){const admitted=trusted(req);if(!('rejection'in admitted))track(req,own.id);return admitted;}
  const admitted=original.admit(req);
  // Existing DSH browser cookies cannot bypass password login. API peers retain
  // their separate credentials and permissions.
  return 'rejection'in admitted||admitted.peer!==connection.browserPeer?admitted:{rejection:401};
 };
 connection.authorizeIndex=function(req,res){
  const check=trusted(req,true);
  if('rejection'in check){res.writeHead(check.rejection);res.end();return false;}
  const url=new URL(req.url,'http://internal');
  const tokens=url.searchParams.getAll('token');
  if(tokens.length){
   const entry=tokens.length===1?bootstrap.get(hash(tokens[0])):null;
   if(req.method==='GET'&&url.pathname==='/'&&entry&&entry.until>Date.now()&&entry.audience===audience(req)){
    bootstrap.delete(hash(tokens[0]));
    const previous=session(req);
    if(previous?.owner){res.writeHead(303,{Location:store.configured()?'/':'/auth/manage','Cache-Control':'no-store','Referrer-Policy':'no-referrer'});res.end();return false;}
    const issued=store.issue({audience:audience(req),name:'本机管理 / Local administration',owner:true,remember:true});
    res.writeHead(303,{'Set-Cookie':cookie(req,issued),Location:store.configured()?'/':'/auth/manage','Cache-Control':'no-store','Referrer-Policy':'no-referrer'});res.end();return false;
   }
   res.writeHead(401,{'Cache-Control':'no-store'});res.end('登录链接已失效，请使用密码登录 / Use password login');return false;
  }
  const own=session(req);
  if(own){track(req,own.id);return true;}
  if(req.method!=='GET'&&req.method!=='HEAD'){res.writeHead(401);res.end();return false;}
  res.writeHead(303,{Location:'/auth/login','Cache-Control':'no-store'});res.end();return false;
 };
 const respond=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}).end(JSON.stringify(data));};
 async function handle(req,res){
  try{
   const path=new URL(req.url,'http://internal').pathname,own=session(req);
   const admitted=trusted(req,path==='/auth/login'||path==='/auth/manage');if('rejection'in admitted)throw fail(admitted.rejection,'Forbidden');
   if(req.method==='GET'&&(path==='/auth/login'||path==='/auth/manage')){
    if(path==='/auth/manage'&&!own){res.writeHead(303,{Location:'/auth/login'}).end();return;}
    const nonce=secret();
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','Content-Security-Policy':`default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`}).end(authPage({nonce,manage:path==='/auth/manage'}));return;
   }
   if(req.method==='GET'&&path==='/auth/status'){respond(res,200,{configured:store.configured(),authenticated:!!own,...(own?{current:own.id,devices:store.list()}: {})});return;}
   if(req.method!=='POST')throw fail(405,'Method not allowed');
   // Explicit Origin for all credential-changing POSTs; protects even HTTP LAN.
   if(header(req,'origin')!==audience(req))throw fail(403,'Forbidden origin');
   if(!/^application\/json(?:;|$)/i.test(header(req,'content-type')??''))throw fail(415,'JSON required');
   const chunks=[];let size=0;
   for await(const chunk of req){size+=chunk.length;if(size>4096)throw fail(413,'Request too large');chunks.push(chunk);}
   let body;try{body=JSON.parse(Buffer.concat(chunks).toString());}catch{throw fail(400,'Invalid JSON');}
   if(!body||typeof body!=='object'||Array.isArray(body))throw fail(400,'Invalid JSON');
   const options={audience:audience(req),name:body.name||deviceName(header(req,'user-agent')),remember:body.remember===true};
   if(path==='/auth/login'){
    const issued=await store.login(body.password,req.socket.remoteAddress,options);
    res.setHeader('Set-Cookie',cookie(req,issued));respond(res,200,{ok:true});return;
   }
   if(!own)throw fail(401,'请重新登录 / Please sign in');
   if(path==='/auth/password'){
    store.throttle(req.socket.remoteAddress);
    await store.change({password:body.password,currentPassword:body.currentPassword,owner:!!own.owner});
    const issued=store.issue({...options,name:own.name,remember:true,owner:!!own.owner});
    res.setHeader('Set-Cookie',cookie(req,issued));res.once('finish',()=>setImmediate(disconnectRevoked));respond(res,200,{ok:true});return;
   }
   if(path==='/auth/revoke'){
    if(typeof body.id!=='string')throw fail(400,'Invalid device');
    store.revoke(body.id);res.once('finish',()=>setImmediate(disconnectRevoked));respond(res,200,{ok:true});return;
   }
   if(path==='/auth/logout'){
    store.revoke(own.id);res.setHeader('Set-Cookie',cookie(req));res.once('finish',()=>setImmediate(disconnectRevoked));respond(res,200,{ok:true});return;
   }
   throw fail(404,'Not found');
  }catch(e){if(!res.headersSent){if(e.status===429)res.setHeader('Retry-After','600');respond(res,e.status??500,{error:e.status?e.message:'认证服务出错 / Authentication service error'});}else res.destroy();}
 }
 disposers.push(server.register({kind:'prefix',path:'/auth',handler:handle}));
 gateReady=true;
 return {
  localLoginUrl(url){
   for(const [key,value]of bootstrap)if(value.until<=Date.now())bootstrap.delete(key);
   if(bootstrap.size>=100)bootstrap.delete(bootstrap.keys().next().value);
   const target=new URL(url),token=secret();bootstrap.set(hash(token),{audience:target.origin,until:Date.now()+5*60*1000});target.searchParams.set('token',token);return target.href;
  },
  close(){gateReady=false;clearInterval(timer);for(const set of sockets.values())for(const socket of set)socket.destroy();for(const dispose of disposers)dispose();connection.admit=original.admit;connection.authorizeIndex=original.index;store.close();}
 };
}
