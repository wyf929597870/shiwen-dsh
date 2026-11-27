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
const sample=otherThemes.at(-2);
sample.summary='示例说明，收集我在日常生活里留意到的细节。'.repeat(10);
sample.members=[{id:'sample',sourceRecordId:'idea',sourceTitle:'持续记录',sourceKind:'idea',field:'body',quote:'记录今天观察到的一个细节。',location:{status:'current'}}];
sample.memberCount=sample.members.length;
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
 case 'phoneSemanticStatus':return {libraryScope:libraryId,state:'indexing',canSearchSemantic:false,total:3,completed:0};
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
   if(args.method==='themeSave')savedTheme={members:[],memberCount:0,...savedTheme,...a,id:'theme',revision:(a.revision??0)+1};
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
 await click(()=>el('.record-list-row'));
 const body=await wait(()=>el('.record-reading .markdown-view'));
 const info=el('.record-reading .sw-article-tools');
 if(body.getBoundingClientRect().top>=innerHeight/2||info.open||el('.record-reading .record-date').checkVisibility())throw Error('收藏详情首屏应优先显示正文');
 info.querySelector('summary').click();
 if(!el('.record-reading .record-date').checkVisibility())throw Error('展开后应能核对来源日期');
 window.__shiwenBack();await wait(()=>el('.record-list-row'));
 // The OS back callback and edge gesture must both return to the previous section.
 window.__shiwenBack();
 await wait(()=>el('.brand strong')?.textContent==='记录');
 await section('收藏');
 await wait(()=>el('.brand strong')?.textContent==='收藏');
 const main=el('.app > main');
 for(const [type,x] of [['touchstart',8],['touchmove',80],['touchend',112]]){
   const point=new Touch({identifier:1,target:main,clientX:x,clientY:220});
   main.dispatchEvent(new TouchEvent(type,{bubbles:true,cancelable:true,touches:type==='touchend'?[]:[point],changedTouches:[point]}));
 }
 await wait(()=>el('.brand strong')?.textContent==='记录');
 await section('主题');
 const themeCreate=await wait(()=>button('＋ 新建主题')),firstRow=await wait(()=>el('.sw-theme-list-item'));
 const strip=el('.mw-sections'),nav=el('.app > nav');
 if(firstRow.getBoundingClientRect().top-strip.getBoundingClientRect().bottom>16)throw Error('主题列表与分类栏间距过大');
 function checkCreate(button){
   const rect=button.getBoundingClientRect();
   if(getComputedStyle(button).position!=='fixed'||rect.height<44||rect.bottom>nav.getBoundingClientRect().top||rect.right>innerWidth)throw Error('新建按钮应悬浮在底栏上方');
 }
 checkCreate(themeCreate);
 const lastRow=[...el('.mw-themes .sw-list').querySelectorAll('.sw-theme-list-item')].at(-1);
 el('.app > main').scrollTop=el('.app > main').scrollHeight;
 checkCreate(themeCreate);
 if(lastRow.getBoundingClientRect().bottom>themeCreate.getBoundingClientRect().top)throw Error('最后一个主题被新建按钮遮住');
 el('.app > main').scrollTop=0;
 themeCreate.click();
 input(await wait(()=>el('[aria-label="主题标题"]')),'观察素材');await click(()=>button('保存主题'));
 await wait(()=>savedTheme&&el('.sw-theme-intro h1')?.textContent===savedTheme.title);
 if(el('.sw-detail input,.sw-detail textarea'))throw Error('手机主题详情应直接显示标题和说明');
 await click(()=>button('‹ 返回主题列表'));
 const created=await wait(()=>[...document.querySelectorAll('.sw-theme-list-item')].find(b=>b.querySelector('strong')?.textContent===savedTheme.title));
 created.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,key:'F10',shiftKey:true}));
 await click(()=>button('编辑',created.parentElement));
 input(await wait(()=>el('[aria-label="主题标题"]')),'新的观察素材');
 await click(()=>button('保存主题'));
 await wait(()=>el('.sw-theme-intro h1')?.textContent==='新的观察素材'&&savedTheme.revision===2);
 await click(()=>button('‹ 返回主题列表'));
 const list=await wait(()=>el('.mw-themes .sw-list:not([hidden])'));
 const chosen=[...list.querySelectorAll('button')].at(-3);
 chosen.scrollIntoView({block:'center'});
 const scroll=el('.app > main'),listTop=scroll.scrollTop;
 if(listTop<=0)throw Error('Long themes list did not scroll');
 chosen.click();
 await wait(()=>el('.sw-theme-intro h1')?.textContent===chosen.querySelector('strong').textContent&&el('.sw-theme-summary')?.textContent===sample.summary);
 const card=el('.sw-theme-member'),quote=card?.querySelector('blockquote'),source=card?.querySelector('footer .sw-theme-card-source');
 if(!quote||!source||quote!==card.firstElementChild||quote.getBoundingClientRect().top-card.getBoundingClientRect().top>16||source.getBoundingClientRect().top<quote.getBoundingClientRect().bottom)throw Error('摘录应紧靠卡片顶部，来源位于底部');
 const summary=el('.sw-theme-summary'),shortHeight=summary.clientHeight;
 if(summary.getBoundingClientRect().top<el('.sw-theme-intro h1').getBoundingClientRect().bottom)throw Error('主题说明应排在标题下方');
 await click(()=>button('展开说明'));await wait(()=>summary.clientHeight>shortHeight);
 await click(()=>button('收起说明'));await wait(()=>summary.clientHeight===shortHeight);
 if(list.getClientRects().length||scroll.scrollTop!==0||el('.mw-themes .sw-detail').getBoundingClientRect().top>=innerHeight)throw Error('Theme detail did not open at the top');
 window.__shiwenBack();
 await wait(()=>!list.hidden&&scroll.scrollTop===listTop);
 const touch=(type,x)=>chosen.dispatchEvent(new PointerEvent(type,{bubbles:true,pointerType:'touch',isPrimary:true,clientX:x,clientY:90}));
 touch('pointerdown',60);touch('pointermove',82);touch('pointerup',82);
 await new Promise(resolve=>setTimeout(resolve,550));
 if(el('.sw-theme-list-edit'))throw Error('滑动主题列表不应进入编辑');
 touch('pointerdown',60);
 await wait(()=>button('编辑',chosen.parentElement));touch('pointerup',60);
 chosen.dispatchEvent(new MouseEvent('click',{bubbles:true,detail:1}));
 if(list.hidden)throw Error('长按松手不应打开主题详情');
 await click(()=>button('编辑',chosen.parentElement));
 await wait(()=>el('[aria-label="主题标题"]')?.value===chosen.querySelector('strong').textContent);
 const confirm=window.confirm;window.confirm=()=>false;
 input(el('[aria-label="主题标题"]'),'尚未保存');window.__shiwenBack();
 await wait(()=>el('[aria-label="主题标题"]')?.value==='尚未保存');
 await new Promise(resolve=>setTimeout(resolve,40));
 if(!list.hidden)throw Error('Back discarded unconfirmed edits');
 window.confirm=()=>true;window.__shiwenBack();
 await wait(()=>!list.hidden&&scroll.scrollTop===listTop).catch(()=>{throw Error('List restoration: hidden='+list.hidden+', actual='+scroll.scrollTop+', expected='+listTop+', limit='+(scroll.scrollHeight-scroll.clientHeight));});
 window.confirm=confirm;
 const searchTab=button('搜索',el('.app > nav'));
 if(!searchTab||button('全局搜索',el('.mw-sections')))throw Error('搜索应从独立底栏入口打开');
 await click(()=>searchTab);
 await wait(()=>searchTab.getAttribute('aria-current')==='page'&&el('.brand strong')?.textContent==='全局搜索');
 if(el('.mw-sections'))throw Error('搜索页不应显示资料分类');
 const navItems=[...el('.app > nav').querySelectorAll('button')].map(b=>b.getBoundingClientRect());
 if(navItems.length!==6||navItems.some(r=>r.top!==navItems[0].top||r.width<44||r.right>innerWidth+1))throw Error('底栏入口未在一行完整显示');
 input(await wait(()=>el('.mw-search input')),'日记');await click(()=>el('.sw-search-result'));
 await wait(()=>el('.mw-source mark')?.textContent.includes('日记'));
 await click(()=>button('加入主题',el('.mw-source')));
 const add=()=>el('.mw-source .sw-theme-popover');await wait(add);
 await click(()=>[...add().querySelectorAll('button')].find(b=>!b.disabled&&/加入|添加/.test(b.textContent)));
 await wait(()=>savedTheme.memberCount===1);window.__shiwenBack();await wait(()=>!el('.mw-source'));
 if(!el('.sw-search-result')||el('.mw-search input').value!=='日记')throw Error('返回搜索应保留关键词和结果');
 window.__shiwenBack();await wait(()=>el('.brand strong')?.textContent==='主题');
 await section('读书');checkCreate(await wait(()=>el('.rn-mode-list .rn-new')));await click(()=>el('.rn-list-item,.rn-card button,.rn-preview-card'));
 await wait(()=>el('.rn-mode-detail .rn-detail-excerpt'));
 if(el('.rn-detail-excerpt').getBoundingClientRect().top>=innerHeight/2)throw Error('读书笔记首屏应显示摘录');
 if(el('.rn-detail-thought'))throw Error('Empty reflection');
 if(new URLSearchParams(location.search).get('screen')==='reading')return;
 await click(()=>button('展开相关内容'));
 const tree=await wait(()=>el('.mw-related-tree'));
 const first=await wait(()=>tree.querySelector(':scope > li > ul .mw-tree-row'));
 const content=first.querySelector('.mw-tree-source');
 if(content.firstElementChild.textContent!==rows[0].markdown||content.lastElementChild.textContent!==rows[0].title)throw Error('关联列表应先显示命中段落，再显示素材标题');
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
