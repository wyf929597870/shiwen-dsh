import {Capacitor, registerPlugin} from '@capacitor/core';
const native = registerPlugin('LibraryProbe');
export const leaveApp = () => native.leaveApp();
export const isNative = Capacitor.isNativePlatform();
let context;
let contextRevision = 0;
const syncTargets = new Map();
export async function bootstrap() {
  if (!isNative) throw Error('请在 Android 验证应用中使用原生资料库；浏览器预览不保存资料。');
  const next = await native.bootstrap();
  context = next; contextRevision++;
  return context;
}
export async function call(method, args = {}) {
  if (!context) throw Error('资料库尚未打开');
  const bound = context;
  const selection = method === 'librarySelect' || method === 'libraryCreate';
  const explicit = args.libraryId;
  const syncProgressCall = method === 'syncProgress';
  const syncTarget = syncProgressCall ? (args.targetLibraryId ?? explicit ?? bound.libraryId) : null;
  if (!selection && !syncProgressCall && explicit != null && explicit !== bound.libraryId)
    throw Error('请求的资料库与当前页面不一致，请先切换资料库');
  if (syncProgressCall && syncTarget !== bound.libraryId && syncTargets.get(args.operationId) !== syncTarget)
    throw Error('该同步任务不属于当前资料库页面');
  const request = selection
    ? {...args, expectedLibraryId: bound.libraryId, expectedPageGeneration: bound.pageGeneration}
    : syncProgressCall
      ? {...args, targetLibraryId: syncTarget, boundLibraryId: bound.libraryId, pageGeneration: bound.pageGeneration}
      : {...args, ...bound};
  const before = contextRevision;
  const result = await native[method](request);
  if (selection) {
    if (contextRevision !== before || context !== bound) throw Error('资料库切换结果过期，请刷新资料库列表后重试');
    if (!result?.libraryId || !Number.isSafeInteger(result?.pageGeneration)) throw Error('原生资料库切换未返回有效上下文');
    context = {...bound, ...result}; contextRevision++;
  } else if (context !== bound) throw Error('资料库已切换，请重新读取');
  const nestedSync = method === 'configureNode' || method === 'nodeCheck' ? result?.sync : null;
  const syncResult = nestedSync || ((method === 'libraryConnect' || method === 'syncNow') ? result : null);
  if (syncResult?.operationId) {
    syncTargets.set(syncResult.operationId, syncResult.libraryId ?? bound.libraryId);
    while (syncTargets.size > 64) syncTargets.delete(syncTargets.keys().next().value);
  }
  return result;
}
