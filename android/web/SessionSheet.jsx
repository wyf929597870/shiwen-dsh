import {useEffect} from 'react';
import {t, useI18n} from './i18n.js';

/**
 * Bottom sheet that replaces the native session <select> on the phone.
 * Rows carry the per-session action the native control could never host.
 * `items` are already normalized by the caller: {id, title, subtitle, running, readOnly, archived}.
 */
export function SessionSheet({open, title, items, activeId, onSelect, onCreate, onPrimary, onRestore,
  primaryLabel, confirmText, showArchived, archivedCount, onToggleArchived, onClose}) {
  useI18n();
  useEffect(() => {
    if (!open) return;
    const onKey = event => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  const blockedReason = item =>
    item.running ? t('正在运行，请先停止') : item.readOnly ? t('只读会话不能移除') : '';
  const runPrimary = item => {
    if (item.running || item.readOnly) return;
    if (confirmText && !window.confirm(confirmText(item))) return;
    onPrimary?.(item);
  };
  return <>
    <div className="session-sheet-scrim" onClick={onClose} aria-hidden="true"/>
    <section className="session-sheet" role="dialog" aria-modal="true" aria-label={title}>
      <header>
        <strong>{title}</strong>
        <button type="button" className="chip chat-icon-action" aria-label={t('关闭')} onClick={onClose}>✕</button>
      </header>
      <div className="session-sheet-list">
        {!items.length && <p className="secondary">{t('还没有会话。')}</p>}
        {items.map(item => {
          const current = item.id === activeId;
          return <div className={`session-sheet-row${current ? ' is-current' : ''}`} key={item.id}>
            <button type="button" className="session-sheet-pick" aria-current={current ? 'true' : undefined}
              onClick={() => { onSelect?.(item.id); onClose(); }}>
              <strong>{item.title || t('新会话')}</strong>
              <span className="secondary">{item.subtitle}</span>
            </button>
            {item.archived
              ? <button type="button" className="chip" onClick={() => onRestore?.(item)}>{t('恢复')}</button>
              : <button type="button" className="chip session-sheet-action" disabled={item.running || item.readOnly}
                  title={blockedReason(item) || primaryLabel} onClick={() => runPrimary(item)}>{primaryLabel}</button>}
          </div>;
        })}
      </div>
      <footer>
        {onCreate && <button type="button" className="chip" onClick={() => { onCreate(); onClose(); }}>＋ {t('新建会话')}</button>}
        {onToggleArchived && <button type="button" className="text" aria-pressed={showArchived} onClick={onToggleArchived}>
          {showArchived ? t('隐藏已归档') : t(`显示已归档（${archivedCount}）`)}
        </button>}
      </footer>
    </section>
  </>;
}
