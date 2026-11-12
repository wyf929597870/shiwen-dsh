import React from '../../android/node_modules/react/index.js';
import {createRoot} from '../../android/node_modules/react-dom/client.js';
import '../../android/web/style.css';
import '../../android/web/shell.css';
import '../../android/web/theme.css';
import {ChatPanel} from '../../android/web/ChatPanel.jsx';

const assert=(ok,message)=>{if(!ok)throw Error(message);};
const button=label=>[...document.querySelectorAll('button')].find(node=>node.textContent.trim()===label);
const pause=()=>new Promise(resolve=>setTimeout(resolve,10));
async function until(check){for(let i=0;i<150;i++){if(check())return;await pause();}throw Error('Timed out: '+check);}
let activeId='old-chat';
const conversations=[{id:'old-chat',title:'旧会话'},{id:'new-chat',title:'新会话'}];
const proposals=Array.from({length:3},(_,index)=>({id:'proposal-'+index,conversationId:'old-chat',status:'pending',action:'create',patch:{title:'运动记录 '+index,markdown:'## 运动记录\n\n'+('单臂划船与深蹲。\n\n'.repeat(100)),kind:'journal',contentDay:'2026-11-10',dateBasis:'用户指定',stage:'draft'}}));
const decisions=[],directSaves=[],sent=[];
export const isNative=true;
export async function call(method,args={}){
  if(method==='nodeList')return {items:[]};
  if(method==='agentConversations')return {items:conversations,activeId};
  if(method==='agentSelectConversation'){activeId=args.id;return {items:conversations,activeId};}
  if(method==='agentReadDraft')return {draft:null};
  if(method==='agentSaveDraft')return {};
  if(method==='agentStatus')return {status:'unknown'};
  if(method==='agentSend'){sent.push(args);return {status:'admitted'};}
  if(method==='agentAcknowledge')return {};
  if(method==='agentRecent')return {items:[{id:args.conversationId+'-task',input:'记录到今天的日记：晚上运动了。',output:'已整理保存建议，请确认。',status:'succeeded'}]};
  if(method==='agentRecordProposals')return {items:proposals.filter(item=>item.conversationId===args.conversationId).map(item=>({...item}))};
  if(method==='agentRecordDecide'){
    const item=proposals.find(item=>item.id===args.id&&item.conversationId===args.conversationId);
    assert(item,'Decision must belong to the selected conversation');
    decisions.push(args);item.status=args.accept?'applied':'rejected';item.recordId='saved-'+item.id;return {...item};
  }
  throw Error('Unexpected fixture method: '+method);
}
const root=createRoot(document.getElementById('root'));
document.documentElement.dataset.theme='light';
root.render(<div className="app">
  <header className="shell-header">皮皮 · 手机助手</header>
  <main className="chat-main"><ChatPanel ready config={{configured:true,revision:1}} onDirect={(text,options)=>directSaves.push({text,...options})}/>
    <button className="saved"><strong>后来直接保存的记录</strong><span>自己书写 · 2026-11-10</span><span className="confirmation">✓ 已保存到手机 · 等待同步</span></button>
  </main><nav><button>对话</button><button>素材</button><button>设置</button></nav>
</div>);

