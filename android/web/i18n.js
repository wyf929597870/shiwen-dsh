import {useSyncExternalStore} from 'react';

let language='zh-CN';
const listeners=new Set();
let mediaQuery=null,mediaListener=null,systemThemeListener=null;
const messages={
  'zh-CN':{},
  en:{
    '拾文':'Shiwen','对话':'Chat','素材':'Materials','创作':'Writing','回顾':'Review','设置':'Settings',
    '日记':'Journal','自由书写':'Freewriting','想法':'Idea','网页':'Web','AI 讨论':'AI discussion','参考资料':'Reference','文章':'Article',
    '自己书写':'Written by me','外部资料':'External source','AI 内容':'AI content','译文':'Translation','来源待确认':'Source unconfirmed',
    '搜索标题和正文':'Search titles and content','按类型筛选':'Filter by type','全部类型':'All types','回收站':'Trash',
    '新建记录':'New record','新建文章':'New article','编辑记录':'Edit record','编辑文章':'Edit article','保存':'Save','保存中…':'Saving…','删除':'Delete','恢复':'Restore','取消':'Cancel','编辑':'Edit',
    '标题':'Title','正文 · Markdown':'Content · Markdown','正文':'Content','内容日期':'Content date','来源说明':'Date/source note','来源链接':'Source URL','备注':'Note','文章状态':'Article status','关联素材':'Linked materials',
    '发布前检查':'Pre-publication checks','版本历史':'Version history','加载更多':'Load more','更新中':'Updating','当前资料库':'Current library','本机':'This device',
    '今日':'Today','近 7 天':'Last 7 days','近 14 天':'Last 14 days','近 30 天':'Last 30 days','自然月':'Calendar month','个人新增字数':'Personal characters added','个人记录':'Personal records','收集素材':'Collected materials','已定稿':'Finalized',
    '全部':'All','草稿':'Draft','修改中':'In revision','待处理':'Needs review','未命名':'Untitled','日期待确认':'Date unconfirmed','共':'Total',
    '连接状态':'Connection status','同步状态':'Sync status','手动同步':'Sync now','自动同步':'Automatic sync','后台同步':'Background sync','当前操作尚未完成':'An operation is still in progress',
    '把素材整理成文章；发布前先检查内容。':'Shape your materials into an article, then review it before publishing.','按日期、类型和来源查找完整资料库。':'Search your complete library by date, type, and source.','正在读取回顾…':'Loading review…','这段时间还没有记录活动。':'No activity was recorded in this period.','历史导入按内容日期归档':'Imported history is grouped by its content date.','没有可显示的逐日数据。':'No daily data to display.','统计还未覆盖完整历史':'The statistics do not cover the complete history yet','已完整至':'Complete through','本机待同步修改也已纳入。':'local changes awaiting sync are also included.','个人新增字数按编辑活动日统计':'Personal additions are grouped by the date of the edit.','移除':'Removed','净新增':'Net added','日记、想法与自由书写':'Journals, ideas, and freewriting','篇':'','收集':'Collected','新增':'Added','字':' chars','条':'','这段时间没有文章更新。':'No articles were updated in this period.','选择一条记录查看正文和来源。':'Select a record to read its content and sources.','没有匹配的记录。':'No matching records.','这里还没有内容。':'There is no content here yet.','日期说明':'Date note','已移入回收站。':'Moved to trash.','已恢复到资料库。':'Restored to the library.','已保存到当前资料库。':'Saved to the current library.','已保存在此设备，等待同步。':'Saved on this device and waiting to sync.','编辑内容仍保留。请用同一请求再次核对：':'Your edits are preserved. Check again using the same request:','保存结果待核对，编辑内容仍保留。请用同一请求再次核对：':'Save result needs verification. Your edits are preserved; retry with the same request:','未分类':'Uncategorized','保存结果待核对':'Save result needs verification','状态读取中':'Loading status','记录于':'Recorded','更新于':'Updated',
    '手机资料库与同步':'Phone libraries and sync','每个资料库在手机单独保存；服务端连接用于建立完整副本并持续汇合修改。':'Each library is stored separately on this phone. Connecting a server creates a full replica and syncs changes.','副本完整性':'Replica completeness','待同步修改':'Changes to sync','待处理冲突':'Conflicts to resolve','最近同步':'Last synced','尚未检查':'Not checked','尚无成功同步记录':'No successful sync yet','正在准备':'Preparing','同步完成。':'Sync complete.','冲突已处理：':'Conflict resolved:','已切换当前资料库。':'Switched current library.','已创建独立手机资料库。':'Created a separate phone library.','资料库名称':'Library name','创建独立资料库':'Create separate library','可用资料库':'Available libraries','正在使用':'In use','切换':'Switch','从服务端同步资料库到手机':'Sync a server library to this phone','会先核对服务身份。已存在同一 libraryId 的本机副本会接续使用；不同 libraryId 会建立独立副本，不覆盖手机已有资料。':'The server identity is verified first. An existing phone copy with the same libraryId is reused; a different libraryId gets its own copy without replacing existing phone data.','下载资料库':'Download library','需先登录':'Sign in first','添加并登录服务器。':'Add and sign in to a server.','同步偏好已保存。':'Sync preferences saved.','同步冲突':'Sync conflicts','刷新列表':'Refresh list','关闭':'Close','保留手机版本':'Keep phone version','保留服务端版本':'Keep server version','双方版本会继续保存在历史中。':'Both versions will remain in history.','冲突尚未读取；点击“查看冲突”刷新，避免把未知状态显示成零。':'Conflicts have not been checked. Refresh the list to avoid treating an unknown state as zero.','远程':'Remote','连接服务':'Connect server','初始化中':'Initializing','资料不完整':'Incomplete library','已连接':'Connected','同步中':'Syncing','有待处理冲突':'Conflicts need attention','同步异常':'Sync error','仅本机':'On this phone','已同步':'Synced','未同步':'Not synced','未知':'Unknown','系统':'System','浅色':'Light','深色':'Dark','中文':'Chinese','英文':'English','外观与语言':'Appearance and language','语言':'Language','主题':'Theme','保存设置':'Save settings','切换资料库':'Switch library','同步进度读取失败：':'Could not read sync progress:','同步':'Sync','当前资料库。':'Current library.',
  }
};
const getSnapshot=()=>language;
export function setLanguage(value){language=String(value||'zh-CN').toLowerCase().startsWith('en')?'en':'zh-CN';for(const listener of listeners)listener();}
export function getLanguage(){return language;}
export function registerTranslations(map){Object.assign(messages.en,map||{});}
export function t(text,englishFallback){return language==='en'?(messages.en[text]??englishFallback??text):text;}
export function useI18n(){const current=useSyncExternalStore(callback=>{listeners.add(callback);return()=>listeners.delete(callback);},getSnapshot,getSnapshot);return {language:current,t,setLanguage};}
export function applyAppearance(theme='system',systemDark){
  if(typeof document==='undefined')return;
  const render=()=>{
    const chosen=['light','dark'].includes(theme)?theme:(typeof systemDark==='boolean'?(systemDark?'dark':'light'):(mediaQuery?.matches?'light':'dark'));
    document.documentElement.dataset.theme=chosen;
    document.documentElement.style.colorScheme=chosen;
  };
  if(mediaQuery&&mediaListener)mediaQuery.removeEventListener?.('change',mediaListener);
  if(systemThemeListener)window.removeEventListener('shiwen-system-theme',systemThemeListener);
  mediaQuery=window.matchMedia?.('(prefers-color-scheme: light)')||null;
  mediaListener=theme==='system'&&typeof systemDark!=='boolean'&&mediaQuery?render:null;
  if(mediaListener)mediaQuery.addEventListener?.('change',mediaListener);
  systemThemeListener=theme==='system'&&typeof systemDark==='boolean'?event=>{systemDark=Boolean(event.detail);render();}:null;
  if(systemThemeListener)window.addEventListener('shiwen-system-theme',systemThemeListener);
  render();
}
