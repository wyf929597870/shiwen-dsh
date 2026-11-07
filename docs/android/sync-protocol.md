# Android 同步协议草案 v1

状态：拟实施，接口和表尚不存在。日期：2026-11-06。上层目标与阶段见 [实施计划](README.md)，已选架构与恢复规则见 [架构决策与生命周期](architecture.md)。

评审修订：采用完整本地副本与可替换协调服务；明确稳定业务变更身份、手机先建库的初始化、协调节点恢复与跨代次汇合、附件传输和完整确认进度；保留先查回执、自身事件识别、原子恢复、离线活动链等规则。修订是协议约定，不代表功能已经实现。

## 1. 不变量

1. 关联服务的资料库同时只有一个同步协调服务端，多个手机持有完整本地副本并可独立离线编辑，经该服务合并；手机独立库无需服务。不同服务的不同库不互相复制。
2. 记录身份为 `(libraryId, recordId)`。地址、节点昵称、客户端时钟不是身份，也不是冲突裁决依据。
3. 手机编辑成功意味着正文、来源、草稿、本地活动和操作回执已在同一本地事务落盘；服务库副本还包含待同步操作，不意味着服务器已收到。
4. 服务端记录更新、revision 增长、增量日志、幂等回执在同一事务提交；pull 不产生新的业务编辑或统计。
5. 自动/手动只决定触发时间，不能改变一致性规则；冲突不静默覆盖，重试不重复新增。
6. 所有资料库完整保存正文、保留版本、关联、活动与库内附件/原件；不能由缓存淘汰、重登录或重建索引清除。初次同步未完成必须显示不完整状态。
7. 身份和同步协议是逻辑隔离，不能代替网络认证与 TLS。

## 2. 标识和版本

| 字段 | 生成与含义 |
| --- | --- |
| libraryId | 服务资料库首次迁移或手机独立库首次创建生成的 UUID，存于库 meta；改路径/地址/显示名称不变 |
| serverId | 服务安装身份，存于独立服务配置；整库移动保留 libraryId，但新服务重新登录并确认 |
| syncEpoch | 服务恢复旧快照/重置同步历史时更换的代次；变更后旧游标无效 |
| deviceId | 安卓安装生成；重装重新生成，不从系统备份复制，不等同登录凭据 |
| recordId | UUID；手机离线创建即可生成，服务器首次接收保留该 ID |
| changeId / versionId | 创建端生成的不可变业务变更/状态 UUID；恢复和重试保留，不能以时间戳或内容散列代替身份 |
| baseVersionId / parentVersionIds | 修改前业务状态；合并记录多个被裁决父版本，用于恢复时证明共同基线；不等于已实现对等因果协议 |
| originDeviceId | 变更/活动最初产生的设备身份，恢复不改；当前登录/传输设备另行校验，不作为权限凭据 |
| activityId | 同一 libraryId 内唯一的不可变活动 UUID；换安装/协调代次不改，旧数据迁移只生成一次 |
| revision | 当前 syncEpoch 内的服务端聚合版本，整数递增；正文/类型/日期/来源/关联/删除/恢复任何同步字段变化都增长 |
| localGeneration | 手机本地编辑代次；每次编辑增长，与服务器 revision 无关 |
| operationId | 当前协调代次的传输操作 UUID，请求冻结后重试用同一 ID；换代次重新封装时保留原 changeId，但分配新 operationId |
| seq / cursor | 单库变化日志的单调序号/不透明游标；不是更新时间或文件名 |

手机独立库在 registry 连接角色标为 `standalone`，没有 serverId、远端 revision、syncEpoch 或 cursor；记录使用 localGeneration 和本地版本/活动。保存成功就是本机已持久化，不创建针对不存在服务的 outbox，也不显示待同步。连接服务的副本标为 `coordinated`，使用下述对账和同步协议。手机独立库和服务库副本均不执行正文/版本/原件缓存淘汰。

添加已存在的不同 libraryId 服务库会创建独立副本。同一手机库首次启用同步则保留原 libraryId、记录 ID 和本地数据库，以该库快照初始化服务；不能把这条路径实现为跨库复制。首次完整初始化后，由服务确认 revision 基线映射；手机切换为 coordinated，不重放历史编辑来重新计算统计。

`serverId` 不作为本地库分区键。同一 libraryId 出现在不同 serverId 时，要求确认迁移；确认后单一活动连接，旧任务取消并保留队列。手工复制数据库另建不同资料库必须显式 fork 新 libraryId；同库合法副本通过加入/恢复协议保留原身份，不能让复制出的两个服务自行作为同库协调端运行。

恢复/导入不是同一语义：将旧工作台内容导入空库使用目标库身份；恢复为协调服务保留 libraryId 并更新 epoch；恢复到普通客户端则保留旧 epoch 为来源，重新授权并按当前服务身份对账；fork 新库生成新身份。公开恢复工具必须负责这些变化，手工复制运行中 DB 不属于支持路径。服务回档时先核对未确认 operationId 的状态，不能自动重放旧删除操作。

### 同库首次接入与协调节点恢复（新增契约要求）

服务初始接收手机库和恢复协调节点使用独立的、已鉴权的持久任务，不复用普通 records/create 导入。P0/P2 必须冻结本节和第 5 节 setup/reconcile 路由的 schema、任务授权、快照清单和回执；下方常规 push/pull 表还不能代替这套接口，未完成不得宣称“手机先建”和“换协调服务”已支持。

