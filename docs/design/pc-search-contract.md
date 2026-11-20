# PC 共用搜索接口与分工契约

状态：实施契约，2026-11-17。以 `pc-semantic-search-plan.md` 的范围与验收为准；本文固定并行开发边界，不表示功能已实现。

## 服务边界与权限

沿用 `POST /api/shiwen` 的 `{method,args}` / `{result}` 和 `{error,code}` 信封，增加 `contentSearch`、`contentSearchStatus`、`contentSearchEnable`、`contentSearchRebuild`。调用异步，服务端校验完整参数；非法输入返回 `INVALID_REQUEST`。读取权限沿用现有资料库读取边界；启用和重建必须校验已有 owner 会话，与 `readingNoteList` 同等的资源权限不能降低。客户端不得选择任意服务器路径或资料库：服务从当前 `shiwenLibrary` 上下文获取资料库及其作用域。查询必须在授权与范围过滤后排序；`selectedIds` 只是缩小范围，不是授权凭证；它反映编辑器尚未保存的本篇素材选择，新文章也可使用，不能用持久文章关联替代。旧的 `searchRecords`、Agent、MCP 契约和默认精确行为不变。

当前资料库唯一稳定标识沿用 `readingNoteList.scope` 的路径哈希语义；响应 `libraryScope` 仅供客户端区分模式记忆及缓存，不接受为查询授权参数。服务位置以非敏感、面向用户的描述提供（例如服务主机名）；不得向浏览器暴露服务文件路径或凭据。

桌面分类（0.1.33）增加 `records`（日记、想法、自由书写）、`collections`（网页、参考资料、AI 讨论）和 `global`（上述内容、读书笔记与文章）三个查询范围。分类过滤在排序和分页之前生效；全局搜索中的读书结果按划线卡片定位。原有 `materials` 接口仍提供跨类型素材查询。

## 查询请求

```js
{
  query: '找以前关于行动的想法', // 字符串；trim 后空值走原浏览，不调用语义推理
  mode: 'exact',               // exact（默认）| semantic
  scope: 'materials',          // materials | articles | reading | writingSources
  filters: {
    kind: null,                // 素材类型；null = 全部
    start: null, end: null,    // YYYY-MM-DD，包含两端；未定日期不匹配限定日期
    stage: null,               // 仅 articles：idea | draft | revision | final
    book: null, chapter: null, // 读书笔记书名与章节，精确值；null = 全部
    noteType: null,            // excerpt | reflection | question
    sourceScope: 'all',        // writingSources: all | linked
    selectedIds: []            // 仅 linked 时缩小到当前文章关联素材；允许空数组
  },
  offset: 0, limit: 20         // 非负整数；limit 1..30
}
```

允许省略 `filters` 中不适用字段，默认均为 `null`（`sourceScope` 默认 `all`，`selectedIds` 默认 `[]`）。不适用于 scope 的非默认筛选、非法类型、反序日期、异常分页或过长查询应报错而非忽略；实现应给 `selectedIds` 设有界长度并去重。`materials` 包括 journal、freewrite、idea、web、reference、已保存 ai、reading_note，不包括 article/ai_annotation；`articles` 仅 article；`reading` 仅 reading_note；`writingSources` 为可关联素材，不含文章和独立批注。`writingSources` 支持书籍过滤；设置书籍时只匹配该书读书笔记，排除其他素材类型。章节/笔记类型过滤同样只匹配相应读书笔记；阅读范围“本书”由 `book` 表达。默认精确按原文包含匹配，匹配标题、正文及读书摘录；不依赖模型。空查询 UI 保留既有列表、顺序与浏览方式。非空语义查询在候选集内排序；不设通用拒绝阈值、不向 UI 返回概率。

## 查询响应与锚点

```js
{
  libraryScope: 'opaque-library-id', mode: 'semantic', scope: 'reading',
  items: [{
    recordId: '...', revision: 7, kind: 'reading_note', title: '书名',
    contentDay: '2026-11-17', origin: 'personal', url: '',
    cardId: 'record-id:0', // reading 与 writingSources 的读书结果必填；其他结果为 null
    book: '书名', chapter: '第一章', page: '12', noteType: 'excerpt',
    match: {
      field: 'excerpt',     // title | body | excerpt | reflection | chapter
      text: '匹配原文片段', // 原始字段的子串，不是模型清理后的文本
      anchor: {start: 0, end: 6, excerptIndex: 0}
    }
  }],
  total: 1, nextOffset: null,
  status: { /* contentSearchStatus 响应，见下 */ }
}
```

`start` 含、`end` 不含，均为 JavaScript UTF-16 代码单元相对于原字段的偏移，且必须在 Unicode 字符边界。`title` 对应原始标题，普通 `body` 及 `reflection` 对应 `markdownSource(record.doc)`，`excerpt` 对应 `decodeReadingNote(annotation).excerpts[excerptIndex].text`；`chapter` 对应 `decodeReadingNote(annotation).chapter`（兼容读书笔记原文查询）。除 excerpt 外 `excerptIndex` 为 null；记录版本和偏移共同构成锚点，片段经过 Markdown 清理后必须映射回原文。`text` 必须等于该字段切片。无对应字段时 `book/chapter/page/noteType` 为 null；摘录页码优先摘录自己的页码，其他情况使用笔记页码。语义展示写“相关内容”，不宣称精确找回。

