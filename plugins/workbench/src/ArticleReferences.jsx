import React from 'react';

export function ArticleReferences({ids, recordsById, t, onOpen, loading=false, error, retry}) {
  if (!ids?.length) return null;
  return <section className="sw-article-references" aria-label={t('引用素材','Referenced materials')}>
    <h3>{t('引用素材','Referenced materials')}</h3>
    {error && <p role="alert">{t('素材标题读取失败','Could not load material titles')} <button onClick={retry}>{t('重试','Retry')}</button></p>}
    <ul>{ids.map(id=>{
      const row=recordsById.get(id);
      const title=row?.title?.trim() || (row?t('未命名素材','Untitled material'):loading?t('正在读取标题…','Loading title…'):t('素材暂不可用','Material unavailable'));
      return <li key={id}>{row && !row.deleted
        ? <button type="button" onClick={()=>onOpen(row)}>{title}</button>
        : <span>{title}{row?.deleted?' · '+t('已删除','Deleted'):''}</span>}</li>;
    })}</ul>
  </section>;
}