1. 用稳定 setupId、libraryId 和任务类型区分首次初始化与同库恢复；跨库导入走独立路径；目标只能是明确选定的空库位置或已停写的同库恢复位置，禁止覆盖其他库。首次初始化可由手机生成库身份，不能要求电脑先创建同名库。创建时 CAS 预留目标 generation/身份/epoch，持久租约绑定 setupId、所有者和递增 fencingToken；目标已有有效预留返回 SETUP_TARGET_BUSY。
2. 在一致切点分批暂存正文、保留版本、活动、关联、删除状态和库内附件/原件，按清单/散列校验；未齐全不对普通同步端发布。每步进度与任务状态持久化，同一提交重试返回同一回执。原始库始终保留；传输期间新编辑保留为后继分支，提交后再对账。
3. commit 与所有写入口共用维护门禁，原子复核有效租约、最新 fencingToken、预期 targetGeneration 和空目标/获准停写的同库状态；CAS 发布并递增 targetGeneration。旧 worker、已变目标不能发布；同任务已成功提交先查原回执返回，不再次 CAS。原子发布完整基线与服务端 revision 映射，保留历史身份和日期；不是把内容作为今天的 create 重建。首次手机入库的既存附件与后来导入的库内对象都使用受控 blob 通道；支持传输不等于新增拍照/录音等 UI 功能。
4. 协调节点丢失后从存活完整副本恢复，保留 libraryId，生成新的 syncEpoch/协调代次并明确更换授权。原 deviceId/opId/活动身份作为历史来源保留，不把别的设备凭据导入新服务。
5. 其他副本加入新代次时保留本地已确认基线、完整工作副本、活动、冲突及 outbox；先对比恢复切点与各自版本分支，不能仅迁移待上传项。旧服务已确认但恢复来源尚未收到的变更，也必须纳入差异对账。旧 ACK 不是新代次的确认依据。
6. 旧服务返回时不自动充当第二协调端；恢复任务记录协调身份/代次，客户端明确选择新代次后拒绝回退。未获知切换的离线设备可能仍持有旧分支，重入时保留并裁决；没有引入分布式共识，不能声称网络分区下自动消除双主。
7. 一个同步切点的“全体一致”要求对应数据/附件齐全、写入已确认、拉取完成且冲突已处理。同步设备进度仅证明其已确认部分，不能由一次服务 ACK 推断所有端都有副本。单节点丢失的容错范围仅覆盖已复制到存活节点的数据。

## 3. 服务端持久化与统一提交边界

建议增加：

| 表/结构 | 用途 |
| --- | --- |
| meta 的 sync 字段 | 库身份、当前协调身份/epoch、协议/最低写入版本、库统计时区；角色与完整性另存 |
| change_journal / version_identity | 持久 changeId/versionId、originDeviceId、基线/父版本与规范内容散列；本地保存、服务端写入、恢复统一映射 |
| sync_setups / sync_reconciliations | 任务身份、授权主体、模式、来源清单、阶段/块进度、发布回执；setup 另存 targetGeneration、租约、fencingToken 与唯一目标预留；reconcile 保存跨代次或同代次换机的来源授权和映射 |
| operation_payload_transfers | 与附件分开的规范业务载荷暂存、字节数/散列、分块进度、验证结果和任务引用；对象就绪不等于业务已应用 |
| sync_attempts | 非终态尝试的请求指纹及缺失依赖，用于等待期间禁止同 operationId 换正文；不充当成功或拒绝回执 |
| blob_objects / blob_transfers | 库内不可变内容散列、大小、所有权/引用、上传暂存和持久下载进度 |
| sync_changes | `seq, entityType, entityId, revision, versionId, changeId, baseVersionId, op, payloadRef, committedAt, actorDeviceId, operationId, requestFingerprint`；不可变事件，包含库身份和 epoch |
| sync_payloads | 已发布版本的规范快照/正文及来源；避免事件指向之后被改掉的内容 |
| sync_receipts | `(syncEpoch, deviceId, operationId)` 唯一，保存 recordId、请求指纹、acceptedGeneration、终态、错误码、revision、seq、canonicalPayloadRef、committedAt；冲突结果也可重复读取 |
| sync_devices | 同步设备、appliedCursor、completeCursor、完整清单摘要、最后确认时间、暂停/退役状态；登录凭据仍由认证层管理 |
| sync_bootstraps | 有效期内的全实体/文件清单、不可变载荷引用、散列及切点 highWatermark |
| record_provenance | 创建/处理设备、处理方式、来源引用，旧数据字段可为空 |
| activity_events | `(libraryId, activityId)` 唯一，originDeviceId 为不可变来源，提交设备另存，保存事件指纹、操作关联、原发生时间、来源和校验后的 added/removed；与现有 edits 一一映射，不能生成两份统计 |

首次迁移给已有记录（含软删除项）及保留版本建立稳定业务身份和基线，不增加新增字数，也不伪造创建设备。迁移在事务中执行并有版本标记，重复启动不能重建一遍。

### 两种日志各自回答什么

- **操作回执**回答“这个设备此前提交的操作成功、冲突还是被拒绝”；普通接口只查询当前已授权设备的指定 operationId，不下载整库回执；所有者授权的 device-restore 任务可对备份清单内旧操作做受限映射。
- **资料变更日志**回答“服务端有哪些已提交变化”；包括本机 Web、桌面、Agent、MCP 和其他设备的写入。非移动写入由服务端生成 operationId，actorDeviceId 可为空，不能冒用手机操作身份。
- 普通进程日志只供诊断，不作为成功依据；不能靠解析日志文字、文件时间或查询记录是否存在来代替事务回执。

| 回执查询结果 | 手机行为 |
| --- | --- |
| applied | 验证库、epoch、deviceId、operationId 和请求指纹后，只确认 acceptedGeneration；保留后续本地修改 |
| conflict | 保存回执引用的远端版本与本地版本，阻塞该记录后续链，进入冲突处理 |
| rejected | 展示具体校验错误；修改后使用新 operationId，不原样无限重试 |
| unknown | 结果未知，可能从未到达、仍在提交或事务已回滚；保持原操作并按相同 ID/请求重试，不能当作失败而另建记录 |

applied/conflict/rejected 是已提交的终态；unknown 不是持久的失败回执。网络错误、超时、事务异常、限流以及可补齐依赖的 DEPENDENCY_MISSING 不保存成 rejected。后者是 push 的非终态 blocked-dependency 响应，带 missingDependencies/retryAfter；receipts 仍返回 unknown。sync_attempts 只保留冻结指纹和等待原因，不产生业务变化、活动或终态回执。认证和请求格式未通过时不登记回执。同一合法操作在事务内查重并校验状态；同 ID 并发请求必须串行查重或通过唯一约束重读原回执，不能先在事务外查询再分别写入。业务成功但回执写入失败时，整个业务事务回滚。

回执保留精确 revision 的载荷引用，用于处理旧 ACK；不能返回“当前记录”替代当时提交结果。暂不自动清理回执；后续清理必须同时规定设备确认与过期对账规则，不能删除后仍把 unknown 当作“从未执行”。epoch 改变时旧回执只作为恢复参考，不自动确认新代次状态或重放旧操作。

### 写入口审计清单

必须覆盖 `save`、`updateRecord`、`saveDsh`、`remove`、`restoreRemoved`、`restoreVersion`、`importDate`、所有日期入口、`importWiki`、`restoreBackup`、旧库迁移，以及 Agent/MCP 调用到的相应方法。文章关联、附件元数据、人格和记忆变更也需要各自的同步版本或明确标为不参与本次实体流。

统一 helper 在领域方法完成最终聚合状态后生成日志；例如 `updateRecord` 内部先 `save` 再改 origin/day/kind，不能在中间 `save` 提前发布旧元数据，也不能嵌套调用重复增加活动。`saveDsh` 的消息来源与日期需在同一外层事务结束前加入快照。

