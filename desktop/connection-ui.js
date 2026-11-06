let language='zh';const form=document.querySelector('#connection'),error=document.querySelector('#error'),button=document.querySelector('#submit');
const text=(zh,en)=>language==='zh'?zh:en;
function sections(){const mode=form.elements.mode.value;document.querySelector('#local').hidden=mode!=='local';document.querySelector('#remote').hidden=mode!=='remote';}
form.addEventListener('change',sections);
window.shiwenConnection.onError(message=>{error.textContent=message;});
window.shiwenConnection.get().then(({preference,language:lang,current,version})=>{
 document.querySelector('#version').textContent='v'+version;
 language=lang;document.documentElement.lang=lang==='zh'?'zh-CN':'en';
 for(const item of document.querySelectorAll('[data-zh]'))item.textContent=item.dataset[lang];
 form.elements.mode.value=preference.mode;document.querySelector('#lan').checked=preference.lan??true;document.querySelector('#port').value=preference.port??3080;document.querySelector('#address').value=preference.address??'';
 document.querySelector('#current').textContent=current?text('当前连接：','Connected to: ')+current.origin:text('资料保留在你选择的电脑上。','Your data stays on the computer you choose.');sections();
}).catch(e=>{error.textContent=e.message;});
form.addEventListener('submit',async event=>{event.preventDefault();button.disabled=true;button.textContent=text('正在连接…','Connecting…');error.textContent='';
 try{const result=await window.shiwenConnection.connect({mode:form.elements.mode.value,lan:document.querySelector('#lan').checked,port:document.querySelector('#port').value,address:document.querySelector('#address').value,password:document.querySelector('#password').value,remember:document.querySelector('#remember').checked});if(result.error)error.textContent=result.error;}
 catch(e){error.textContent=e.message;}finally{document.querySelector('#password').value='';button.disabled=false;button.textContent=text('连接资料库','Connect');}
});
