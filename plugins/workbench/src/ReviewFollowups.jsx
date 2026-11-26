import React, {useEffect, useRef, useState} from 'react';
import {reviewSample, collectReviewSources, verifiedFollowups, followupInstruction} from './review-followups.mjs';

// Only the current app window retains these results. Include revisions and actual
// excerpts so editing either record or switching libraries invalidates reuse.
const recent = new Map();

export function ReviewFollowups({scope, rows, read, generate, searchRpc, english, t, onOpen}) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [result, setResult] = useState(null);
  const active = useRef(false), alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const sample = reviewSample(rows);
  const distinctDays = new Set(sample.map(r => r.contentDay)).size;
  async function run(refresh = false) {
    if (active.current) return;
    active.current = true; setBusy(true); setError('');
    try {
      let search;
      if (searchRpc) {
        const status = await searchRpc('contentSearchStatus').catch(()=>null);
        if (status?.canSearchSemantic) search = args=>searchRpc('contentSearch',args).catch(()=>null);
      }
      const sources = await collectReviewSources(sample, rows, read, search, ()=>alive.current);
      if (!alive.current) return;
      if (new Set(sources.map(r=>r.day)).size < 2) { setResult({pairs:[]}); return; }
      const input = JSON.stringify(sources.map((s,i)=>({number:i+1, day:s.day, title:(s.title||'').slice(0,100), excerpts:s.excerpts})));
      const cacheKey = JSON.stringify([scope || sources[0].library, english, sources]);
      if (!refresh && recent.has(cacheKey)) { setResult(recent.get(cacheKey)); return; }
      const {text, model} = await generate({input, instruction:followupInstruction(english)});
      if (!alive.current) return;
      const verified = {model, pairs:verifiedFollowups(text,sources)};
      if (scope || sources[0].library) {
        if (recent.size >= 4 && !recent.has(cacheKey)) recent.delete(recent.keys().next().value);
        recent.set(cacheKey, verified);
      }
      setResult(verified);
    } catch (e) {
      if (alive.current) setError(e instanceof SyntaxError || e.message==='INVALID_FOLLOWUPS'
        ? t('模型返回的引用未能核对，请重试。','Could not verify the model’s references. Try again.')
        : String(e.message || e));
    } finally {
      active.current = false;
      if (alive.current) setBusy(false);
    }
  }
  return <section className="sw-review-card review-details"><h2>{t('后来怎么样了','What happened next?')}</h2>
    {distinctDays < 2 ? <p>{t('选择至少含两天个人记录的时间范围。','Select a period with personal records on at least two days.')}</p> : <>
      {!result && <><p>{t('将这段时间内最多 14 条个人记录的节选交给当前模型，查找想法的后续。','Send excerpts from up to 14 personal records in this period to your configured model.')}</p>
      <button type="button" disabled={busy} onClick={()=>run()}>{busy?t('正在查找…','Looking…'):t('查找后续','Find follow-ups')}</button></>}
      {result?.model && <div><small>{result.model}</small> <button type="button" disabled={busy} onClick={()=>run(true)}>{busy?t('正在查找…','Looking…'):t('用当前模型重新分析','Analyze again with current model')}</button></div>}
      {result && !result.pairs.length && <p>{t('这些节选里没有找到有原文支持的后续。','No supported follow-up found in these excerpts.')}</p>}
      {result?.pairs.map(p=><article key={p.before.id+p.after.id}>
        {[[p.before,p.beforeQuote],[p.after,p.afterQuote]].map(([r,q])=><div key={r.id}><button type="button" onClick={()=>onOpen(r.id)}>{r.day} · {r.title||t('未命名','Untitled')}</button><blockquote>{q}</blockquote></div>)}
        <p>{p.note}</p></article>)}
      {error && <p role="alert">{error}</p>}</>}
  </section>;
}