测试须对“修改入口 → revision/日志/最终 payload/活动”的映射逐项断言。不得仅依靠数据库 `updated` 字段扫描；日期修正和删除路径现状已证明其不完整。

## 4. 规范记录与来源

传输记录包含：`id, versionId, changeId, baseVersionId, revision, kind, title, markdown, origin, processing, contentDay, dateBasis, url, annotation, stage, sourceIds, createdAt, updatedAt, deleted, createdByDevice, sources, attachmentDescriptors`。

- 正文规范为 Markdown；渲染 HTML 不传回当正文。原始导入附件保留为只读来源，不同步本机绝对路径。
- 来源分段使用有序 `segments: [{text, origin, sourceRef?}]`，拼接必须与 markdown 完全相同。避免混用 UTF-8 字节与 UTF-16 偏移。原有结构化 doc 由服务器 codec 转换，不能简单把混合来源压成单个 origin。
- `processing` 拟定 `original / formatting / ai-organized / translation / unknown`，与 `origin` 分开；旧内容为 unknown。AI 经手保存不会自动改变作者，实质补写仍标 ai。
- 普通修改提交基线和编辑来源；服务端与 Kotlin 用同一组 fixtures 验证保留未改动片段、标记新增片段。用户明确纠正来源是独立操作，不能算作新增书写。
- 保留原始换行和 Unicode 文本，不在同步时隐式格式化或归一化。fixtures 包含中文、emoji、组合字符、CRLF、代码块、引用、表格和 Obsidian 链接。
- 元数据索引不带大正文；正文按精确 revision 获取。初次复制或增量同步尚未拿到正文时不能用空字符串覆盖它。
- 文章 `sourceIds` 只能引用同库素材；初始复制中关联素材正文可能尚未到达，应保留引用并显示同步进度；完成后必须补齐。跨库复制文章时让用户选择复制关联素材，或去除可点击关联并保留来源说明，不能引用另一库的裸 ID。
- 已删除素材的既有文章关联保留，并显示“来源已删除”，沿用当前行为。

## 5. 拟新增 API

基础前缀 `/api/shiwen/mobile/v1`；所有数据接口经 Host 鉴权，不使用旧回环 MCP token 作为局域网登录。密码会话复用 `/auth/*`。发布前冻结 schema 与状态码，下面是契约设计，不是当前可调用路由。

| 接口 | 请求/响应核心 | 说明 |
| --- | --- | --- |
| GET `/identity` | serverId/libraryId?/epoch?/targetGeneration/protocolVersion/capabilities/libraryName/libraryTimeZone/setupState | 登录后返回；空目标显式 libraryId=null；无密码、路径或原生 DSH token |
| POST `/devices/register` | 安装 deviceId、名称 → 绑定当前认证主体的设备登记 | deviceId 不是认证凭据，不能在 push 中任意冒用其他设备读取回执 |
| POST `/sync/bootstrap` | full-library → snapshotId/highWatermark/expiry/manifest | 创建全库一致快照清单，包含正文、保留版本、活动、关联、库内附件引用及校验信息 |
| GET `/sync/bootstrap/{id}` | entityType/pageToken → 快照页、nextPage | 各实体分页，覆盖 records/versions/activities/links/attachmentDescriptors；不读取变化中的 live records |
| GET `/sync/changes` | cursor/limit → events/nextCursor/hasMore/highWatermark | 按 seq 排序；包括 tombstone；limit、字节上限受服务端约束 |
| POST `/sync/push` | deviceId/libraryId/epoch/operations | 逐操作返回 applied/conflict/rejected 或非终态 blocked-dependency，允许部分成功 |
| POST `/sync/receipts` | libraryId/epoch/deviceId/operationIds → 逐项回执或 unknown | 每轮先查发送过但未确认的操作；按固定上限分批，空队列跳过 |
| POST `/sync/ack` | epoch/appliedCursor/completeCursor/manifestDigest | 设备持久确认；完整进度不能超过已应用进度，不代替本地提交 |
| GET `/devices/progress` | 当前库设备、最后确认代次/切点/时间/完整性 | 仅返回已登记设备的真实确认，不暴露凭据；长期未连接标记未知最新状态 |
| GET `/records/{id}` | revision → 正文、来源和元数据 | 不允许把较新正文与旧元数据拼在一起 |
| GET `/attachments/{id}` | 版本/hash、Range | 内容校验和受控读取；原件只读，支持续传 |
| GET `/review` | period/month/timeZone | 权威活动统计；响应标注已同步范围和时间切点 |

### 全库初始化与恢复 API

以下均在同一基础前缀下、经所有者会话及相应 capability 验证；服务端配置指定目标库位置，客户端不能给任意磁盘路径。

| 接口 | 合同 |
| --- | --- |
| POST `/setups` | setupId、模式 initialize/recover、libraryId、预期目标 generation/身份、来源切点/epoch、manifest 摘要；原子独占预留空目标或已停写同库目标；返回 targetGeneration/fencingToken/leaseExpiresAt、状态与限额 |
| POST `/setups/{id}/lease` | 当前令牌及目标 generation，已授权所有者续期或重新预留；失效后重获递增令牌并重查目标，不能复活旧 worker |
| GET `/setups/{id}` | 已验证页/对象、缺项、阶段、提交结果与基线映射分页令牌；仅创建者或重新授权的所有者可读取 |
| PUT `/setups/{id}/pages/{pageId}` | 不可变实体页及散列；同页同内容可重试，同 ID 不同内容拒绝 |
| POST `/setups/{id}/commit` | 固定业务请求指纹/manifest；租约令牌作为可更新的权限元数据；先查已提交回执，再原子复核租约、fence、目标 generation/身份/状态、全量引用与对象，CAS 发布并存回执；重复返回同一结果 |
| POST `/setups/{id}/abort` | 仅中止未提交任务；提交后返回已提交状态，不能反向删库 |
| POST `/reconciliations` | mode=coordinator-recovery/device-restore、当前授权、libraryId、来源/目标 epoch、当前安装与来源设备、备份清单/已确认基线；device-restore 允许 epoch 相同，所有者授权限定来源范围 |
| POST `/reconciliations/{id}/receipts` | 仅授权备份清单内的旧 operationId、设备、原指纹及 changeId/versionId → 旧确切回执/当前业务映射/unknown；不开放任意设备回执查询，不以来源 ID 代替权限 |
| PUT `/reconciliations/{id}/pages/{pageId}` | 分页提交旧分支的状态/变化/活动清单，保存后计算缺项与差异 |
| GET `/reconciliations/{id}` | 分页差异、可证明的版本映射、冲突、缺失对象和已处理结果 |
| POST `/reconciliations/{id}/apply` | 稳定 resolutionId、旧 changeId/版本、裁决及当前目标 epoch/基线；逐条事务提交、可对账；目标期间又变则重新冲突 |
| POST `/reconciliations/{id}/complete` | 只有清单齐全且所有差异已确认/裁决才完成，再建立当前安装/目标代次普通同步基线 |