function reachable(node){
  node.scrollIntoView({block:'center'});
  const rect=node.getBoundingClientRect();
  const hit=document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2);
  assert(hit&&(hit===node||node.contains(hit)),'Control is clipped or covered: '+node.textContent);
}
function composerVisible(){
  const composer=document.querySelector('.agent-composer'),panel=document.querySelector('.chat-execution');
  const rect=composer.getBoundingClientRect(),bounds=panel.getBoundingClientRect();
  if(bounds.height>=rect.height)assert(rect.top>=bounds.top&&rect.bottom<=bounds.bottom+1,'Proposal pushed composer outside the chat viewport: '+JSON.stringify({top:rect.top,bottom:rect.bottom,panelTop:bounds.top,panelBottom:bounds.bottom}));
  const input=composer.querySelector('textarea'),style=getComputedStyle(input);
  assert(input.clientHeight<=60,'Chat input should stay compact by default');
  reachable(input);
}
async function run(){
  const passed=[];
  await until(()=>document.querySelector('[role="alertdialog"] .profile-actions'));
  assert(document.querySelector('[role="alertdialog"] select').options.length===3,'All pending proposals are selectable in the dialog');
  button('知道了').click();await pause();composerVisible();
  document.querySelector('.agent-proposals > button').click();await until(()=>document.querySelector('[role="alertdialog"] select'));
  let choices=document.querySelector('[role="alertdialog"] select');choices.value='proposal-2';choices.dispatchEvent(new Event('change',{bubbles:true}));await pause();
  reachable(button('拒绝'));button('拒绝').click();await until(()=>decisions.length===1);
  assert(!decisions[0].accept,'Reject must preserve other pending proposals');
  document.querySelector('.agent-proposals > button').click();await until(()=>button('确认执行'));
  const details=document.querySelector('[role="alertdialog"] article details');details.open=true;await pause();reachable(button('确认执行'));button('确认执行').click();
  await until(()=>decisions.length===2&&document.querySelector('[role="alertdialog"]')?.textContent.includes('资料操作已完成'));
  assert(decisions[1].accept,'Apply should dispatch exactly one decision');
  button('知道了').click();await pause();composerVisible();
  assert(!document.querySelector('.composer-more'), 'The plus menu should be removed');
  const saveOption=document.querySelector('.composer-save-option input');saveOption.click();await until(()=>document.querySelector('[role=alertdialog]'));button('取消').click();await pause();assert(!saveOption.checked,'Cancel must not enable saving');
  saveOption.click();await until(()=>button('读书笔记'));assert(button('网页')&&button('AI 讨论')&&button('参考资料'),'all material types should be available');button('想法').click();await pause();assert(saveOption.checked&&button('想法 ▾'),'Choosing a type must enable saving');saveOption.click();await pause();assert(!saveOption.checked,'Save option can be disabled');
  button('展开输入框').click();await pause();
  {const input=document.querySelector('.agent-composer textarea'),style=getComputedStyle(input);assert(input.clientHeight-parseFloat(style.paddingTop)-parseFloat(style.paddingBottom)>=5*parseFloat(style.lineHeight)-1,'Expanded input must show five lines: '+JSON.stringify({height:input.clientHeight,line:style.lineHeight,padding:style.paddingTop,cls:input.closest('.agent-composer').className}));}
  button('缩小输入框').click();await pause();composerVisible();
  document.querySelector('.user-message.chat-message-tappable').click();await until(()=>button('保存到资料'));button('保存到资料').click();await pause();
  assert(directSaves[0]?.submit===true && directSaves[0]?.origin==='personal' && directSaves[0]?.text.includes('晚上运动'), 'User message must preserve its original text and personal origin');
  document.querySelector('.agent-message .chat-message-tappable').click();await until(()=>button('保存到资料'));button('保存到资料').click();await pause();
  assert(directSaves[1]?.submit===true && directSaves[1]?.origin==='ai' && directSaves[1]?.kind==='ai', 'Assistant message must preserve AI origin');
  passed.push('pending proposals and receipts use dialogs while chat input remains reachable');
  document.querySelector('.session-trigger').click();await until(()=>document.querySelector('.session-sheet'));
  [...document.querySelectorAll('.session-sheet-pick')].find(node=>node.textContent.includes('新会话')).click();
  await until(()=>activeId==='new-chat'&&!document.querySelector('.agent-proposals'));
  assert(document.querySelector('.saved'),'The separate direct-save receipt remains independent');
  document.querySelector('.session-trigger').click();await until(()=>document.querySelector('.session-sheet'));
  [...document.querySelectorAll('.session-sheet-pick')].find(node=>node.textContent.includes('旧会话')).click();
  await until(()=>document.querySelector('.agent-proposals > button'));
  if(button('知道了'))button('知道了').click();
  document.querySelector('.agent-proposals > button').click();await until(()=>button('确认执行'));reachable(button('确认执行'));
  button('知道了').click();await pause();composerVisible();
  passed.push('switching conversations restores only their own unresolved proposals');
  const input=document.querySelector('.agent-composer textarea');input.focus();
  const nativeSetter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;
  nativeSetter.call(input,'测试发送');input.dispatchEvent(new Event('input',{bubbles:true}));await until(()=>!button('发送').disabled);
  const sendButton=button('发送'),before=sendButton.getBoundingClientRect();
  const down=new PointerEvent('pointerdown',{bubbles:true,cancelable:true,pointerType:'touch'});sendButton.dispatchEvent(down);
  assert(down.defaultPrevented,'Sending must preserve the focused editor on pointer down');
  const after=sendButton.getBoundingClientRect();assert(Math.abs(before.top-after.top)<1,'Send button must not move during the first tap');
  sendButton.click();await until(()=>sent.length===1);assert(sent[0].input==='测试发送','First tap should send the submitted text');
  passed.push('first send tap keeps the target stable and submits once');
  document.getElementById('result').textContent=JSON.stringify({passed});
}
run().catch(error=>{document.getElementById('result').textContent=JSON.stringify({error:error.stack});});
