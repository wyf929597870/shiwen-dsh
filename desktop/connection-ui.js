let language='zh';const form=document.querySelector('#connection'),error=document.querySelector('#error'),button=document.querySelector('#submit');
const text=(zh,en)=>language==='zh'?zh:en;
function sections(){const mode=form.elements.mode.value;document.querySelector('#local').hidden=mode!=='local';document.querySelector('#remote').hidden=mode!=='remote';}
form.addEventListener('change',sections);
window.shiwenConnection.onError(message=>{error.textContent=message;});
window.shiwenConnection.get().then(({preference,language:lang,current,version,lanAddresses,desktopPreferences,trayAvailable})=>{
 document.querySelector('#version').textContent='v'+version;
 const addresses=document.querySelector('#lanHost');for(const item of lanAddresses??[]){const option=document.createElement('option');option.value=item.address;option.textContent=`${item.name} · ${item.address}`;addresses.append(option);}if(preference.lanHost&&!Array.from(addresses.options).some(o=>o.value===preference.lanHost)){const option=document.createElement('option');option.value=preference.lanHost;option.textContent=preference.lanHost+' (不可用 / unavailable)';addresses.append(option);}addresses.value=preference.lanHost??'';
 language=lang;document.documentElement.lang=lang==='zh'?'zh-CN':'en';
 for(const item of document.querySelectorAll('[data-zh]'))item.textContent=item.dataset[lang];
 const closeAction=document.querySelector('#closeAction');closeAction.value=desktopPreferences?.closeAction??'quit';closeAction.dataset.saved=closeAction.value;closeAction.querySelector('[value=tray]').disabled=!trayAvailable;closeAction.disabled=false;
 form.elements.mode.value=preference.mode;document.querySelector('#lan').checked=preference.lan??true;document.querySelector('#port').value=preference.port??3080;document.querySelector('#address').value=preference.address??'';
 document.querySelector('#current').textContent=current?text('当前连接：','Connected to: ')+current.origin:text('资料保留在你选择的电脑上。','Your data stays on the computer you choose.');sections();
}).catch(e=>{error.textContent=e.message;});
form.addEventListener('submit',async event=>{event.preventDefault();button.disabled=true;button.textContent=text('正在连接…','Connecting…');error.textContent='';
 try{const result=await window.shiwenConnection.connect({mode:form.elements.mode.value,lan:document.querySelector('#lan').checked,lanHost:document.querySelector('#lanHost').value,port:document.querySelector('#port').value,address:document.querySelector('#address').value,password:document.querySelector('#password').value,remember:document.querySelector('#remember').checked});if(result.error)error.textContent=result.error;}
 catch(e){error.textContent=e.message;}finally{document.querySelector('#password').value='';button.disabled=false;button.textContent=text('连接资料库','Connect');}
});

document.querySelector('#closeAction').addEventListener('change',async event=>{
 const select=event.currentTarget,status=document.querySelector('#desktop-status');select.disabled=true;status.textContent=text('正在保存…','Saving…');
 try{const result=await window.shiwenConnection.saveDesktopPreferences({closeAction:select.value});select.dataset.saved=result.closeAction;status.textContent=text('已保存，立即生效。','Saved. Applies immediately.');}
 catch(e){select.value=select.dataset.saved;status.textContent=text('保存失败：','Could not save: ')+e.message;}
 finally{select.disabled=false;}
});