普通 push 的旧 epoch 请求返回 EPOCH_CHANGED，不偷偷接收为新库修改。恢复入口可以保留旧来源身份，但不能把其当作当前设备权限。setup/reconcile 若源完整性不足，先报告缺项并允许从另一个明确授权的同库副本补齐。setup 未齐全只处于 receiving + rescue 暂存，可只读预览/导出；候选不得发布正常可写协调库、普通同步或 Agent 写入，也不得完整确认。补齐并验证同一清单后才 ready；不同版本分支先裁决，不拼成虚假快照。reconcile 的缺项留在任务暂存区，阻止该任务 complete，不停用已有完整目标库的正常业务；目标继续变化时 apply 仍逐条核对当前基线。取消停止传输、释放自己的预留（如有）但保留候选和原来源；清理候选另行确认。详细状态机和故障恢复以 [架构生命周期](architecture.md) 为准。

setup 的续期、恢复和 abort 必须验证当前任务/fencingToken；过期任务重新预留需重新检查目标，不能凭旧 ready 状态发布。abort 只释放自己的预留，不删除候选或原库；已提交返回已提交状态。提交结果与发布指针一致落盘，服务崩溃恢复不得复活旧租约或回退 fencing 计数。

### 库内对象与附件

| 接口 | 合同 |
| --- | --- |
| POST `/blobs/uploads` | 库、任务上下文、大小和 SHA-256 → uploadId/分块限额/缺失区间；去重只限当前已授权库 |
| PUT `/blobs/uploads/{id}/parts/{part}` | 固定区间与散列，重叠不同内容拒绝；不接受客户端路径 |
| GET `/blobs/uploads/{id}` | 返回持久进度与终态，断线续传先查询 |
| POST `/blobs/uploads/{id}/commit` | 校验完整大小/散列后发布库内不可变对象；同请求可重试 |

正常正文变更引用的对象必须已在服务端校验可用；尚未到达的合法库内对象返回 DEPENDENCY_MISSING/blocked-dependency（非终态），列出缺项并保留原 operationId、业务载荷和本地队列。补齐并验证对象后，以原 ID/指纹重试；先查回执，unknown 仍不代表失败。依赖等待不循环空推，上传完成/服务依赖状态改变/手动同步时核对后唤醒，未齐则退避；其他无依赖记录继续。格式错误、跨库引用或已证实散列不匹配属于终态 VALIDATION_ERROR/PERMISSION_DENIED，不当作暂缺。对端下载时先保存持久任务，临时文件完成校验再发布，数据库引用与文件发布通过可恢复状态机衔接。删除正文不立即删除历史版本仍引用的文件；不跨库去重泄露对象是否存在。

分页查询 records/versions/activities/links/附件描述符须给出不可变实体 ID 和版本；不能只发送新正文却遗漏关系、历史与统计。已导入库内附件的上传下载是完整复制的必要部分；新增拍照、录音、任意外部文件导入入口可另行迭代。

### 两个确认进度

`appliedCursor` 表示变更内容或其精确版本的持久待下载任务已落盘；`completeCursor` 表示截至该切点所需正文、版本、活动、关联和库内文件均已校验。存在未补齐依赖时 completeCursor 不得前移。初始全库复制先确认完整基线清单，再推进完整游标；仅索引分页结束不能提交完整确认。

本机仍有 outbox/冲突时可以报告已完整接收的切点，但 UI 不显示双向全部同步。GET devices/progress 仅显示设备曾确认的事实；一台设备最新是否仍保有数据无法靠旧 ACK 保证，需显示时间。服务 ACK 不证明第二台客户端已有副本。

### 长文业务载荷传输

正文/附件权限与所属库一并检查。单条正文沿用现有 1,000,000 字符业务上限，字符计量与现有保存接口一致，由跨语言边界 fixtures 固定；来源 segments 和活动快照不能因 HTTP 限额被删掉。普通 push 批次建议最多 100 项且 HTTP body 不超过 4 MiB；这只是传输信封上限，不是完整操作的业务大小上限。单操作超出 inline 限额时使用以下独立载荷通道，不拆成多次正文保存。

| 接口 | 合同 |
| --- | --- |
| POST `/operation-payloads/uploads` | 当前授权库/任务、规范编码版本、预期字节数/散列 → uploadId、块限额/缺失区间；与附件命名空间隔离 |
| PUT `/operation-payloads/uploads/{id}/parts/{part}` | 固定区间/散列，幂等上传，禁止不同内容覆盖；限额按块验证 |
| GET `/operation-payloads/uploads/{id}` | 持久进度、就绪状态及到期信息；断线先查询 |
| POST `/operation-payloads/uploads/{id}/commit` | 全量大小/散列与规范 schema 校验后生成不可变 payloadRef；不写记录、revision 或活动 |
| GET `/operation-payloads/{ref}` | 经库/任务授权按 Range 下载不可变载荷，返回编码/大小/散列；用于 pull/快照的大实体 |

- push 每项在 `inlineBody` 与 `payloadRef + digest + byteLength + encodingVersion` 中二选一；二者解码后都是第 6 节同一完整操作。规范序列化规则由 P0 fixtures 固定，operationId 的请求指纹按规范业务请求计算，忽略 uploadId、传输地址与分块方式；从 inline 改引用或重新上传相同字节不改变操作身份。changeId 的业务指纹另排除协调编号，沿用第 2/6 节规则。
- 引用只限已授权库/任务且已校验的载荷；未完成返回非终态依赖等待，确定错误的散列或 schema 则明确拒绝。解析、来源/活动链校验采用有界缓冲与临时表，正文、版本、活动、日志、回执仍一次事务提交。载荷就绪不代表已保存，同一引用也不能绕过 operationId/changeId/活动去重。
- bootstrap/setup/reconcile 的实体页与 changes 同样按字节分页；单实体放不下时使用上述不可变载荷引用及可恢复下载，页/manifest 包含编码、大小、散列。setup 只有引用内容也全部验证后才 ready；下载任务未完成不得推进 completeCursor。
- capabilities 必须声明 maxBatchOperations、maxRequestBytes、maxInlineBytes、maxPartBytes、maxCanonicalOperationBytes、编码版本、过期/续传规则。规范操作上限必须覆盖业务允许的完整正文、来源和活动链；既有合法长记录及历史均可传输。P0 测量重复正文/转义/中文/emoji 和冲突分支链的最坏输入，不能把 4 MiB 复用成该上限；如一次裁决包含任意长历史，使用不可变子载荷清单分块校验，仍原子裁决，不能靠截掉历史达标。
- 客户端发送前按 UTF-8 字节估算并选通道；413 时刷新能力、缩小块或改引用，先核对原请求，不换业务身份。无法承载既有合法数据的服务视为协议能力不兼容，保留本地资料并提示升级，不无限重试、不截断、不宣称完整同步；P0 必须解决后才可发布。存储不足暂停保留进度。
- 未完成/未提交载荷的清理受任务引用保护；已提交内容由业务版本持久存储或引用接管后才能清理传输暂存。快照所引用对象至少在快照有效期内可读；传输暂存过期可用原规范字节重建，再以原操作 ID 对账重试。

