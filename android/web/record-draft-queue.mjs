const queues = new Map();

export function enqueueRecordDraft(key, operation) {
  const previous = queues.get(key) || Promise.resolve();
  const next = previous.catch(() => {}).then(operation);
  queues.set(key, next);
  next.finally(() => { if (queues.get(key) === next) queues.delete(key); }).catch(() => {});
  return next;
}

export function flushRecordDraft(key) { return (queues.get(key) || Promise.resolve()).catch(() => {}); }
