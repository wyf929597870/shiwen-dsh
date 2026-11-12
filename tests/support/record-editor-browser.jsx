import React from '../../android/node_modules/react/index.js';
import {createRoot} from '../../android/node_modules/react-dom/client.js';
import '../../android/web/style.css';
import '../../android/web/theme.css';
import '../../android/web/shell.css';
import {RecordPanel} from '../../android/web/RecordPanel.jsx';

const clone = value => JSON.parse(JSON.stringify(value));
const assert = (ok, message) => { if (!ok) throw Error(message); };
const pause = () => new Promise(resolve => setTimeout(resolve, 10));
async function until(check) { for (let i=0;i<150;i++) { if(check())return; await pause(); } throw Error('Timed out: '+check); }
const button = label => [...document.querySelectorAll('button')].find(node=>node.textContent.trim()===label);
let row, draft, writes, receipts, pageState, failAfterWrite, failDraft, root, deletedStages, imageDelay, otherJournal, raceJournal;
let annotationDrafts=new Map(),annotations=[],annotationReceipts=new Map(),annotationWrites=[];
const base = () => ({id:'record-1',title:'Fixture',markdown:'Original',kind:'journal',origin:'personal',processing:'original',contentDay:'2026-11-07',dateBasis:'',url:null,annotation:null,stage:null,sourceIds:[],sources:[],revision:1,state:'synced',syncState:'synced',attachmentDescriptors:[],versionId:'old-version',serverRevision:1,deleted:false});
export const isNative = true;
export async function call(method, args) {
  if(method==='legacyAnnotationDrafts')return {recordIds:[...annotationDrafts.keys()].map(slot=>slot.replace(/^annotation:/,''))};
  if(method.startsWith('recordDraft')&&args.slot?.startsWith('annotation:')){
    const current=annotationDrafts.get(args.slot);
    if(method==='recordDraftRead')return {draft:clone(current||null),nextGeneration:(current?.localGeneration||0)+1};
    if(method==='recordDraftSave'){if(current?.pendingMutation)assert(args.localGeneration===current.localGeneration&&JSON.stringify(args.pendingMutation)===JSON.stringify(current.pendingMutation),'ANNOTATION_PENDING_CHANGED');annotationDrafts.set(args.slot,clone(args));return {saved:true};}
    if(method==='recordDraftAcknowledge'){const cleared=current?.requestId===args.requestId&&current?.localGeneration===args.localGeneration;if(cleared)annotationDrafts.delete(args.slot);return {cleared};}
  }
  if(method==='originalVersionInfo')return {recordId:row.id,versionId:row.versionId,contentHash:'b'.repeat(64),revision:row.revision};
  if(method==='annotationList')return {items:clone(annotations.filter(x=>!!x.deleted===!!args.deleted))};
  if(method==='annotationCreate'||method==='annotationUpdate'||method==='annotationDelete'||method==='annotationRestore'){
    if(!annotationReceipts.has(args.requestId)){
      let item=annotations.find(x=>x.id===args.id);
      if(method==='annotationCreate'){item={id:'annotation-'+annotations.length,kind:'ai_annotation',origin:'ai',revision:1,versionId:'annotation-version',title:args.title||'',markdown:args.body,annotationOf:{recordId:args.originalId,versionId:args.originalVersionId,contentHash:args.originalContentHash},attachmentDescriptors:args.attachmentDescriptors||[],deleted:false};annotations.push(item);}
      else{assert(item&&item.revision===args.revision,'RECORD_REVISION_CONFLICT');if(method==='annotationUpdate'){item.markdown=args.body;item.title=args.title;item.attachmentDescriptors=args.attachmentDescriptors||item.attachmentDescriptors;}else item.deleted=method==='annotationDelete';item.revision++;}
      annotationWrites.push(clone(args));annotationReceipts.set(args.requestId,{args:JSON.stringify(args),id:item.id});
    }else assert(annotationReceipts.get(args.requestId).args===JSON.stringify(args),'REQUEST_REUSED');
    if(failAfterWrite){failAfterWrite=false;throw Error('BRIDGE_RESPONSE_LOST');}
    return clone(annotations.find(x=>x.id===annotationReceipts.get(args.requestId).id));
  }
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
  if(method==='recordList')return {items:args.kind==='journal'&&otherJournal?[clone(otherJournal)]:[clone(row)]};
  if(method==='recordRead')return clone(row);
  if(method==='recordAttachments')return {items:clone(row.attachmentDescriptors)};
  if(method==='recordVersions')return {items:row.historicalMarkdown?[{id:'version-1',markdown:row.historicalMarkdown,reason:'history',doc:{attachmentDescriptors:row.historicalAttachments}}]:[]};
  if(method==='attachmentPick')return {items:[{id:'12345678-1234-4123-8123-123456789abc',name:'photo.png',hash:'a'.repeat(64),byteLength:10,mimeType:'image/png'}]};
  if(method==='attachmentStageDelete'){deletedStages.push(...args.ids);return {deleted:args.ids.length};}
  if(method==='attachmentImageRead'){if(imageDelay)await new Promise(resolve=>setTimeout(resolve,imageDelay));if(args.expectedHash==='a'.repeat(64))return {mimeType:'image/png',byteLength:8,dataBase64:'iVBORw0KGgo=',sha256:args.expectedHash};throw Error('ATTACHMENT_NOT_AVAILABLE');}
  if(method==='recordUpdate'||method==='recordCreate'){
    const input=args.patch||args.record;
    if(method==='recordUpdate'&&raceJournal){raceJournal=false;draft.pendingMutation=null;throw Error('JOURNAL_DAY_EXISTS');}
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
  root.render(<div className="app"><header className="shell-header">拾文</header><main><RecordPanel libraryId="fixture" mode={mode} onPageStateChange={stateChanged}/></main></div>);
  await until(()=>pageState&&!pageState.busy);
}
async function reset(mode='materials'){
  if(root)root.unmount();row=base();draft=null;writes=[];deletedStages=[];receipts=new Map();pageState=null;failAfterWrite=false;failDraft=false;imageDelay=0;otherJournal=null;raceJournal=false;annotationDrafts=new Map();annotations=[];annotationReceipts=new Map();annotationWrites=[];
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
  assert(document.querySelector('[role="alertdialog"]')&&button('知道了'),'save feedback opens a dismissible dialog');
  document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await pause();
  assert(!document.querySelector('[role="alertdialog"]'),'Escape dismisses feedback dialog');
  assert(!('state' in writes[0].patch)&&!('attachmentDescriptors' in writes[0].patch),'view metadata must not be written');
  assert(writes[0].patch.sources[0].text==='Original','empty sources normalized without reusing draft generation');
  assert(!pageState.busy&&!pageState.dirty,'saved editor releases navigation');passed.push('material save and navigation');

  await reset();await edit();await typeBody('手机修改的正文 📝');await save();
  assert(row.markdown==='手机修改的正文 📝'&&writes.length===1&&!draft,'edited body reaches local write');
  assert(row.sources.map(segment=>segment.text).join('')===row.markdown,'body source segments follow editing');
  passed.push('changed material body');

  await reset();await until(()=>button('＋ 新建记录'));button('＋ 新建记录').click();
  await until(()=>document.querySelector('.record-editor'));
  assert(!document.querySelector('[role=alertdialog]')&&document.querySelector('.record-journal-note'),'journal guidance appears inline');
  const typeControl=document.querySelector('.record-kind-control');
  assert(typeControl&&typeControl.getBoundingClientRect().bottom<=document.querySelector('.record-editor').getBoundingClientRect().top,'record type should appear before the body editor');
  assert(typeControl.getBoundingClientRect().bottom<=window.innerHeight,'record type should be visible when the editor opens');
  await typeBody('新日记');await save();
  assert(writes.length===1&&writes[0].record.markdown==='新日记'&&!draft,'new material creation survives source normalization');
  passed.push('new material');

  await reset('articles');await edit();await save();
  assert(writes.length===1&&writes[0].patch.sourceIds[0]==='source-1'&&!draft,'article associations preserved');passed.push('article save');

  await reset();row.kind='article';row.sourceIds=['source-1'];row.stage='final';await edit();await typeBody('文章的小修改');await save();
  assert(writes.length===1&&writes[0].patch.kind==='article'&&writes[0].patch.stage==='final'&&writes[0].patch.sourceIds[0]==='source-1','article edited from materials preserves type, stage and source links');
  passed.push('article metadata survives unified materials editing');

  await reset();row.kind='idea';otherJournal={...base(),id:'other-journal'};await edit();
  document.querySelector('.record-kind-control').click();await until(()=>button('日记'));button('日记').click();await pause();await save();
  assert(writes.length===0&&document.body.textContent.includes('当天已有日记')&&!document.querySelector('.record-editor').disabled,'journal conflict preserves editable content without writing');
  passed.push('journal type conversion conflict remains editable');

  await reset();row.kind='idea';raceJournal=true;await edit();
  document.querySelector('.record-kind-control').click();await until(()=>button('日记'));button('日记').click();await pause();await save();
  assert(writes.length===0&&draft&&!draft.pendingMutation&&!document.querySelector('.record-editor').disabled,'journal race retains a durable editable draft');
  passed.push('journal race retains editable draft');

  await reset('articles');await edit();button('插入图片').click();await until(()=>document.querySelector('.record-editor').value.includes('attachment:12345678-1234-4123-8123-123456789abc'));
  await save();assert(writes.length===1&&writes[0].stagedAttachmentIds?.length===1,'article image is committed with its record');
  assert(writes[0].patch.attachmentDescriptors?.[0]?.id==='12345678-1234-4123-8123-123456789abc','image descriptor included in write');passed.push('article image insert and save');

  await reset();await edit();button('插入图片').click();await until(()=>document.querySelector('.record-editor').value.includes('attachment:12345678-1234-4123-8123-123456789abc'));
  await typeBody('Removed image');await save();await until(()=>deletedStages.length===1);
  assert(!writes[0].stagedAttachmentIds.length,'removed image is not committed');passed.push('removed image staging cleaned after acknowledgement');

  await reset();await edit();button('插入图片').click();await until(()=>document.querySelector('.record-editor').value.includes('attachment:12345678-1234-4123-8123-123456789abc'));
  failAfterWrite=true;await save();assert(draft?.pendingMutation&&!deletedStages.length,'unconfirmed image save retains staged bytes');
  root.unmount();pageState=null;await mount();await until(()=>button('再次核对保存结果'));button('再次核对保存结果').click();await until(()=>!draft&&deletedStages.length===1);
  assert(writes.length===1,'image retry does not duplicate write');passed.push('image staging retained through uncertain save and cleaned after retry');

  await reset();const imageId='12345678-1234-4123-8123-123456789abc',historicalId='87654321-4321-4321-8321-123456789abc';imageDelay=30;row.markdown='Synthetic paragraph.\n\n'.repeat(800)+`## **Heading**\n![current](attachment:${imageId})`;row.historicalMarkdown=`![history](attachment:${historicalId})`;row.attachmentDescriptors=[{id:imageId,name:'photo.png',hash:'a'.repeat(64),byteLength:8}];row.historicalAttachments=[{id:historicalId,name:'old.png',hash:'a'.repeat(64),byteLength:8}];
  await until(()=>document.querySelector('.record-list-row'));document.querySelector('.record-list-row').click();await until(()=>document.querySelector('.markdown-view img'));
  assert(document.querySelector('.record-detail .markdown-view img'),'current image survives record panel rerenders');
  passed.push('current images use attachment identity');

  await reset();await edit();await typeBody('![missing](attachment:99999999-9999-4999-8999-999999999999)');await save();
  assert(!writes.length&&document.body.textContent.includes('正文引用的图片不存在'),'new missing image cannot be saved');
  await typeBody('`![example](attachment:99999999-9999-4999-8999-999999999999)`');await save();assert(writes.length===1,'code example is not treated as an image');passed.push('missing image rejected without blocking code examples');

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

  await reset();annotationDrafts.set('annotation:record-1',{localGeneration:1,content:{editor:{title:'',body:'',info:{recordId:row.id,versionId:row.versionId,contentHash:'b'.repeat(64),revision:row.revision},requestId:crypto.randomUUID(),staged:[],descriptors:[]}}});root.unmount();pageState=null;await mount();await until(()=>[...document.querySelectorAll('button')].some(node=>node.textContent.includes('继续旧标注草稿')));[...document.querySelectorAll('button')].find(node=>node.textContent.includes('继续旧标注草稿')).click();await until(()=>document.querySelector('.annotation-panel textarea'));await typeBody('手机 AI 标注');
  button('插入图片').click();await until(()=>document.querySelector('.annotation-panel textarea').value.includes('attachment:'));failAfterWrite=true;button('保存').click();await until(()=>button('再次核对保存结果')&&!button('再次核对保存结果').disabled);
  assert(row.markdown==='Original'&&annotations.length===1,'annotation create leaves original unchanged');
  assert(document.querySelector('.annotation-panel textarea').disabled,'uncertain annotation frozen');
  root.unmount();pageState=null;await mount();await until(()=>document.querySelector('.record-list-row'));document.querySelector('.record-list-row').click();await until(()=>button('再次核对保存结果')&&!button('再次核对保存结果').disabled);button('再次核对保存结果').click();await until(()=>!document.querySelector('.annotation-panel textarea'));
  assert(!annotationDrafts.size,'annotation pending draft acknowledged after remount');assert(annotations.length===1&&annotationWrites.length===1,'annotation retry is idempotent after remount');assert(annotations[0].attachmentDescriptors.length===1,'annotation image descriptors preserved');passed.push('annotation independent image save and durable retry');

  for(const mode of ['materials','articles']){
    await reset(mode);row.markdown='这是一段用于验证长文滚动的隔离测试正文。\n\n'.repeat(80);
    await until(()=>document.querySelector('.record-list-row'));document.querySelector('.record-list-row').click();await until(()=>button('编辑'));
    const main=document.querySelector('.app>main');main.scrollTop=main.scrollHeight/2;await pause();
    const reachable=node=>{const rect=node.getBoundingClientRect(),hit=document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2);assert(hit&&(hit===node||node.contains(hit)),'Sticky control is clipped: '+node.textContent);};
    reachable(button('编辑'));
    button('编辑').click();await until(()=>document.querySelector('.record-editor'));
    const input=document.querySelector('.record-editor');
    assert(input.getBoundingClientRect().height>=360,'Record body editor must have room for long text');
    main.scrollTop=140;await pause();reachable(button('保存'));reachable(button('插入图片'));
    input.scrollTop=input.scrollHeight;await typeBody(row.markdown+'修改末尾');await save();
    assert(row.markdown.endsWith('修改末尾'),'Sticky save retains long edited body');
    passed.push(mode+': sticky read/edit actions, more menu and large body editor');
  }
  const result=document.createElement('pre');result.id='result';result.hidden=true;result.textContent=JSON.stringify({passed});document.body.append(result);
}
run().catch(error=>{document.body.innerHTML='<pre id="result"></pre>';document.getElementById('result').textContent=JSON.stringify({error:error.stack});});