结构化错误：`AUTH_REQUIRED`、`PERMISSION_DENIED`、`LIBRARY_MISMATCH`、`PROTOCOL_UNSUPPORTED`、`CURSOR_EXPIRED`、`EPOCH_CHANGED`、`REVISION_CONFLICT`、`OPERATION_REUSED`、`DEPENDENCY_MISSING`、`ACTIVITY_BASE_UNAVAILABLE`、`PAYLOAD_TOO_LARGE`、`VALIDATION_ERROR`、`SETUP_TARGET_BUSY`、`SETUP_TARGET_CHANGED`、`SETUP_LEASE_EXPIRED`、`SETUP_TARGET_NOT_EMPTY`、`SETUP_NOT_READY`、`SETUP_ALREADY_COMMITTED`、`MANIFEST_MISMATCH`、`RECONCILIATION_REQUIRED`、`STORAGE_FULL`。401 停止自动请求等待登录；403 说明权限原因；409 按具体错误处理：业务版本冲突进入裁决，目标占用/变化进入任务核对，可补齐依赖进入等待；不能统一当作正文冲突；410 进入重建流程；活动基线不可用时保留待处理内容并核对恢复策略；网络、429/5xx 可退避重试，遵守 Retry-After。

会话和已确认记忆等可选数据走独立命名空间/游标，不能在开启对话同步时重新解释已有 record 游标。具体 endpoints 在 P5 的契约中补全且随包声明 capability，不能显示一个空转的开关。

设备登记必须绑定已鉴权主体和 libraryId；新登录可在身份核实后恢复本安装登记，撤销设备会话后不能仅靠 deviceId 继续同步。首次绑定、重装和复制本地数据库的处理分别验证。

## 6. 离线保存、push 与 ACK 的竞态

### 本地保存事务

保存一条记录时，同一个 Room 事务更新正文、localGeneration、来源、本地版本、本地活动、草稿状态和本地操作回执；远端副本另在同一事务中写入待同步操作。仅本机库使用本地回执防止重复保存，不要求同步 outbox。界面订阅数据库结果，再显示“已保存到手机”。数据库写失败要保留编辑缓冲并显示失败，不能显示成功回执。

每个操作至少包含：

```json
{
  "operationId": "uuid",
  "recordId": "uuid",
  "changeId": "uuid",
  "versionId": "uuid",
  "baseVersionId": "uuid-or-null",
  "originDeviceId": "uuid",
  "action": "create|update|delete|restore|restore-and-update",
  "baseRevision": 7,
  "localGeneration": 12,
  "occurredAt": "2026-11-06T10:20:00Z",
  "timeZone": "Asia/Shanghai",
  "payload": {},
  "activities": []
}
```

create 使用 `baseRevision: null` 和 `baseVersionId: null`。业务变更身份先于传输生成；来源/状态散列不包含服务分配的 revision/seq。普通操作校验 baseVersionId 与 baseRevision 指向同一状态；未知基线不能仅凭数值版本重定基线。deviceId/libraryId/epoch 位于请求 envelope，客户端所有生成 ID 需校验格式和长度。客户端时间只供活动显示，不参与赢者判断；设备时间明显异常时保留原值并标记待核对。

上述为字段示意，不是具体合法 create 请求。activities 的字段与链校验见第 9 节；纯删除、恢复、元数据修改、来源纠正和同步操作不产生正文写作活动。

### 服务端逐条提交

1. 校验认证、库身份、epoch 和能力。
2. 在同一事务内先查回执：相同 ID + 相同指纹返回原结果；相同 ID + 不同请求返回 `OPERATION_REUSED`，不改原回执。无终态回执时也校验 sync_attempts 中已冻结的指纹；依赖等待不能成为换请求体的入口。引用方式先核验声明的规范指纹与已验证载荷，未验证不能执行；同 ID 的终态回执不因传输暂存已过期而失效。
3. 对相同 changeId 校验不可变业务指纹：已应用的同一变化可映射到当前代次回执，不再写一遍；不同内容拒绝，不能靠换 operationId 绕过业务去重。普通 create 要求 ID 未存在；update/delete/restore/restore-and-update 要求 baseRevision 与当前一致，并满足对应的存活/删除状态前置条件。
4. 校验类型、来源、日期、活动链和关联依赖，调用统一领域事务；记录、新 revision、活动、日志、回执一并提交。合法请求发生冲突/永久业务拒绝时，只提交相应终态回执，不改变记录；合法依赖暂缺则仅持久保存尝试指纹/缺项并返回 blocked-dependency，不写终态回执。
5. 返回 operationId、acceptedGeneration、canonicalRecord、revision、seq。create 不因同名同正文就合并，不能把真正两条日记误去重。

批次逐操作提交，整体连接失败不代表全失败。依赖操作先发送，单条冲突不阻止其他记录。相同记录的操作按本地顺序串行，自动与手动共享每库互斥锁。

### 在途继续编辑

例如已发送 generation=12 时又保存到 13，ACK=12 只确认 12，并更新基线；13 仍显示待同步。不能用 ACK 的 canonicalRecord 覆盖 generation=13 的正文。

区分“已确认到哪个本地 generation”与“已观察到哪个服务端 revision”。旧 ACK 不得把已观察到的更高 revision 降回去；若服务端在 ACK 对应版本之后又被其他设备修改，保留那个版本为 remoteShadow，后续本地修改需要冲突裁决，不能直接换个 baseRevision 覆盖它。

