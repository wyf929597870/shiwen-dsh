const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('shiwenConnection',{
 get:()=>ipcRenderer.invoke('connection:get'),
 connect:value=>ipcRenderer.invoke('connection:connect',value),
 onError:callback=>ipcRenderer.on('connection-error',(_event,message)=>callback(message))
});
