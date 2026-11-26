import React from 'react';
export function RecordWelcome({t,onCreate,onSearch,onReview,disabled,isCollection}){
  return <div className="sw-record-welcome">
    <div className="sw-welcome-brand"><img src="/shiwen-brand.png" alt=""/>拾文</div>
    <div className="sw-welcome-intro">
      <h2>{isCollection?t('我的','My '):t('今天，','Today, ')}<strong>{isCollection?t('收藏','collection'):t('记下些什么','write a little')}</strong></h2>
      <p>{t('选择左侧的一条内容开始阅读，也可以在这里写下新的记录。','Choose an item on the left to read, or start a new entry here.')}</p>
      <button className="sw-welcome-create" disabled={disabled} onClick={onCreate}>＋ {isCollection?t('新建收藏','New collection item'):t('新建记录','New record')}</button>
    </div>
    <div className="sw-welcome-cards">
      <section><h3>{t('查找素材','Find material')}</h3><p>{t('按关键词或意思，找回记录、读书笔记和收藏里的片段。','Find passages in your records, reading notes and collections by wording or meaning.')}</p><button onClick={onSearch}>{t('全局搜索','Search library')} ↗</button></section>
      <section><h3>{t('回看记录','Revisit your notes')}</h3><p>{t('翻看这段时间写过的文字，看看哪些想法后来有了进展。','Look back over what you wrote and see how your ideas developed.')}</p><button onClick={onReview}>{t('查看回顾','Open review')} ↗</button></section>
    </div>
  </div>;
}