所有请求发送前冻结内容并写入状态；重试 payload 不变。后续本地修改先保存为 successor，前一项确认后再用新基线生成新的 operationId。不能把不同内容塞进同一个重试 ID。允许合并调度和组批，不允许把多次正式保存的活动压成一个最终正文和时间；活动链与拆批规则见第 9 节。

新建后马上删除：若 create 从未发出，可取消发布并仅保留本地回收站；若是否送达不确定，先按原 ID 对账/重试确认，再发 delete。不能因移除本地队列造成服务端出现“幽灵记录”。

## 7. 初始同步、pull 和恢复

### 一轮同步

认证与身份检查 → **查询服务端回执、核对未确认操作** → 拉取远端变化并识别自身事件 → 提交剩余可发送队列 → 再拉取本轮远端变化 → 持久提交并 ACK。自动与手动都执行这个顺序，不能手动同步时跳过对账。

每轮按已捕获的有限 highWatermark 拉取，持续写入不会导致一轮永远结束不了。对账网络失败时保留队列，暂不提交未确认操作的 successor；其他没有依赖的记录不必被一条内容冲突阻塞。

### 首次初始化

服务端在一致读事务中物化全库清单和切点 H，覆盖记录正文、保留的历史版本、活动、关联、删除状态和库内附件/原件引用；正文引用不可变 revision，二进制引用内容散列。分页期间的新变化序号大于 H。手机持久保存各实体/文件传输进度，允许先显示已复制内容，但必须补齐清单内所有内容并校验后才标为“完整副本（截至 H）”；再从 H 拉增量，不按日期截断。snapshot 过期则重新获取并按身份/版本/散列复用已校验内容，不能混拼不同快照；旧快照不完整时不误报完整。手机原有新记录、版本、活动和 outbox 始终保留。

versions 和 activities 的分页 payload 必须覆盖统计与离线历史所需字段及身份；服务端已有版本保留政策决定应传哪些历史，不重建从未保留的历史。初始清单与增量都必须覆盖这些实体，活动按原身份去重，不通过重新 save 正文重建统计。库内附件下载校验后与描述符建立持久关联，未完成 blob 不发布为可读取原件。

记录游标推进不等于完整复制成功：若实体或文件仍待下载，先将精确版本/散列的持久下载任务与游标同事务落盘；完整性状态检查所有实体进度与下载任务；双向已同步状态还检查待上传与冲突，两个状态不混为一谈。空间不足暂停传输并保留内容及任务，不能用删历史正文的方式腾空间。

### 增量提交

同一 Room 事务完成“应用一页事件 + 更新 cursor”；事务失败不得推进 cursor。先按 libraryId/epoch/actorDeviceId/operationId/requestFingerprint 识别本设备事件，再处理普通远端变化；不能先看到脏记录就直接标冲突。

即使前置回执查询返回 unknown，原请求也可能随后才提交并出现在 pull 中。此时查询该 operationId 的已提交回执并持久化确认，或者把事件保存在持久待对账 inbox；查询暂时失败时不判成其他设备冲突，也不清除本地待确认项。只有事件内容或 inbox 与 cursor 同事务落盘后才能推进游标。

自身成功事件只确认对应操作和 generation，后续本地修改仍保留；其他设备的新版本存为 remoteShadow，与实际本地基线比较。回执成功本身不能让整个库显示“已同步”，还需要完成 pull、处理剩余队列和冲突。

分页事件载荷必须表示对应 seq 的已提交版本；不能读到 seq=10 却返回当前 revision=14。精确版本不可用时返回显式过期错误，引导重建，而不是静默混版。

### 同一 epoch 的换机恢复

备份恢复产生新 deviceId，不直接修改旧 outbox 的设备字段后上传。新安装注册并由库所有者授权 device-restore 任务，提交来源备份的不可变版本/活动清单和旧 envelope 身份/指纹。任务内受限 receipts 映射旧请求与已应用 changeId；存在则确认精确版本，不能把当前更高版本当旧回执。unknown 保留待对账，经任务 apply 时再次在事务内查 changeId/指纹：已应用仅映射，未应用按可证明基线恢复原业务变化，并在当前安装下生成新 envelope；发生新分支则裁决。旧安装与新安装并发提交同一 changeId 由库内唯一约束串行化，不能重复业务效果。

新设备期间编辑保留 successor，历史 activityId/originDeviceId 不改；完成差异与完整性核对后才解除恢复状态并建立当前基线。当前设备授权不自动继承旧设备会话，普通 receipts 不放宽查询权限。后续旧手机回归时按相同业务身份去重和基线处理，不因新手机已接管就覆盖其分支。

### cursor 过期/服务恢复

先保留 working copy、base、outbox 和 conflict，再获取新 snapshot，对未确认 operationId 做 receipts 对账，最后逐条比较基线。正常过期可自动重建元数据索引；epoch 改变/服务回档需要展示恢复提示和待处理变更，不能盲目重放。客户端已看到的删除/修改可能在回档后消失，必须作为差异展示而不是“同步成功”。

初始实现不自动清理 tombstone 或压缩未确认回执；bootstrap 临时快照可过期。后续日志压缩需引入最小保留 cursor、设备退役和全量重建规则后才能开启。长时间离线设备不能让旧删除记录复活，磁盘占用也必须有可观察指标。

## 8. 冲突与删除恢复

默认不做“最后写入胜出”，也不自动合并长文。

| 情况 | 行为 |
| --- | --- |
| 远端更新，本地干净 | 应用新版本 |
| 远端更新，本地有修改 | 保存 base/local/remote 三份，阻塞该记录的后续提交 |
| 远端删除，本地有修改 | 保留本地修改与 tombstone，提示保留修改或接受删除 |
| 本地删除，远端有修改 | 不删除新内容；提示阅读远端版本后再决定 |
| 本地恢复，远端又有变化 | 校验版本，失败进入冲突 |
| 新建 ID 已存在但无对应回执 | 返回 ID 冲突，不把同 ID 不同内容当成功 |

“使用手机版”也是基于最新 remote revision 的新提交；处理中远端又改，继续报冲突。“使用服务端版”先归档本地冲突副本，再清理该条待处理链。“手动合并”保留来源信息并以新操作提交。冲突列表的状态是未完成，不能因为 cursor 已推进就显示全库已同步。

### 服务端已删除时保留手机修改

采用显式 `restore-and-update` 动作：用户确认恢复原记录，提交 tombstone 的最新 baseRevision、完整手机正文/来源及可写元数据，使用新的 operationId。服务端要求记录仍为 deleted 且版本一致，在一个事务中完成恢复、写入正文、校验关联、递增一次 revision、记录版本/活动/单个变化事件和回执。不能由客户端先调 restore，再单独调 update；中途失败必须整体回滚，避免出现已恢复但内容仍旧的半成品。

