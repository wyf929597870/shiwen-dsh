# Android P0 实施与验证记录

2026-11-06。**P0 进行中；尚未准入 P1/P2 的正式数据迁移与同步接口上线。** 本文件记录实际完成项，不以验证探针冒充完整客户端。现有桌面版本仍为 0.1.7，未改动个人资料库。

## 已实现

| 产物 | 位置 | 当前边界 |
| --- | --- | --- |
| 独立 Android 工程及本地页面 | [android](../../android/README.md) | React/Capacitor；手机助手多会话、五栏导航、设置与直接记录，资料同步未接入 |
| Kotlin 原生事务保存 | [Repository](../../android/native/app/src/main/java/io/github/wyf929597870/shiwen/probe/ProbeRepository.kt) | Room 一次写正文、业务身份、活动、回执；草稿按代次清理，独立 P0 数据库 |
| 严格协议与 JSON Schema | [契约](../../contracts/mobile/v1/README.md) | 草案，尚未作为服务 capability 发布 |
| JS/Kotlin 规范编码与指纹 | [JS](../../plugins/library/src/sync/canonical.mjs)、[Kotlin](../../android/native/core/model/src/main/kotlin/io/github/wyf929597870/shiwen/model/Canonical.kt) | 相同固定 fixtures；无隐式 Unicode/换行格式化 |
| 持久 SQLite 协议模型 | [测试模型](../../tests/support/mobile/coordinator.mjs) | 临时库测试；不是现有 store 的迁移、HTTP 路由或生产协调器 |
| 原生网络隔离探针 | [NodeClient](../../android/native/app/src/main/java/io/github/wyf929597870/shiwen/network/NodeClient.kt) | 精确 origin、禁止自动重定向；增加原生密码登录、Keystore 节点与会话持久化、人设快照 |
| 原生 Agent 适配与任务日志 | [NativeAgentProbe](../../android/native/app/src/main/java/io/github/wyf929597870/shiwen/agent/NativeAgentProbe.kt)、[NativeAgentTasks](../../android/native/app/src/main/java/io/github/wyf929597870/shiwen/agent/NativeAgentTasks.kt) | Koog 1.3.0；原生流式工具循环、任务日志、首页桥接；真实供应商尚未验收 |
| 手机模型配置 | [ModelConfigStore](../../android/native/app/src/main/java/io/github/wyf929597870/shiwen/agent/ModelConfigStore.kt)、[ModelTransport](../../android/native/app/src/main/java/io/github/wyf929597870/shiwen/agent/ModelTransport.kt) | 原生输入框、Keystore AES/GCM、本机持久化；HTTPS OpenAI 兼容协议，不自动测试连接或生成 |
| 节点上的 Agent 与记忆管理 | [页面](../../android/web/AgentSettingsPanel.jsx)、[原生接口](../../android/native/app/src/main/java/io/github/wyf929597870/shiwen/network/NodeAgentActions.kt) | 管理选定节点的拾文身份/SOUL/全局记忆；确认/拒绝候选、编辑/删除；不冒充任意 DSH 预设编辑或本地完整库同步 |
| 节点上的 DSH 管理 | [Host 适配器](../../plugins/mobile/src/management-adapter.mjs)、[原生管理接口](../../android/native/app/src/main/java/io/github/wyf929597870/shiwen/network/NodeManagementActions.kt) | 固定动作白名单、所有者鉴权；插件/排程调用原有 Host 服务，外部客户端凭据只在原生窗口显示，手机页面单独验收 |
| 持久分块对象探针 | [ChunkStore](../../plugins/library/src/sync/chunks.mjs) | 分块校验、断点恢复、有界缓冲合并与发布故障恢复；尚未接入生产 HTTP 与业务解析 |
| 构建环境检查 | [doctor](../../android/scripts/doctor.mjs) | JDK/SDK/本地资源/禁止远程页面检查 |

## 实测结果