普通内容按 recordId 去重；reading 与 writingSources 中读书笔记按 `readingCards` 的 `recordId:index` 或 `recordId:thought` 粒度去重。多摘录共享感想命中时应保持各卡身份而不把感想冒充摘录；匹配 field 与 excerptIndex 仍分别准确。按相关性稳定排序（同分以稳定标识打破平局）；排序后去重与分页，`total` 是过滤、去重并校验当前版本后的数量，`nextOffset` 为下一页或 null。支持此页重试；查询/范围/索引变化后客户端从 0 重查，不拼接旧页。

点击或引用前重新读取记录，验证未删除、`revision` 相同且当前原字段对应切片等于 `match.text`，然后才使用偏移（即使同步复用了版本号，也不能套用错位锚点）；不相同时重查并重新定位，失败时展示原记录并提示内容已变化，不得应用旧锚点。保留列表查询、筛选和滚动；引用既有关系及原文选择行为。查询新输入或范围变化时立即清除旧结果、取消请求或以序号忽略旧响应；IME 组词不请求，短延迟防抖。

## 状态与控制

`contentSearchStatus({})` 返回：

```js
{
  libraryScope: 'opaque-library-id', serviceLocation: '...',
  state: 'disabled', // disabled | downloading | indexing | ready | updating | failed
  model: {state: 'missing', revision: null, downloadedBytes: 0, totalBytes: null},
  index: {state: 'missing', completed: 0, total: null},
  error: null, // 或 {code, message, retryable}，消息不含路径/凭据/私人内容
  canSearchSemantic: false
}
```

`model.state` 为 `missing | downloading | ready | failed`；`index.state` 为 `missing | indexing | ready | updating | failed`。整体状态优先反映失败、下载和建库；首次索引完成前 `canSearchSemantic=false`，语义查询返回 `SEMANTIC_NOT_READY` 而非精确降级。增量更新中 `canSearchSemantic=true`，只返回经当前版本、删除状态和范围二次验证的已索引片段；变化但未索引的记录暂不返回。重建期间若存在有效旧索引则遵循 updating 规则继续搜索，否则不可搜索；重建失败时仅在旧索引仍有效且能逐条校验时允许搜索，`canSearchSemantic` 必须反映实际可用性。失败允许重试，不影响精确查询及保存。进度总量未知时为 null。`contentSearchEnable({})` 幂等地开始或加入现有下载/建库任务；`contentSearchRebuild({})` 幂等启动或加入当前资料库的重建，均返回当前状态，轮询 `contentSearchStatus` 获取进度。管理操作仅 owner。下载固定修订及校验清单，临时文件校验后原子替换，模型存服务持久目录；多窗口共用任务。模型可以服务实例共享，索引按资料库隔离，任一库的重建不删除其他库。服务关闭释放后台资源。

## 内部协作与文件归属

- **服务/模型负责人**：`plugins/library/src/search/model*`、模型清单和运行工作线程、依赖与打包脚本、`plugins/library/src/index.mjs` 服务生命周期、`plugins/workbench/src/index.mjs` RPC 与 owner 权限。负责固定 ONNX、分词、池化、归一化及真实模型评测对照，提供给索引的异步 `embed(texts, {priority, signal})`，返回与输入一一对应的归一化向量；`priority` 为 `query | index`，支持取消或丢弃结果。
- **索引负责人**：独占 `plugins/library/src/search/index*`、`plugins/library/src/search/chunk*`、相关独立测试；提供 `createSearchIndex({library, directory, embed, countTokens, modelVersion})`，返回 `start()`、异步 `search(request)`、`status()`、`notifyChange()`、`rebuild()`、`close()`；`countTokens(text)` 返回包含特殊 token 的数量，实际输入不超过 512。`search` 输入采用上述规范化请求，输出 `items/total/nextOffset`；状态提供 index 部分。资料库版本、内容哈希及删除校验必须在返回前发生，不能只依赖同步后可能复用的 revision；异步队列不可阻断原始保存。记录变更接入点与服务负责人先协商，避免并行改同一文件；包括同步、导入、删除、恢复、重启核对，不只工作台保存。
- **UI 负责人**：`plugins/workbench/src/client.jsx`、`WritingSources.jsx`、`reading/` PC 适配与组件、搜索共用组件和样式及其独立测试。仅 PC 适配器提供可选能力，移动适配器默认行为不变。实现既有编辑、引用和筛选的回归。查询、状态、启用、重建按上述 RPC；若需修改服务接口先协商，不能自行修改服务文件。
- **验收负责人**：隔离测试数据和端到端验收，覆盖真实模型、四入口、授权、版本竞态、离线与失败、Web 和桌面进程及目标性能；不使用真实资料库。未提交文件归原有工作所有，必要修改前协调。

跨负责人需要修改同一文件时由文件负责人集成；契约变更先通知所有负责人及验收负责人。模型与索引可以独立测试，但只有真实 ONNX 和真实索引组合、四入口与实际桌面包均通过才能声称方案完成。