如果记录已被他人恢复/修改则返回冲突，重新显示当前状态；如果服务已永久移除记录，则不能伪造原 ID 恢复，用户可明确选择另存新记录。普通 restore 仍表示只恢复服务端原内容，和 restore-and-update 分开。重复 restore-and-update 原样返回回执，不再增长 revision 或重复记字数。

接受服务端删除时，先在本地冲突历史保存手机内容，再结束该条待处理链；如果此前操作结果未知，先对账，不能仅删除 outbox。选择或复制现存正文不视为新的写作活动。

记录删除是 tombstone，revision 增长并进入日志；恢复也是新事件。本文暂不定义不可恢复的永久删除 UI，避免未确认设备受到影响。恢复旧正文不能同时回滚整个库的 cursor。

## 9. 统计、日期和来源不重复计算

### 活动链传输与校验

正式保存正文时生成不可变 activityId、changeId 与 versionId，和记录/本地回执同事务保存；关联服务时同时加入 outbox。每个事件包含：`activityId, originDeviceId, occurredAt, timeZone, beforeHash, afterHash, afterSegments, action, authorship`。hash 对规定序列化的 Markdown 和来源 segments 计算，算法/编码通过跨语言 fixtures 冻结；客户端不能只上传自己计算的 added 数字。元数据操作的 activities 为空。

服务器从已知基线的正文与来源开始，逐项校验 beforeHash 与上项 afterHash、重算 afterSegments 的 hash，再计算来源分组的 added/removed。最终活动快照应与请求正文/来源相符；纯复制、恢复或冲突选择按非写作 action 校验，不能借此把既有正文全算成个人新增。

v1 默认一项正式保存对应一项活动和一个顺序操作，允许把多项操作组批传输，不跨正式保存丢掉中间快照。successor 确认前记录 predecessor 引用，待前项 ACK 后补全服务端 baseRevision 再冻结请求。过大的离线链按前后依赖拆批，不能截断活动后只发送最后一天。自动草稿保存不产生正式写作事件。

冲突后的“保留手机修改”携带原分支的基线 revision/载荷引用和完整未确认活动链：校验分支内容并保留原事件时间；冲突解决操作自身是非写作活动，手动合并中新写的片段才产生新的 activityId。采用服务端版而放弃的分支只保存在本地冲突历史，不计入权威写作统计；UI 明确区别本地分支活动与已同步统计。

去重按 `(libraryId, activityId)` 与不可变事件指纹进行，originDeviceId 保留产生设备（未知旧来源留空），当前提交设备仅用于审计/权限：相同事件在新操作中重提不重复计数，不同内容复用活动 ID 则拒绝。旧分支基线无法校验时返回 `ACTIVITY_BASE_UNAVAILABLE` 并保留队列，不能默默丢失活动或改算到同步日；P0/P1 必须提供所需精确基线的保留和迁移方式。

### 日期与汇总口径

- contentDay 表示事情/文章发生日期；occurredAt 表示实际编辑时间；receivedAt 表示服务接收时间，三个字段分开。
- 离线写作同步后记到原编辑日，不全部算作联网当日。统计采用资料库统一时区，手机先建库时以设备时区初始化并持久保存；接入服务或旅行不自动换统计时区；用户修改日期不改写历史编辑发生时间。
- 服务端分别按 `(libraryId, activityId)` 和 `(syncEpoch, deviceId, operationId)` 去重，换机/换代次不重建活动身份；本地渲染下载内容、重试、同步重放、重建缓存都不能增加字数。
- 现有 `edits` 用服务保存时刻，P1 必须提供同步写入的原活动时间和去重键，并验证最终来源分段差异。活动事件不能由客户端随意提交一个新增字数；要有对应编辑链可验证。
- 历史导入仍只计历史内容；跨库复制用“复制/归入”事件，手机原创跨库复制可保留来源活动引用（同库启用同步直接保留原活动身份），不能在同一库重复计数，也不凭复制时间冒充当天书写。
- 手机独立库直接使用完整本地活动统计；服务库副本使用完整同步至切点的活动历史，本地待同步活动单列，不重复合计。初始复制或增量补齐期间明确统计尚未完整，完成后断网不影响计算完整已同步历史；尚未知的远端变化以最后同步时间提示。

## 10. 自动与手动调度

自动触发：前台打开/返回、保存后合并短时间请求、网络变化时检查已绑定地址、前台收到服务端变化提示时拉取。提示只负责唤醒 pull，增量日志才是事实源。

后台采用每库唯一 WorkManager 任务，使用可用网络约束；不能只要求“互联网已验证”，否则无外网的局域网也会被挡住。Wi-Fi 名称相同不代表服务可达，必须实际连接并校验身份。并发最多两个不同库，每库仅一个任务；前台手动任务与后台任务用同一租约/互斥机制。