- `npm run test:mobile`：39 项通过（含新增 profile/session/真实库路由验证）。覆盖重试指纹、Unicode、近 100 万字符中文、事务回滚、丢 ACK、同 epoch 换机、依赖等待、并发 setup、租约过期、原子发布、救援暂存、不可变活动/版本身份以及分块持久传输。
- `npm run check:mobile-kotlin`：6 组相同编码/散列 fixtures 通过，另覆盖非法 Unicode/数值与 UTF-16 长度边界。使用本机已缓存 Kotlin 1.9.22 的 JVM 编译器；实际 Android 工程另使用 Kotlin 2.2.21。
- 原生 `testDebugUnitTest`：8 项通过。3 项网络隔离测试验证同 IP 不同端口不串 Cookie、跨源拒绝和 HTTP 明确授权；新增 5 项使用本机 TLS MockWebServer，覆盖 400 个快速 SSE 片段不丢字、真实 Koog 工具循环、缺 `[DONE]` 不执行工具、截断/过滤结果拒绝，以及重定向/429 不重试。
- `assembleDebug` 与 `assembleDebugAndroidTest`：编译成功。P0 包名独立为 `io.github.wyf929597870.shiwen.probe`；构建结果尚不证明设备上保存成功。
- `connectedDebugAndroidTest`：已在用户通过 USB 授权的 Android 17 真机执行，3 项通过，0 失败、0 跳过。覆盖重新打开数据库、重复保存只一次、旧确认保留新草稿、回执故障整体回滚。使用独立随机测试数据库；数据库重开测试不等于整机强停恢复或界面验收。
- 新增原生 Agent 仪器测试 7 项，连同原有 Room 测试共 10 项在真机通过。覆盖 Koog 实际工具分发、重复工具保存只一次、流式片段、跨库读取拒绝、缺 End 帧不写入、取消不重试、任务回执持久化、重新打开任务库后不重发、独立任务所有者生命周期。模拟的是模型响应；使用真实 Agent 引擎和 Room。进程遗留状态通过持久库 fixture 重建，尚不能替代 Android 系统强停验收。
- 首页与配置接入后完整仪器测试共 **18 项在真机通过**：增加 4 项 Keystore 密文存储/重开/换地址/损坏清理测试、2 项 v1→v3 任务库迁移和草稿代次测试、2 项 PhoneAgent 桥后端与真实客户端初始化测试。测试使用独立 namespace，未读取用户资料或配置。采用 `adb install -r` 更新应用和测试包后执行 instrumentation，未卸载用户应用；当前手机用户空间为安装与测试的共同目标。
- 本轮设置/节点/人设/多轮整合后 **26 项仪器测试在真机通过**：包括原生密码登录与 Cookie 持久化、JS 生成的 profile fixture 在 Kotlin 校验相同散列、变更内容拒绝、离线缓存保留、换地址凭据清除、多会话草稿与上下文隔离、模型/人设变更保护。已用 `install -r --user 0` 覆盖安装新应用，保留现有数据；测试对象仍是隔离资料库和模拟 HTTP 服务，没有访问真实节点或模型。
- 接入 Agent 与记忆管理后的最终完整仪器测试 **35 项通过，0 失败、0 跳过**。新增 9 项覆盖管理字段白名单、全局/项目记忆隔离、真实整数 revision、候选确认/编辑/删除、缺失写回执、断线不重试、配置地址变化后的迟到写响应、不同节点隔离，以及“写成功但人设刷新失败”仍明确保存成功。最终 APK 已覆盖安装。该轮在 Keystore 系统调用出现约 171 秒等待，进程诊断后恢复并完成；不能据此声称后台/系统冻结行为已验收或把它当作应用代码死锁已修复。
- `npm test`：87 项通过；`npm run build`：现有桌面/插件构建通过。沙箱最初阻止回环端口/子进程，授权重跑后通过，无业务回归失败。源码审计通过，数据库、APK、缓存和凭据未混入源码集合。
- `node scripts/check-password-auth.mjs`：真实独立 DSH Host、临时资料库和合成密码通过。除既有认证/撤销/重启检查外，新增两次独立登录之间的人设修改与快照变化、记忆增删、过期 revision 拒绝；未调用模型。验证脚本显式使用当前 source build，避免旧 `.runtime/server/current.json` 导致测到旧接口；第一次旧缓存返回“未知操作”后已修复验证入口。此项是电脑上的真实 Host 验证，Android 端仍使用 MockWebServer，尚未声称真实手机 LAN 服务整链通过。
- 浏览器实际检查新首页 390×844、320×568、320×400：无横向溢出，底部导航在视口内；低高度收起顶部装饰区，保留导航与输入区。直接记录跳转正常；没有原生桥时明确禁用保存和 AI 请求。320×400 仅为缩短视口模拟，不是 Android 输入法/系统生命周期验收。
- 五栏导航与设置页已复核窄屏布局；后续新增的有节点 Agent 表单因浏览器无法再次连接本地预览，仅完成源码/构建检查及原生后台仪器验证，尚未做浏览器实页或真机触摸流程验收。编辑中的退出确认、版本冲突与未知结果锁已在代码中实现，不能将这些当作完整 UI 端到端已通过。
- Android SDK 曾缺失；用户配置后 doctor 全部通过。当前构建使用 SDK 36、JDK 21、AGP 8.13.0、Gradle 8.14.3、Kotlin 2.2.21、KSP 2.2.21-2.0.4、Room 2.8.4。Koog/Ktor 的实际依赖升级后，OkHttp、MockWebServer 与 TLS 测试库统一为 5.2.1；Ktor 3.3.3。前端锁定 Capacitor 8.6.0、React 19.2.0。

