// Bridge fixture for the normal Android entry point, scoped to one disposable library.
import '../../android/web/main.jsx';
export const isNative=true;
export const leaveApp=()=>{};
const libraryId='workbench-fixture';
export const bootstrap=async()=>({libraryId,role:'standalone',integrity:'complete',pageGeneration:1});
const make=(id,title,kind,markdown,extra={})=>({id,title,kind,markdown,revision:1,origin:'personal',contentDay:'2026-11-19',stage:'draft',sources:[],sourceIds:[],...extra});
const rows=[make('idea','持续记录','idea','持续记录日常的细节'),make('web','记录的方法','web','用具体的观察练习持续记录'),
  make('book','写作与观察','reading_note','',{annotation:JSON.stringify({schema:'shiwen.reading-note.v2',noteType:'excerpt',chapter:'观察生活',excerpts:[{text:'写日记时，先把眼前的细节记下来。',page:'12'}]})})];
const otherThemes=Array.from({length:35},(_,i)=>({id:'topic-'+i,title:'观察笔记 '+(i+1),summary:'示例说明',revision:1,memberCount:0,members:[]}));
let savedTheme;
export async function call(method,args={}){
 switch(method){
 case 'appInfo':return {versionName:'0.1.34'};
 case 'libraryConnectionStatus':return {libraryId,state:'local'};
 case 'libraryList':return {activeId:libraryId,items:[{libraryId,name:'测试资料库',role:'standalone'}]};
 case 'settingsGet':return {theme:new URLSearchParams(location.search).get('theme')||'light',language:'zh-CN'};
 case 'recordDraftRead':case 'readDraft':return {draft:null,nextGeneration:0};
 case 'agentConversations':return {activeId:'session',items:[{id:'session',title:'日常记录'}]};
 case 'agentRecent':return {items:[]};
 case 'legacyAnnotationDrafts':return {recordIds:[]};
 case 'recordList':if(args.excludeKind==='article')return {items:[],nextCursor:null};return {items:rows.filter(x=>(!args.kind||x.kind===args.kind)&&(!args.section||x.kind===({library:'idea',collections:'web'}[args.section]))),nextCursor:null};
 case 'recordReferenceTitles':return {items:rows.filter(row=>args.ids.includes(row.id)).map(({id,title})=>({id,title,deleted:false}))};
 case 'recordRead':return rows.find(x=>x.id===args.id);
 case 'recordCreate':rows.push({...args.record,revision:1});return {record:rows.at(-1)};
 case 'workspaceSearch':{
   const candidates=args.related?[...rows,...Array.from({length:15},(_,i)=>make('branch'+i,'观察生活中的细节与写作习惯 '.repeat(3)+i,'idea','记录观察 '+i))]:rows;
   const items=candidates.flatMap(row=>{
     const excerpt=row.annotation&&JSON.parse(row.annotation).excerpts[0].text;
     const text=excerpt||row.markdown;if(!args.related&&!text.includes(args.query))return [];
     return [{recordId:row.id,kind:row.kind,title:row.title,revision:1,origin:row.origin,match:{field:excerpt?'excerpt':'body',text,anchor:{start:0,end:text.length,...(excerpt?{excerptIndex:0}:{})}}}];
   });
   return {items,nextOffset:null,total:items.length,libraryScope:libraryId};
 }
 case 'workspaceThemes':{
   const a=args.args;
   if(args.method==='themeSave')savedTheme={...a,id:'theme',revision:1,members:[],memberCount:0};
   if(args.method==='themeMemberAdd'){savedTheme.members.push({id:'link',sourceRecordId:a.sourceRecordId,sourceTitle:'写作与观察',sourceKind:'reading_note',field:a.field,quote:JSON.parse(rows[2].annotation).excerpts[0].text,location:{status:'current'}});savedTheme.memberCount++;savedTheme.revision++;}
   const topics=savedTheme?[...otherThemes,savedTheme]:otherThemes;
   return {result:args.method==='themeList'?topics:args.method==='themeRead'?topics.find(row=>row.id===a.id):savedTheme};
 }
 default:return {items:[]};
 }
}
const wait=async fn=>{for(let i=0;i<240;i++){const v=fn();if(v)return v;await new Promise(r=>setTimeout(r,20));}throw Error('Timed out: '+fn);};
const el=selector=>document.querySelector(selector);
const button=(title,parent=document)=>[...parent.querySelectorAll('button')].find(b=>b.textContent.trim()===title&&!b.disabled);
const click=async fn=>(await wait(fn)).click();
function input(node,value){Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(node,value);node.dispatchEvent(new Event('input',{bubbles:true}));}
async function run(){
 const section=name=>click(()=>button(name,el('.mw-sections')||document.createElement('div')));
 await wait(()=>el('.app-version')?.textContent==='v0.1.34');
 await click(()=>button('资料库'));
 await wait(()=>el('.record-list-row')?.textContent.includes('持续记录'));
 await section('收藏');await wait(()=>el('.record-list-row')?.textContent.includes('记录的方法'));
 await section('主题');await click(()=>button('新建主题'));
 input(await wait(()=>el('[aria-label="主题标题"]')),'观察素材');await click(()=>button('保存主题'));
 await wait(()=>savedTheme&&el('[aria-label="主题标题"]')?.value===savedTheme.title&&el('.sw-theme-actions .sw-danger')&&!el('.sw-theme-actions .sw-danger').disabled);
 await click(()=>button('‹ 返回主题列表'));
 const list=await wait(()=>el('.mw-themes .sw-list:not([hidden])'));
 const chosen=[...list.querySelectorAll('button')].at(-3);
 chosen.scrollIntoView({block:'center'});
 const scroll=el('.app > main'),listTop=scroll.scrollTop;
 if(listTop<=0)throw Error('Long themes list did not scroll');
 chosen.click();
 await wait(()=>el('[aria-label="主题标题"]')?.value===chosen.querySelector('strong').textContent);
 if(list.getClientRects().length||scroll.scrollTop!==0||el('.mw-themes .sw-detail').getBoundingClientRect().top>=innerHeight)throw Error('Theme detail did not open at the top');
 const confirm=window.confirm;window.confirm=()=>false;
 input(el('[aria-label="主题标题"]'),'尚未保存');window.__shiwenBack();
 await wait(()=>el('[aria-label="主题标题"]')?.value==='尚未保存');
 await new Promise(resolve=>setTimeout(resolve,40));
 if(!list.hidden)throw Error('Back discarded unconfirmed edits');
 window.confirm=()=>true;window.__shiwenBack();
 await wait(()=>!list.hidden&&scroll.scrollTop===listTop).catch(()=>{throw Error('List restoration: hidden='+list.hidden+', actual='+scroll.scrollTop+', expected='+listTop+', limit='+(scroll.scrollHeight-scroll.clientHeight));});
 window.confirm=confirm;
 await section('全局搜索');
 input(await wait(()=>el('.mw-search input')),'日记');await click(()=>el('.sw-search-result'));
 await wait(()=>el('.mw-source mark')?.textContent.includes('日记'));
 await click(()=>button('加入主题',el('.mw-source')));
 const add=()=>el('.mw-source .sw-theme-popover');await wait(add);
 await click(()=>[...add().querySelectorAll('button')].find(b=>!b.disabled&&/加入|添加/.test(b.textContent)));
 await wait(()=>savedTheme.memberCount===1);window.__shiwenBack();await wait(()=>!el('.mw-source'));
 await section('读书');await click(()=>el('.rn-list-item,.rn-card button,.rn-preview-card'));
 await wait(()=>el('.rn-mode-detail .rn-detail-excerpt'));
 if(el('.rn-detail-thought'))throw Error('Empty reflection');
 if(new URLSearchParams(location.search).get('screen')==='reading')return;
 await click(()=>button('展开相关内容'));
 const tree=await wait(()=>el('.mw-related-tree'));
 const first=await wait(()=>tree.querySelector(':scope > li > ul .mw-tree-row'));
 const viewport=el('.mw-tree-scroll'),footer=el('.mw-tree-footer');
 const expand=row=>row.querySelector('.mw-tree-toggle').click();
 const check=row=>row.querySelector('input').click();
 const firstDescendant=row=>row.nextElementSibling?.querySelector('.mw-tree-row');
 const fits=()=>viewport.scrollWidth===viewport.clientWidth&&viewport.clientHeight>0
   &&footer.getBoundingClientRect().bottom<=innerHeight+1;
 if(!fits()||viewport.scrollTop!==0)throw Error('Initial tree layout');
 check(tree.querySelector('.mw-tree-row'));check(first);
 if(new URLSearchParams(location.search).get('screen')==='canvas')return;
 expand(first);
 const child=await wait(()=>firstDescendant(first));
 expand(child);
 const grandchild=await wait(()=>firstDescendant(child));
 if(!fits()||Math.abs(child.getBoundingClientRect().left-grandchild.getBoundingClientRect().left)>1)throw Error('Deep tree indent');
 expand(tree.querySelector('.mw-tree-row'));
 await wait(()=>!first.getClientRects().length);
 if(!footer.textContent.includes('已选 2 条'))throw Error('Hidden selection count');
 expand(tree.querySelector('.mw-tree-row'));
 await wait(()=>grandchild.getClientRects().length);
 if(!first.querySelector('input').checked)throw Error('Lost selected branch');
 if(parent!==window){
   parent.postMessage('rotate','*');
   await wait(()=>innerWidth===568&&innerHeight===320);
   if(!fits())throw Error('Landscape tree layout');
 }
 first.scrollIntoView({block:'start'});
 const scrollTop=viewport.scrollTop;
 first.querySelector('.mw-tree-source').click();
 await wait(()=>el('.sw-canvas-reader article h2')?.textContent==='持续记录');
 window.__shiwenBack();
 await wait(()=>!el('.sw-canvas-reader'));
 if(!scrollTop||Math.abs(viewport.scrollTop-scrollTop)>1||!grandchild.getClientRects().length)throw Error('Lost place after reading');
 await click(()=>button('生成文章大纲'));await wait(()=>el('.sw-canvas-reader article'));
 await click(()=>button('在创作中打开'));
 await wait(()=>el('.record-reading h2')?.textContent.includes('文章大纲'));
 if(rows.at(-1).kind!=='article'||rows.at(-1).sourceIds.length!==2)throw Error('Outline source links');
 const ids=rows.at(-1).sourceIds;
 const titles=ids.map(id=>rows.find(row=>row.id===id).title);
 const links=await wait(()=>{const list=[...document.querySelectorAll('.sw-article-references button')];return list.length===titles.length&&list;});
 if(links.some((link,i)=>link.textContent!==titles[i]))throw Error('引用标题或顺序不正确');
 if(el('.record-reading .record-date')?.checkVisibility())throw Error('文章展开了日期详情');
 links[0].click();
 await wait(()=>el('.mw-source h1')?.textContent===titles[0]);
 await click(()=>button('‹ 返回',el('.mw-source')));
 await click(()=>button('编辑',el('.record-reading')));
 await click(()=>el('.record-metadata > summary'));
 await click(()=>el('.source-picker > summary'));
 const selectedLabels=await wait(()=>{
   const labels=[...document.querySelectorAll('.source-results label')].filter(label=>label.querySelector('input:checked'));
   return labels.length===titles.length&&labels;
 });
 if(selectedLabels.some((label,i)=>label.textContent.trim()!==titles[i]))throw Error('未出现在候选页的引用缺少标题');
}
function finish(result){
 document.body.dataset.qa=result;
 if(parent!==window)parent.postMessage(result,'*');
}
run().then(()=>finish('passed'),e=>finish(e.message));