周期任务建议 30 分钟作为后台补偿，并允许系统延迟。Android WorkManager 的周期任务最小间隔为 15 分钟，执行时间还受约束和省电影响；不承诺锁屏后回家立刻同步。[官方说明](https://developer.android.com/develop/background-work/background-tasks/persistent/getting-started/define-work)

手动“立即同步”唤醒当前库现有任务，不另建并发引擎；“全部同步”只排入已绑定且允许尝试的库，各自展示结果。取消同步停止后续请求，已提交变更不回滚；结果未知的请求保留原 operationId。

关闭自动同步后取消周期任务与事件触发，保留正在处理的已发送请求回执和待同步队列；之后只响应手动同步。后台关闭但自动开启时，只在应用前台自动同步。

状态分层：连接 `reachable / unavailable / permission-required / login-required / identity-changed`；任务 `idle / queued / running / paused / failed`；记录 `local-only / pending / synced / conflict`；pending 的原因可为 blocked-dependency，保留原冻结请求且不显示永久失败。离线不是同步失败；401 也不是 Wi-Fi 故障。

## 11. 不同资料库之间的复制

本节只适用于不同 libraryId，不用于手机库接入同库同步。registry 增加持久 transferId：先在来源库登记 transfer，再在目标库用唯一 `(sourceLibraryId, sourceRecordId, transferId)` 创建记录（目标为远端副本时同事务创建 outbox），确认目标本地事务后才把来源标为“已归入”。重启逐步恢复；跨文件不能假装一个 SQLite 事务原子完成。

跨库复制保留原作者、日期和来源描述，新建目标 recordId，不共享后续编辑。默认不复制会话、API Key、服务路径或 Agent 记忆。源库记录仍在，除非用户明确做归档/删除。目标服务暂时离线不妨碍先保存到目标手机副本。

### 本轮跨库复制仅复制文本

预览中列出不复制的图片、附件和原件。使用 Markdown/Obsidian 解析器识别源库附件 ID、相对文件引用和内嵌图片，不能靠简单正则替换；目标正文将这些引用转为非链接说明，如“附件：散步照片（保留在来源库）”，并留下不可执行的来源记录说明。不复制 attachmentDescriptors，也不把源库 token、绝对路径或带鉴权参数的 URL 带过去。不能判定归属的相对引用也要求在预览中处理后才能复制。

普通公开网页链接可保留；图片仅保留说明和可公开的来源链接，不在复制过程中下载二进制。转换不改变来源文件，派生文本仍标记为复制/排版而非新增原创；用户确认预览后才创建目标记录。所选关联素材也按同样规则复制，并在目标记录提交前完成 ID 映射。完整附件跨库传输须等 blob 协议实施后再开放，不能显示成功但留下不可访问的旧库引用。

## 12. 必测故障用例

| 用例 | 必须观察到的结果 |
| --- | --- |
| 两手机并发 initialize/recover 同一目标 | 同一 generation 只有一个有效预留能发布；另一任务不覆盖，目标变化重新评估 |
| 租约过期/服务重启/旧 worker 迟到 commit 或 abort | 递增 fencing 阻止旧发布/错误释放；已提交重试仍取原回执 |
| 同 epoch 换机，旧操作提交成功但 ACK 丢失，旧手机随后上线 | 新安装只经授权任务查询/映射旧操作；记录、版本、活动各一次，无凭据克隆 |
| 依赖暂缺后补齐、同 ID 重试及等待中篡改请求 | 暂缺无终态 rejected；原请求可成功，篡改被拒，其他记录可继续 |
| 来源缺附件/原件后取消并重启恢复 | 候选与原库保留，仅救援只读；无正常可写发布、无完整 ACK |
| 接近 1,000,000 字符中文含来源/活动重复快照；分块中断、413、ACK 丢失 | 原身份续传或切引用，整体一次提交/一次统计；全部历史完整 |
| 大载荷散列不符/过期/跨库引用/应用事务失败 | 不提交半条业务；过期可原样重传，越权拒绝，事务失败业务/回执一起回滚 |
| 保存后立即杀进程 | 本机库正文/活动/操作回执存在；远端副本还必须有 outbox，无成功提示后的丢失 |
| 零节点长期使用和清缓存 | 手机资料库无需握手可保存/搜索/回顾；正文、版本、活动不被缓存淘汰，无虚假待同步 |
| 手机先建库后接入服务、重复提交初始化 | 同一 libraryId/recordId、历史活动和关联保留；恰好一次初始化，中途失败不丢原库 |
| 更换协调节点，其他设备仍有较新已确认版本或未同步修改 | 比较所有存活分支，不只重放 outbox；保留差异/冲突，旧代次不能覆盖新代次 |
| 初始化提交成功但响应丢失；commit 后再 abort | status 找回同一发布结果，不重复建库、不撤销已发布内容 |
| 已应用元数据但附件下载中断 | appliedCursor 可推进，completeCursor 不冒进；下载校验恢复后才确认完整 |
| 换新 epoch，重提已存在 changeId/活动 | 同业务指纹只映射确认，不重复写入/计数；不同内容复用身份拒绝 |
| 服务库全量复制后断开电脑 | 跨月正文、历史版本、活动、关联、库内附件可离线使用；清缓存不删除资料 |
| 全量复制中断/空间不足/快照过期 | 进度可恢复且版本一致，不冒充完整副本，不丢本地新内容，不降级为近期缓存 |
| 服务提交后响应丢失 | 同 ID 重试返回原回执，不重复记录、版本或字数 |
| 确认丢失后手机又继续编辑，下一轮 pull 到自身事件 | 先按回执/operationId 确认旧代次，不误判冲突，新修改仍待同步 |
| 回执先返回 unknown，原请求随后提交 | pull 能识别自身操作；原 ID 重试也只提交一次 |
| 同 ID 两个请求并发进入/回执写入失败 | 同 ID 恰好一次提交；失败时正文、版本、统计与回执一起回滚 |
| 已观察到 revision=10 后才处理 revision=8 的旧回执 | 只确认相应 generation，不降级远端基线或覆盖新版本 |
| 同 operationId 改请求体 | 明确拒绝，不能复用旧结果伪装新请求成功 |
| generation=12 在途时编辑到 13 | ACK 12 后仍有 13 的修改与待同步状态 |
| 收到事件写一半断电 | cursor 不推进，重新应用不重复统计 |
| 首次分页期间电脑持续新增 | 切点后的记录从增量补齐，无遗漏/混页 |
| 双端改正文或改日期/来源 | 不静默覆盖，元数据同样参与版本判断 |
| 一端删除一端编辑 | 本地内容和远端 tombstone 都保留，可裁决 |
| restore-and-update 中途故障、重复请求或远端先恢复 | 整体回滚或恰好一次提交；远端变化返回冲突，不能只恢复旧正文 |
| 库 A 请求返回时用户切到 B | 响应仍只写 A，B 的页面和会话不受影响 |
| IP 被另一服务占用 | 身份不匹配即停止同步，不自动发送旧队列 |
| 撤销设备/密码变更 | 后续数据调用及长流失效，保留本地未同步内容 |
| cursor 过期/服务回档 | 安全重建并对账，不清空 outbox、不重放旧删除 |
| 元数据新、正文旧或未下载 | 不显示已是最新，不以空正文写回 |
| 同一素材通过 Agent/MCP/Web 修改 | 都能被手机 pull 到，不漏写入口 |
| 清缓存、删除节点、手机存储满 | 脏数据不清理；失败明确；服务端记录不被误删 |
| 跨库复制中途崩溃 | 恢复后恰好一个目标记录，源内容仍可找回 |
| 跨库复制含附件、相对图片和关联素材 | 预览说明未复制项，目标无旧库附件引用或凭据，源正文/附件不变 |
| 连续两天离线写作后同步 | 按原编辑日统计，历史导入/来源纠正不算新写作 |
| 活动链拆批重试、跨操作重复事件及冲突解决 | 日期与来源正确，每个活动只计一次；被放弃分支不混入服务端统计 |
| Emoji/混合来源 Markdown 往返 | 原文和来源分段一致，不出现乱码或作者被改 |

完成协议仿真后再做真实安卓与独立服务互通；既有桌面/插件测试不能替代上述新增协议验收。稳定变更身份、恢复分支和未来协议边界见 [架构决策](architecture.md)。