## 评审五项的实际验证层级

### 管理菜单接入的追加验证（2026-11-06）

- 本轮 `npm test` **100 项通过，0 失败、0 跳过**；源码审计 256 个文件通过，`git diff --check` 通过。包括请求前持久化非敏感未决标记、重新进入页面仍拒绝重复写入、节点/菜单隔离、七种时间规则转换及文本编辑保留原规则。
- 最终原生构建与 **8 项 JVM 测试通过**；覆盖安装后，全量 **45 项真机仪器测试通过，0 失败、0 跳过**。新增 10 项验证固定动作拒绝、显式节点 Cookie、敏感数据投影、一次性凭据不进入 JS、断线/缺回执不重试、HTTP 400 未知副作用保守处理、改地址后迟到读拒绝/已完成写标记原节点结果。测试依然使用随机 namespace 和 MockWebServer。
- 该轮完整测试耗时约 115 秒，再次出现系统 Keystore 调用附近停顿，读取测试进程日志并发送非终止线程诊断后完成。此结果只证明断言通过，不作为后台性能或厂商冻结行为的验收结论。
- 真实隔离 DSH Host 验证通过：密码登录后的插件清单、排程创建/暂停/跨客户端读取/旧版本冲突/投递历史/删除，以及外部客户端创建/列表/撤销。列表和服务日志不含一次性 token。测试任务设置为未来一年且删除，未触发模型；未安装真实第三方插件或修改用户正在使用的服务。
- 追加 `scripts/check-android-host.mjs` **1 项真机真实 Host 整链通过**：Android 原生密码登录、完整 profile 校验、capabilities、插件包清单、排程列表、外部接入状态。服务端为电脑上的临时独立 DSH Host，手机经 USB `adb reverse` 连接；结束后移除该端口映射并清理临时服务。此项补齐原生与真实 Host 的接口契约验证，仍不代替 Wi-Fi/LAN 可达性或真实模型验证。普通全量仪器测试缺少该隔离参数时跳过此项。
- 新增页面状态回归验证：文本编辑不能改写原任务时间规则/目标；HTTP 200 中的版本冲突、安装失败和配置覆盖不得误报成功。手机页面布局与真实 LAN 操作不由这些后台测试替代。
- 管理页面通过临时模拟桥接在浏览器检查 320px 与 390px 宽布局：任务列表/详情/投递历史可达，七种时间规则切换均无横向溢出。模拟数据只用于布局验收，不写入真实服务，也没有打包进 APK。包含实际原生桥接的新 APK 已覆盖安装到手机，页面产物与 APK 内置资源散列一致；这不等于所有管理按钮已完成真机触摸验收。
- 浏览器也验证了设置到插件列表的导航。后续 CUA 连续超时，重置后多次获取浏览器状态仍失败；因此外部接入页未完成实页检查。投递历史日期字段已修正为 `deliveredAt`/`scheduledAt` 并纳入最终 APK，但此最后修正尚未在浏览器重载复核。原生和真实 Host 的对应接口测试已通过，不能用它们替代这两项界面检查。

### 同步协议探针

1. **并发初始化**：SQLite 模型用两个数据库连接验证唯一预留与 CAS；过期 worker 不可提交/abort 他人任务，提交崩溃回滚指针。尚未实现生产文件指针与 DB 的崩溃恢复状态机。
2. **换机去重**：模型在同 epoch、不同安装身份下用所有者授权任务映射原 changeId，旧手机回归也不重复活动；生产恢复 API、备份清单授权及跨代次完整分支汇合待实现。
3. **附件暂缺**：模型保存非终态尝试指纹，缺项补齐后原 operationId 成功，其他记录不阻塞。独立 ChunkStore 已验证持久分块与故障重试，尚未接入生产 blob 路由及写入口。
4. **不完整恢复**：模型缺引用对象时不能发布，abort 保留候选；救援来源收集与实际恢复页面待实现。
5. **长文**：近上限中文携正文、来源、活动的编码超过 4 MiB，选择引用通道。约 9 MiB 传输样例已验证分块落盘、重开恢复、64 KiB 缓冲合并与指纹一致。尚无业务 payload 的有界内存语义解析或任意长冲突历史子清单；64 MiB 是探针限额，不是完整发布能力。

