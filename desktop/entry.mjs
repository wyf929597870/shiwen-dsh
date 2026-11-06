import {app,BrowserWindow,Menu,Tray,nativeImage,dialog,ipcMain,shell} from 'electron';
import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {controlServer,ensureServer,stopServer} from '../scripts/server-control.mjs';
import {serverOptions} from '../scripts/server-config.mjs';
import {connectionPreference,connectionPartition,remoteTarget,quitConnection,recognizedLocalPreference,authenticateRemote} from './connection.mjs';
const base=resolve(process.env.SHIWEN_ROOT_DIR??join(process.env.XDG_DATA_HOME??join(homedir(),'.local/share'),'shiwen-dsh'));
const version=app.isPackaged?app.getVersion():JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8')).version;
app.setName('拾文');app.setPath('userData',join(base,'desktop'));
if(!app.requestSingleInstanceLock()){app.quit();}else{
 let window,settings,tray,connected,preference,connecting=false,quitting=false,exitAllowed=false,localSeen;
 const preferences=join(base,'desktop/connection.json'),settingsFile=join(import.meta.dirname,'connection.html');
 const resources=app.isPackaged?join(process.resourcesPath,'shiwen'):resolve(import.meta.dirname,'..');
 const icon=join(resources,'assets/shiwen-icon-rounded.png');
 const zh=()=>app.getLocale().startsWith('zh'),t=(a,b)=>zh()?a:b;
 const launch={node:app.isPackaged?join(process.resourcesPath,'runtime/primary-runtime/dependencies/node/bin/node'):process.env.SHIWEN_NODE_EXECUTABLE,
  worker:join(resources,'scripts/server-worker.mjs'),...(app.isPackaged?{runtime:resources}:{}),env:{...process.env}};
 delete launch.env.ELECTRON_RUN_AS_NODE;
 const ask=options=>{const owner=window??settings;return owner&&!owner.isDestroyed()?dialog.showMessageBox(owner,options):dialog.showMessageBox(options);};
 const message=error=>String(error.message??error).replace(/([?&]token=)[^\s&]+/g,'$1[hidden]');
 function protect(win,origin){
  const wc=win.webContents;
  wc.setWindowOpenHandler(({url})=>{if(/^https?:\/\//.test(url))void shell.openExternal(url);return {action:'deny'};});
  wc.on('will-attach-webview',event=>event.preventDefault());
  for(const event of ['will-navigate','will-redirect'])wc.on(event,(e,url)=>{if(new URL(url).origin!==origin)e.preventDefault();});
  wc.session.setPermissionRequestHandler((_wc,permission,callback)=>callback(permission==='clipboard-sanitized-write'));
 }
 function updateMenu(){
  const target=connected?(connected.mode==='local'?(connected.recognized?t('本机服务 · 自动识别','Local service · detected'):t('本机服务','Local service')):t('远端服务','Remote service'))+' · '+connected.origin:t('未连接','Not connected');
  Menu.setApplicationMenu(Menu.buildFromTemplate([
   {label:t('拾文','Shiwen'),submenu:[{label:`${t('拾文客户端','Shiwen client')} v${version}`,enabled:false},{label:target,enabled:false},{label:t('连接设置…','Connection settings…'),accelerator:'CmdOrCtrl+,',click:()=>showSettings()},{type:'separator'},{label:t('退出','Quit'),accelerator:'CmdOrCtrl+Q',click:()=>app.quit()}]},
   {label:t('编辑','Edit'),submenu:[{role:'undo'},{role:'redo'},{type:'separator'},{role:'cut'},{role:'copy'},{role:'paste'},{role:'selectAll'}]},
   {label:t('查看','View'),submenu:[{role:'reload'},{role:'resetZoom'},{role:'zoomIn'},{role:'zoomOut'},{role:'togglefullscreen'}]}
  ]));
  tray?.setContextMenu(Menu.buildFromTemplate([{label:target,enabled:false},{label:t('打开拾文','Open Shiwen'),click:()=>{if(window){window.show();window.focus();}else showSettings();}},{label:t('连接设置…','Connection settings…'),click:()=>showSettings()},{label:t('退出','Quit'),click:()=>app.quit()}]));
 }
 async function showSettings(error=''){
  if(settings&&!settings.isDestroyed()){settings.show();settings.focus();if(error)settings.webContents.send('connection-error',error);return;}
  settings=new BrowserWindow({width:650,height:800,minWidth:520,minHeight:540,title:t('拾文 · 连接设置','Shiwen · Connection'),icon,backgroundColor:'#1d2126',webPreferences:{preload:join(import.meta.dirname,'connection-preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
  settings.setMenu(null);settings.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  settings.webContents.on('will-navigate',e=>e.preventDefault());
  settings.on('closed',()=>{settings=null;if(!window&&!connecting)app.quit();});
  await settings.loadFile(settingsFile);
  if(error)settings.webContents.send('connection-error',error);
 }
 function trusted(event){return settings&&!settings.isDestroyed()&&event.sender===settings.webContents&&event.senderFrame===settings.webContents.mainFrame&&event.senderFrame.url===pathToFileURL(settingsFile).href;}
 async function savePreference(value){await mkdir(join(base,'desktop'),{recursive:true,mode:0o700});const temp=preferences+'.tmp';await writeFile(temp,JSON.stringify(value,null,2)+'\n',{mode:0o600});await rename(temp,preferences);preference=value;}
 async function connect(input){
  if(connecting||quitting)throw Error(t('正在处理，请稍候','Please wait'));connecting=true;
  let candidate;
  try{
   let next=connectionPreference(input);
   let url,state,recognized=false;
   if(next.mode==='remote'){
    // Inspection failure leaves the connection remote. Never launch a local fallback.
    const owner=await controlServer(base,'status').catch(()=>null);
    const local=recognizedLocalPreference(input.address,owner);
    if(local){
     const server=await controlServer(base,'url',owner.state);
     if(!server)throw Error(t('本机服务已停止，请选择本机模式重新启动。','The local service stopped. Select local mode to restart it.'));
     next=local;url=server.loginUrl;state=server.state;localSeen=state;recognized=true;
    }
   }
   if(next.mode==='local'&&!recognized){
    // Reuse before evaluating network settings: an existing service owns its binding.
    let server=await controlServer(base,'url');
    if(!server&&next.manualStart)throw Error(t('此本机服务使用 HTTPS，请先使用原证书配置启动服务，再重新连接。','This local service uses HTTPS. Start it with its original certificate configuration, then reconnect.'));
    if(!server){const args=['--root',base,'--port',String(next.port),...(next.lan?['--lan']:[])];server=await ensureServer(serverOptions(args),launch);}
    if(!server?.loginUrl)throw Error(t('服务尚未就绪','Service is not ready'));
    url=server.loginUrl;state=server.state;localSeen=state;
   }else if(next.mode==='remote')url=remoteTarget(input.address).url;
   const origin=new URL(url).origin;
   candidate=new BrowserWindow({show:false,width:1320,height:880,minWidth:760,minHeight:600,title:'拾文',icon,backgroundColor:'#1d2126',webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,partition:connectionPartition(next.mode,origin)}});
   protect(candidate,origin);
   candidate.webContents.on('page-title-updated',event=>event.preventDefault());
   candidate.setTitle(`拾文 v${version} · ${next.mode==='local'?(recognized?t('本机 · 自动识别','Local · detected'):t('本机','Local')):t('远端','Remote')} · ${origin}`);
   if(next.mode==='remote')await authenticateRemote(candidate.webContents.session,origin,input);
   let loadTimer;
   try{await Promise.race([candidate.loadURL(url),new Promise((_,reject)=>{loadTimer=setTimeout(()=>reject(Error(t('连接超时，请检查服务地址与网络。','Connection timed out. Check the address and network.'))),15000);})]);}finally{clearTimeout(loadTimer);}
   // Use this renderer's cookie jar; HTTP 401 must never count as connected.
   const response=await candidate.webContents.session.fetch(origin+'/api/shiwen',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json',Origin:origin},body:'{"method":"browserStatus"}',signal:AbortSignal.timeout(8000)});
   if(!response.ok)throw Error(t('请在连接设置输入访问密码；首次使用请先在服务所在电脑设置密码。','Enter the access password in connection settings. Set the first password on the server computer.'));
   const payload=await response.json();if(!payload.result?.library)throw Error(t('目标不是可用的拾文服务','The target is not an available Shiwen service'));
   if(window){const answer=await dialog.showMessageBox(window,{type:'question',message:t('切换服务？','Switch service?'),detail:t('当前窗口将关闭，请先保存未提交的内容。原服务会继续运行。','The current window will close. Save drafts first. The previous service stays running.'),buttons:[t('取消','Cancel'),t('切换','Switch')],defaultId:0,cancelId:0});if(answer.response!==1){candidate.destroy();return {cancelled:true};}}
   await savePreference(next);
   const old=window;window=candidate;connected={mode:next.mode,origin,state,recognized};candidate=null;
   old?.destroy();
   window.webContents.on('will-prevent-unload',()=>{exitAllowed=false;quitting=false;});
   window.on('close',event=>{if(!exitAllowed){event.preventDefault();void requestQuit();}});
   window.webContents.on('did-fail-load',(_event,code,_description,_url,main)=>{if(main&&code!==-3)void showSettings(t('连接已断开，请确认服务运行后重新连接。','Connection lost. Check the service and reconnect.'));});
   window.show();settings?.close();updateMenu();console.log(`[shiwen-client] connected ${connected.mode} ${connected.origin}`);return {ok:true};
  }catch(error){candidate?.destroy();throw Error(message(error));}finally{connecting=false;}
 }
 async function requestQuit(){
  if(quitting||exitAllowed)return;
  if(connecting){await dialog.showMessageBox({message:t('正在连接，请连接完成后再退出。','Please wait for the connection attempt to finish.')});return;}
  quitting=true;
  try{
   const local=connected?.mode==='local'?connected.state:(!connected?localSeen:null);
   await quitConnection({local,choose:async()=>{
    const result=await ask({type:'question',message:t('是否同时停止本机独立服务？','Stop the local service too?'),detail:t('停止服务会断开手机和浏览器，并中断正在执行的任务。未保存的窗口草稿请先保存。','Stopping disconnects phones and browsers and interrupts running tasks. Save unsaved drafts first.'),buttons:[t('保留服务并退出','Keep service and quit'),t('停止服务并退出','Stop service and quit'),t('取消','Cancel')],defaultId:0,cancelId:2});return ['keep','stop','cancel'][result.response];
   },stop:()=>stopServer(base,local),quit:()=>{exitAllowed=true;app.quit();}});
  }catch(error){await ask({type:'error',message:t('未退出：服务未能安全停止','Not closed: service shutdown failed'),detail:message(error)});}finally{quitting=false;}
 }
 app.on('before-quit',event=>{if(!exitAllowed){event.preventDefault();void requestQuit();}});
 app.on('window-all-closed',()=>{if(!connecting&&!exitAllowed)void requestQuit();});
 app.on('second-instance',()=>{if(window){window.show();window.focus();}else void showSettings();});
 // Do not await ready at ESM top level: Electron waits for module evaluation first.
 void app.whenReady().then(async()=>{
 tray=new Tray(nativeImage.createFromPath(icon).resize({width:24,height:24}));tray.setToolTip(`拾文 v${version}`);tray.on('click',()=>{if(window){window.show();window.focus();}else void showSettings();});
 updateMenu();
 ipcMain.handle('connection:get',event=>{if(!trusted(event))throw Error('Forbidden');return {version,preference:preference??{mode:'local',lan:true,port:3080},language:zh()?'zh':'en',current:connected?{mode:connected.mode,origin:connected.origin}:null};});
 ipcMain.handle('connection:connect',async(event,input)=>{if(!trusted(event))throw Error('Forbidden');try{return await connect(input);}catch(error){return {error:message(error)};}});
 try{preference=connectionPreference(JSON.parse(await readFile(preferences,'utf8')));await connect(preference);}catch(error){if(error.code!=='ENOENT')console.error('[shiwen-client]',message(error));await showSettings(error.code==='ENOENT'?'':message(error));}
 }).catch(error=>{console.error('[shiwen-client]',message(error));app.exit(1);});
}
