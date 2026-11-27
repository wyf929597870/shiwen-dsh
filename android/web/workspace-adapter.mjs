export function workspaceAdapter(call, {libraryId}) {
  const local = (method,args={}) => call(method,{...args,libraryId});
  const read = async id => {
    const record=await local('recordRead',{id});
    if(record.deleted)throw Error('原文已移入回收站');
    return {...record,sourceLibraryId:libraryId};
  };
  return async function rpc(method,args={}) {
    if(args.expectedLibraryId && args.expectedLibraryId!==libraryId)throw Error('资料库已切换');
    if(method==='readMarkdown')return read(args.id);
    if(method==='themeContext')return {libraryId};
    if(method==='contentSearchStatus') return local('phoneSemanticStatus');
    if(method==='contentSearchEnable') return local('phoneSemanticStatus',{start:true,retry:args.retry===true});
    if(method==='contentSearch'){
      if(args.mode==='semantic') return local('phoneSemanticSearch',args);
      return local('workspaceSearch',{query:args.query,related:args.mode==='related',limit:args.limit,offset:args.offset});
    }
    if(method==='saveMarkdown'){
      const record={id:args.requestId,title:args.title,markdown:args.body,kind:'article',stage:'draft',
        origin:'personal',processing:'original',sourceIds:args.sourceIds,sources:[{origin:'personal',text:args.body}]};
      return (await local('recordCreate',{requestId:args.requestId,localGeneration:1,record})).record;
    }
    if(method.startsWith('theme'))return (await local('workspaceThemes',{method,args})).result;
    throw Error('不支持的工作台操作');
  };
}
