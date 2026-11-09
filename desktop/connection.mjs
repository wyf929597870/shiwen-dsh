import {createHash} from 'node:crypto';
import {networkInterfaces} from 'node:os';
import {isIP} from 'node:net';
export function remoteTarget(value){
 let url;try{url=new URL(String(value).trim());}catch{throw Error('请输入完整的 http:// 或 https:// 地址 / Enter a complete HTTP(S) URL');}
 if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.pathname!=='/'||url.hash||[...url.searchParams.keys()].some(key=>key!=='token')||url.searchParams.getAll('token').length>1)throw Error('请使用服务根地址或完整登录链接 / Use the service root or its login link');
 return {origin:url.origin,url:url.href};
}
export function connectionPreference(input){
 if(input?.mode==='remote')return {mode:'remote',address:remoteTarget(input.address).origin+'/'};
 if(input?.mode!=='local')throw Error('请选择连接方式 / Choose a connection mode');
 const port=Number(input.port??3080);
 if(!Number.isInteger(port)||port<1||port>65535)throw Error('端口必须为 1–65535 / Invalid port');
 const lanHost=String(input.lanHost??'').trim();
 if(lanHost&&isIP(lanHost)!==4)throw Error('请选择有效的局域网地址 / Choose a valid LAN address');
 return {mode:'local',lan:!!input.lan,port,...(input.lan&&lanHost?{lanHost}:{}),...(input.manualStart===true?{manualStart:true}:{})};
}
export function connectionPartition(mode,origin){return 'persist:shiwen-'+createHash('sha256').update(mode+'\n'+origin).digest('hex').slice(0,24);}
export function desktopPreference(input={}){
 const closeAction=input.closeAction??'quit';
 if(!['quit','tray'].includes(closeAction))throw Error('无效的窗口关闭方式 / Invalid window close action');
 return {closeAction};
}
export function closeWindow({preference,trayAvailable,hide,quit}){
 if(preference.closeAction==='tray'&&trayAvailable){hide();return;}
 return quit();
}
export async function quitConnection({local,choose,stop,quit}){
 if(!local){quit();return;}
 const choice=await choose();
 if(choice==='cancel')return;
 if(choice==='stop')await stop();
 if(choice==='stop'||choice==='keep')quit();
}

// `server` must come from the authenticated local control endpoint, never from the
// selected remote page. Require both the exact service authority and a local IP.
export function recognizedLocalPreference(address,server,interfaces=networkInterfaces()){
 if(!server?.state||!server.url)return null;
 const target=new URL(remoteTarget(address).url);
 let bound;try{bound=new URL(server.url);}catch{return null;}
 const hostname=bound.hostname.replace(/^\[|\]$/g,'');
 const loopback=hostname==='::1'||/^127\./.test(hostname);
 const local=loopback||Object.values(interfaces).flat().some(item=>item?.address===hostname);
 if(!isIP(hostname)||!local)return null;
 const sameHost=target.hostname===bound.hostname||(target.hostname==='localhost'&&loopback);
 if(!sameHost||target.protocol!==bound.protocol||target.port!==bound.port)return null;
 return {mode:'local',lan:!loopback,port:Number(bound.port||(bound.protocol==='https:'?443:80)),...(bound.protocol==='https:'?{manualStart:true}:{})};
}

// Use Electron's own cookie jar; never copy passwords into saved preferences.
export async function authenticateRemote(session,origin,input){
 if(!input.password)return;
 if(typeof input.password!=='string'||Buffer.byteLength(input.password)>1024)throw Error('密码格式无效 / Invalid password');
 const response=await session.fetch(origin+'/auth/login',{method:'POST',credentials:'include',redirect:'error',headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify({password:input.password,remember:input.remember===true,name:'拾文桌面端 / Shiwen desktop'}),signal:AbortSignal.timeout(15000)});
 if(!response.ok){let detail;try{detail=(await response.json()).error;}catch{}throw Error(detail??'登录失败，请确认服务已升级并设置密码 / Login failed. Check server password support.');}
}
