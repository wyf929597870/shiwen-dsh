import React, {useEffect, useState} from 'react';

export function DiscoverySettings({rpc, libraryId, t}) {
  const [config, setConfig] = useState(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    setConfig(null);
    setError('');
    async function load() {
      const id = libraryId ?? (await rpc('themeContext')).libraryId;
      const value = await rpc('shiwen_exploration_settings', {expectedLibraryId: id});
      if (active) setConfig({...value, libraryId: id});
    }
    load().catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [rpc, libraryId, attempt]);

  async function change(key, value) {
    setSaving(true);
    try {
      const result = await rpc('shiwen_exploration_settings', {
        expectedLibraryId: config.libraryId, expectedRevision: config.revision,
        requestId: crypto.randomUUID(), [key]: value,
      });
      setConfig({...result, libraryId: config.libraryId});
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  return <>
    <h2>{t('待探索', 'Exploration')}</h2>
    {config && <div className="sw-discovery-settings">
      <label><input type="checkbox" checked={config.enabled} disabled={saving || !!error}
        onChange={e => change('enabled', e.target.checked)}/>{t('每日发现', 'Daily discovery')}</label>
      <label><input type="checkbox" checked={config.model} disabled={saving || !!error}
        onChange={e => change('model', e.target.checked)}/>{t('允许模型分析个人原文', 'Allow model analysis of my original writing')}</label>
    </div>}
    {!config && !error && <p role="status">{t('正在读取设置…', 'Loading settings…')}</p>}
    {error && <p role="alert">{error} <button onClick={() => setAttempt(n => n + 1)}>{t('重新读取', 'Reload')}</button></p>}
  </>;
}
