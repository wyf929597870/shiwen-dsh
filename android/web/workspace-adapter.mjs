import {decodeReadingNote} from '../../plugins/library/legacy/reading-note.mjs';

export function workspaceAdapter(call, {libraryId,role,localTopics=role==='standalone'}) {
  const local = (method,args={}) => call(method,{...args,libraryId});
  const remote = async (method,args={}) => (await local('workspaceRemote',{method,args})).result;
  const read = async id => {
    const record=await local('recordRead',{id});
    if(record.deleted)throw Error('原文已移入回收站');
    return {...record,sourceLibraryId:libraryId};
  };
  return async function rpc(method,args={}) {
    if(args.expectedLibraryId && args.expectedLibraryId!==libraryId)throw Error('资料库已切换');
    if(method==='readMarkdown')return read(args.id);
    if(method==='themeContext')return {libraryId};
    if(method==='contentSearchStatus')return {state:'ready',libraryScope:libraryId};
    if(method==='serverSearchStatus'||method==='contentSearchEnable')
      return remote(method==='serverSearchStatus'?'contentSearchStatus':method);
    if(method==='contentSearch'){
      if(args.mode==='semantic'){
        if(role==='standalone')throw Error('按意思搜索需要连接当前资料库的电脑');
        const result=await remote(method,args);
        return {...result,libraryScope:libraryId};
      }
      return local('workspaceSearch',{query:args.query,related:args.mode==='related',limit:args.limit,offset:args.offset});
    }
    if(method==='saveMarkdown'){
      const record={id:args.requestId,title:args.title,markdown:args.body,kind:'article',stage:'draft',
        origin:'personal',processing:'original',sourceIds:args.sourceIds,sources:[{origin:'personal',text:args.body}]};
      return (await local('recordCreate',{requestId:args.requestId,localGeneration:1,record})).record;
    }
    if(method.startsWith('theme')){
      if(localTopics)return (await local('workspaceThemes',{method,args})).result;
      if(method==='themeMemberAdd'){
        const source=await read(args.sourceRecordId);
        const server=await remote('readMarkdown',{id:source.id});
        const text=r=>args.field==='excerpt'?decodeReadingNote(r.annotation)?.excerpts?.[args.excerptIndex]?.text:r.markdown;
        if(source.revision!==args.sourceRevision||server.sourceLibraryId!==libraryId||source.kind!==server.kind||text(source)!==text(server))
          throw Error('请先同步这条原文，再加入电脑主题');
        return remote(method,{...args,sourceRevision:server.revision});
      }
      return remote(method,args);
    }
    throw Error('不支持的工作台操作');
  };
}