## Agent 底座验证结论

- 当前 DSH 固定包 `@deepseek-ai/dsh-api-session-controller` 的 `SessionPromptRequest` 已包含 `requestId`，`hasPromptRequest` 查询 inbox 与持久 `user/message` 的 `rpcId`；存在复用原生会话的基础。
- 该源码观察不足以证明断电/并发、授权、请求正文指纹及计费请求重放全部安全；已增加调用真实 SessionController.prompt 包装器的注入式探针；队列/事件/取消仍为 fixture，仍需完整宿主故障验收，不能直接宣称恰好一次生成，也不能另起 DSH 子进程打开同一库。
- 手机原生候选已接入 `ai.koog:agents-core:1.3.0`，通过 Android 编译与真机模拟测试。使用 Koog 工具循环，不自研另一套 Harness；模型响应流完整结束后才允许工具分发，缺 End 帧、超限和取消均停止。依赖依据：[官方 SDK 文档](https://docs.koog.ai/)、[1.3.0 Maven POM 与 Apache-2.0 许可证声明](https://repo.maven.apache.org/maven2/ai/koog/agents-core/1.3.0/agents-core-1.3.0.pom)。当前未压缩 debug APK 为约 36.5 MiB，不能当作 release 包体或安装占用指标。
- OpenAI 兼容传输要求明确的 `stop`/`tool_calls` 与 `[DONE]`，缺终止标记、`length`/`content_filter` 不触发写工具。增量 SSE 行缓存上限 1 MiB，无整响应预读。测试期间曾误判 SDK 丢结束状态，实际根因是我们拦截器消费了源 Buffer；最终用独立复制目标及稳定 BufferedSource 修复，未保留凭空补齐 SDK 结束原因的逻辑。
- 首页草稿使用跨组件的串行写队列，原生端拒绝相同代次不同内容、忽略旧代次；已接收任务的迟到草稿写入不复活编辑区。ACK 在事务内比对正文和原文保存授权，不能用旧任务清掉不同内容。直接记录不会覆盖已有未完成草稿，列表刷新失败不再把已成功保存误标为结果未知。
- 当前仅开放库内检索、读取与“保存用户已确认原文”的工具；库、请求身份和已确认正文由原生侧绑定。AI 改写来源、批量变更、删除、正式能力表尚待完整资料库阶段；多轮上下文预算已接入。已有原文不因经由 Agent 工具保存而变为 AI 来源。
- 原生任务日志持久保存请求指纹、模型配置版本、部分输出、最终结果和工具回执请求 ID。重复 ID 只能查询已有状态，改变输入/模型配置则拒绝；重建只标记中断，不自动重发收费请求。任务所有者不依附页面，同库不能重复创建所有者并误回收活动任务。首页已接入状态、取消与真实回执；后台服务尚未实现。任务库迁移增加独立会话、草稿、冻结上下文与人设版本；旧单次任务与草稿转为只读归档，无法证明匹配的草稿不自动清除。
- [AI SDK ToolLoopAgent](https://ai-sdk.dev/docs/reference/ai-sdk-core/tool-loop-agent) 作为 JS 候选比较；依赖 WebView 的执行生命周期不满足原生持久任务的默认目标，不能因为已有 React 就直接采用。
- 用户明确选择先完成模拟验证，稍后自行在手机填写模型配置。本轮没有调用真实模型、使用已有模型 Key，或产生付费生成请求。

## P0 仍须完成才能扩大实现

- 完整应用强停恢复、键盘/桥接生命周期和长文性能；真机 Room 测试已通过。
- 同步 payload 的有界内存语义解析、完整 manifest 与跨代次 reconcile fixtures；持久分块探针和当前模型不能代替真实端到端同步。
- 原生登录、Keystore 会话持久化和人设缓存已实现；仍需真实 LAN 服务与实际 Android 局域网权限验收。为动态 LAN 地址启用平台 cleartext，NodeClient 显式同意且私网解析校验，模型仍限 HTTPS、WebView 不加载远程内容。
- 手机 Agent 的真实供应商与系统生命周期验证；DSH session adapter 的运行/取消/断线恢复验证。模型配置/密钥保存与首页已接入，但不据此宣称完整手机 Agent 和多端同步已交付。
- 冻结完整契约与兼容边界，再进入现有库写入口统一改造。

框架依据：[Capacitor 8 环境](https://capacitorjs.com/docs/getting-started/environment-setup)、[Room 依赖](https://developer.android.com/jetpack/androidx/releases/room)。依赖固定在源文件与 lockfile，不根据网页最新版本自动升级。
