import React from '../../android/node_modules/react/index.js';
import {createRoot} from '../../android/node_modules/react-dom/client.js';
import {RecordPanel} from '../../android/web/RecordPanel.jsx';

const clone = value => JSON.parse(JSON.stringify(value));
const assert = (ok, message) => { if (!ok) throw Error(message); };
const pause = () => new Promise(resolve => setTimeout(resolve, 10));
async function until(check) { for (let i=0;i<150;i++) { if(check())return; await pause(); } throw Error('Timed out: '+check); }
const button = label => [...document.querySelectorAll('button')].find(node=>node.textContent.trim()===label);
let row, draft, writes, receipts, pageState, failAfterWrite, failDraft, root;
const base = () => ({id:'record-1',title:'Fixture',markdown:'Original',kind:'journal',origin:'personal',processing:'original',contentDay:'2026-11-07',dateBasis:'',url:null,annotation:null,stage:null,sourceIds:[],sources:[],revision:1,state:'synced',syncState:'synced',attachmentDescriptors:[],versionId:'old-version',serverRevision:1,deleted:false});
export async function call(method, args) {
  if(method==='recordDraftRead')return {draft:clone(draft),nextGeneration:draft?.localGeneration+1||0};
  if(method==='recordDraftSave') {
    if(failDraft){failDraft=false;throw Error('RECORD_DRAFT_TOO_LARGE');}
    if(draft){
      assert(args.localGeneration>=draft.localGeneration,'RECORD_DRAFT_STALE');
      if(args.localGeneration===draft.localGeneration){
        assert(args.requestId===draft.requestId&&JSON.stringify(args.content)===JSON.stringify(draft.content),'RECORD_DRAFT_GENERATION_REUSED');
        if(draft.pendingMutation)assert(JSON.stringify(args.pendingMutation)===JSON.stringify(draft.pendingMutation),'RECORD_DRAFT_PENDING_IMMUTABLE');
      } else assert(!draft.pendingMutation,'RECORD_DRAFT_PENDING_LOCKED');
    }
    draft=clone(args);return {saved:true};
  }
  if(method==='recordDraftAcknowledge') {const cleared=draft?.requestId===args.requestId&&draft?.localGeneration===args.localGeneration;if(cleared)draft=null;return {cleared};}
  if(method==='recordList')return {items:[clone(row)]};
  if(method==='recordRead')return clone(row);
  if(method==='recordAttachments')return {items:[]};
  if(method==='recordVersions')return {items:[]};
  if(method==='recordUpdate'||method==='recordCreate'){
    const input=args.patch||args.record;
    if(!receipts.has(args.requestId)){
      if(method==='recordUpdate')assert(args.expectedRevision===row.revision,'RECORD_REVISION_CONFLICT');
      writes.push(clone(args));receipts.set(args.requestId,JSON.stringify(input));
      row={...row,...clone(input),revision:row.revision+1,syncState:'pending'};
    }else assert(receipts.get(args.requestId)===JSON.stringify(input),'REQUEST_REUSED');
    if(failAfterWrite){failAfterWrite=false;throw Error('BRIDGE_RESPONSE_LOST');}
    return {record:clone(row),syncState:'pending'};
  }
  throw Error('Unexpected method '+method);
}
const stateChanged = value => {pageState=value;};
async function mount(mode='materials'){
  root=createRoot(document.getElementById('root'));
  root.render(<RecordPanel libraryId="fixture" mode={mode} onPageStateChange={stateChanged}/>);
  await until(()=>pageState&&!pageState.busy);
}
async function reset(mode='materials'){
  if(root)root.unmount();row=base();draft=null;writes=[];receipts=new Map();pageState=null;failAfterWrite=false;failDraft=false;
  if(mode==='articles'){row.kind='article';row.sourceIds=['source-1'];}
  await mount(mode);
}
async function edit(){await until(()=>document.querySelector('.record-list-row'));document.querySelector('.record-list-row').click();await until(()=>button('编辑'));button('编辑').click();await until(()=>button('保存'));}
async function save(){button('保存').click();await pause();await until(()=>!pageState.busy);}
async function typeBody(value){
  const field=document.querySelector('.record-editor');
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(field,value);
  field.dispatchEvent(new Event('input',{bubbles:true}));await pause();
}
async function run(){
  const passed=[];
  await reset();await edit();await save();
  assert(writes.length===1&&!draft,'material saves and acknowledges');
  assert(!('state' in writes[0].patch)&&!('attachmentDescriptors' in writes[0].patch),'view metadata must not be written');
  assert(writes[0].patch.sources[0].text==='Original','empty sources normalized without reusing draft generation');
  assert(!pageState.busy&&!pageState.dirty,'saved editor releases navigation');passed.push('material save and navigation');

  await reset();await edit();await typeBody('手机修改的正文 📝');await save();
  assert(row.markdown==='手机修改的正文 📝'&&writes.length===1&&!draft,'edited body reaches local write');
  assert(row.sources.map(segment=>segment.text).join('')===row.markdown,'body source segments follow editing');
  passed.push('changed material body');

  await reset();await until(()=>button('＋ 新建记录'));button('＋ 新建记录').click();
  await until(()=>document.querySelector('.record-editor'));await typeBody('新日记');await save();
  assert(writes.length===1&&writes[0].record.markdown==='新日记'&&!draft,'new material creation survives source normalization');
  passed.push('new material');

  await reset('articles');await edit();await save();
  assert(writes.length===1&&writes[0].patch.sourceIds[0]==='source-1'&&!draft,'article associations preserved');passed.push('article save');

  await reset();await edit();failAfterWrite=true;await save();
  assert(draft?.pendingMutation&&button('再次核对保存结果'),'lost response retains retry');
  assert(!pageState.busy&&!pageState.dirty,'durable pending write permits navigation');
  root.unmount();pageState=null;await mount();
  await until(()=>button('再次核对保存结果'));
  button('再次核对保存结果').click();await until(()=>!draft);
  assert(writes.length===1,'lost receipt replay must not duplicate revision');passed.push('lost response, navigation, remount and exact replay');

  await reset();root.unmount();pageState=null;
  const pending={action:'update',requestId:crypto.randomUUID(),record:clone(row),create:false,id:row.id,expectedRevision:row.revision,localGeneration:7};
  draft={requestId:pending.requestId,localGeneration:7,content:{form:clone(row),selectedId:row.id,creating:false,editing:true,pendingAction:null},pendingMutation:pending};
  await mount();await until(()=>button('再次核对保存结果'));button('再次核对保存结果').click();await until(()=>!draft);
  assert(writes.length===1&&writes[0].requestId===pending.requestId&&writes[0].patch.state==='synced','old frozen request replays unchanged for native compatibility');passed.push('existing release pending draft recovery');

  await reset();await edit();failDraft=true;await save();
  assert(!writes.length&&button('保存')&&!document.querySelector('textarea').disabled,'definitive draft failure remains editable');
  await save();assert(writes.length===1&&!draft,'draft failure can be corrected and retried');passed.push('draft failure before mutation');

  root.unmount();document.body.innerHTML='<pre id="result"></pre>';document.getElementById('result').textContent=JSON.stringify({passed});
}
run().catch(error=>{document.body.innerHTML='<pre id="result"></pre>';document.getElementById('result').textContent=JSON.stringify({error:error.stack});});
