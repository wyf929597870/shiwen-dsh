# Android 社区实现参考与拾文技术建议

调研日期：2026-11-06。范围：读取选定版本的实际源文件与官方框架文档；没有克隆成拾文底座、运行社区脚本、安装 APK、测试性能或验证插件兼容。下载的源文件仅存临时调研目录，不纳入仓库。

用户确认的是**参考社区的实现方式，继续按拾文需求开发**。当前架构已选完整多副本与可替换协调服务，后续决定以 [架构决策](architecture.md) 为准。下文把源码观察与拾文建议分开；建议仍需 P0 验证，不将社区 README 的能力或性能宣传作为本项目验收结果。

## 1. 固定参考版本

| 项目 | 本次源文件版本 | 参考范围 |
| --- | --- | --- |
| [saya-ch/dsh-mobile](https://github.com/saya-ch/dsh-mobile) | `b829e50d6c86c96281c6fec379e2e6538e8fa0f4` | WebView 桥接、多节点身份、切换代次、输入法 |
| [Soodok/Deepseek-Harness-Local-Android](https://github.com/Soodok/Deepseek-Harness-Local-Android) | `02e89ea7d9a6d211e38777c6a409f6cdf5dc0888` | 本机引擎进程、监督状态机、前台服务和 SDK 取舍 |
| [dphmoblie/deepseek-harness-android](https://github.com/dphmoblie/deepseek-harness-android) | `dd720649085d86606f223d896844af847dc82c28` | React/Capacitor 分层、原生插件、页面认证与缓存 |
| [sorsama/deepseek-harness-mobile](https://github.com/sorsama/deepseek-harness-mobile) | `ab68eb62be48fd90c7d89525762d6967661bd492` | 原生通信层、流复用、会话认证、连接保活 |

这些是抽样源码核查，不是四个仓库的全面审计。未来若复制代码或分发依赖，按实际文件保留许可证、署名与第三方说明；本轮只记录设计经验。

## 2. 界面和原生能力如何分工

**观察：** dphmoblie 的 package.json 使用 React、Vite 和 Capacitor；配置用 `webDir: dist` 打包前端资源。`MobileRuntimePlugin` 用 `@CapacitorPlugin` / `@PluginMethod` 暴露原生操作，耗时工作交给 executor，结果通过调用结果和事件回传。管理界面与运行中的 DSH 页面是不同职责，不能由此推断整个 DSH 前端已变成可独立导入的 React 组件。

证据：[前端依赖](https://github.com/dphmoblie/deepseek-harness-android/blob/dd720649085d86606f223d896844af847dc82c28/package.json)、[Capacitor 配置](https://github.com/dphmoblie/deepseek-harness-android/blob/dd720649085d86606f223d896844af847dc82c28/capacitor.config.ts)、[原生插件](https://github.com/dphmoblie/deepseek-harness-android/blob/dd720649085d86606f223d896844af847dc82c28/android/app/src/main/java/io/deepseekharness/mobile/MobileRuntimePlugin.kt)。

**拾文建议：** 优先验证 React + Capacitor 的本地打包界面。Kotlin 负责 Room/SQLite、同步调度、凭据、原生网络、分享入口和生命周期；页面、Markdown 展示、主题与交互尽可能共享。完整 Ubuntu/PRoot 环境不随这一界面选型进入拾文。

当前 `plugins/workbench/src/client.jsx` 内部仍直接 fetch `/api/shiwen`，并依赖 DSH 的 locale、workspace 和注册入口；`ReviewPage.jsx` 已通过参数接受 rpc。需将纯展示组件和平台接口拆开，Web 端使用原有 DSH adapter，Android 使用本地 repository bridge。不能把旧 snapshot RPC 作为同步接口，也不能直接把插件入口塞进 WebView 就声称离线可用。

拟定职责：

| 层 | 唯一职责与边界 |
| --- | --- |
| 共享 React 展示层 | 记录列表、编辑/预览、来源/日期、回顾、对话组件；不持有数据库连接或凭据 |
| Android 本地页面 | APK 内置资源，离线能打开；保存结果以本地事务回执为准 |
| 原生业务桥 | 有类型的 list/read/save/update/delete/restore/sync/agent 命令；不暴露任意 SQL、文件路径或 shell |
| 原生 Repository | 每库数据库、草稿、活动链、outbox 与同步唯一写入入口 |
| 网络与 Agent adapter | 按节点隔离登录与连接；按执行模式分别处理手机模型和远端 DSH |

桥接请求携带 requestId、不可变 libraryId 和页面/连接代次；原生根据已登记资料库解析实际路径，不信任页面提供的路径。写入返回本地保存回执；页面 Promise 超时不代表事务失败，重试使用同一操作身份，先查询结果。事件订阅返回初始快照/版本并支持销毁；WebView 重建重新读取数据库，不靠遗失的 JS Promise 恢复状态。正文分页传输，避免每次变化跨桥复制全库。

原生层持有所有资料同步调度：即使 WebView 消失，WorkManager 仍可使用同一 repository。React 不再另起一个 JS 同步引擎；浏览器端继续在线服务端模式，不自动获得手机的离线数据库能力。

## 3. 多节点身份与切换

**观察：** saya 的 `PairedDeviceStore` 保存稳定本地 key、origin、设备令牌和 installationId，修改名称与删除一条连接不等于修改服务端设备；写入使用加密存储。`SameHostSwitchPolicy` 根据安装身份匹配同一服务的不同通道，但不迁移通道凭据；gate 以 generation、前台状态和冷却时间限制过期回调与重复切换。

证据：[节点存储](https://github.com/saya-ch/dsh-mobile/blob/b829e50d6c86c96281c6fec379e2e6538e8fa0f4/apps/mobile/android/app/src/main/java/io/github/sayach/dshmobile/PairedDeviceStore.kt)、[同服务通道切换](https://github.com/saya-ch/dsh-mobile/blob/b829e50d6c86c96281c6fec379e2e6538e8fa0f4/apps/mobile/android/app/src/main/java/io/github/sayach/dshmobile/SameHostSwitchPolicy.kt)。

**拾文建议：** 保留既定 nodeId/serverId/libraryId 三层身份和密码认证，不照搬社区的配对协议。连接上下文额外包含 connectionGeneration；切换节点撤销旧观察订阅，旧回调不能更新新节点页面或写入新库。后台其他库可以独立同步，但各自持有固定 LibraryContext 和租约。

同一资料库的候选地址可以变更；每个 origin 单独重新认证并核对 serverId/libraryId。多个地址之间不自动搬运 Cookie。名称只改展示；移除连接与删除手机离线副本是两种操作，未同步内容按既定交互保护。

**需要额外处理的 Cookie 边界：** WebView 的 Cookie 并不天然按端口隔离。即使代码用精确 origin 作连接键，也不能据此宣称同域不同端口的网页 Cookie 已隔离。拾文优先让原生 HTTP 客户端按节点及精确 origin 管理凭据，JS 只收到状态；必须测试同一 IP 的两个服务端口、地址迁移和跨 origin 重定向。若需要打开远端网页，应放在不暴露本地业务桥的独立容器中，并明确它的会话范围。

## 4. Agent 运行与重连

**观察：** Soodok 使用独立 `EngineProcess` 启动引擎，`EngineSupervisor` 管理 Installing/Starting/Healthy/Backoff/Failed/Stopped 等状态，`EngineService` 显示前台通知并订阅实际状态。其 Gradle 明确设置 `targetSdk = 28` 来支持私有目录二进制执行，因此这套方案具有特定分发和平台约束，不能当成现代目标 SDK 下可直接采用的运行方案。

证据：[引擎进程](https://github.com/Soodok/Deepseek-Harness-Local-Android/blob/02e89ea7d9a6d211e38777c6a409f6cdf5dc0888/app/src/main/java/app/dsh/mobile/engine/EngineProcess.kt)、[引擎监督状态](https://github.com/Soodok/Deepseek-Harness-Local-Android/blob/02e89ea7d9a6d211e38777c6a409f6cdf5dc0888/app/src/main/java/app/dsh/mobile/engine/EngineSupervisor.kt)、[引擎服务](https://github.com/Soodok/Deepseek-Harness-Local-Android/blob/02e89ea7d9a6d211e38777c6a409f6cdf5dc0888/app/src/main/java/app/dsh/mobile/service/EngineService.kt)、[目标 SDK](https://github.com/Soodok/Deepseek-Harness-Local-Android/blob/02e89ea7d9a6d211e38777c6a409f6cdf5dc0888/app/build.gradle.kts)。

**拾文建议：** 借鉴“UI、任务控制、运行状态分离”，不把整套 DSH/Ubuntu 或社区应用作为默认依赖。手机 AI 与远端 DSH 使用独立 adapter；手机运行时仍需在 P0 对成熟 JS/JVM 方案核查工具调用、上下文、流式恢复、Android 兼容性与许可证。Capacitor 只解决界面和原生桥接，不提供 Node.js，也不自动具备 Agent 能力。选定运行时之前，不承诺既有 Node Skill/MCP 可在手机运行。

手机模型请求由原生任务控制层或经验证的运行时持有，并持久化轮次身份、已收到文本与工具回执；UI 只观察。若候选方案依赖 WebView JS 执行循环，必须明确后台暂停/进程被杀后只能恢复已落盘内容，不能自动重跑生成或工具写入。不能让 JS 和 Kotlin 各自运行一套同一轮 Agent 状态机。

**观察：** sorsama 的 `RemoteStreamMux` 对一个物理 WebSocket 复用多个逻辑流，将重连交给上层 ConnectionLoop；区分链路故障和业务错误。关闭订阅流不应被解释成已取消远端生成。其 `HarnessSession` 用启动 token 换 Cookie，是该客户端的认证流程，不适用于直接替换拾文已确认的密码登录。

证据：[流复用](https://github.com/sorsama/deepseek-harness-mobile/blob/ab68eb62be48fd90c7d89525762d6967661bd492/core/src/main/kotlin/com/labteto/dshmobile/core/wire/RemoteStreamMux.kt)、[会话交换](https://github.com/sorsama/deepseek-harness-mobile/blob/ab68eb62be48fd90c7d89525762d6967661bd492/core/src/main/kotlin/com/labteto/dshmobile/core/wire/HarnessSession.kt)。

**拾文建议：** 一个连接生命周期管理器负责重连，传输层不再嵌套重试；旧 generation 的事件不能混入新连接。断线先查询原 turn，再按持久事件序号补齐；新开逻辑流不是重发 prompt。取消观察和取消 Agent 是两条命令。普通同步回执仍不能充当模型请求完成证明。

## 5. 原生桥、键盘和后台

- **桥的信任边界。** saya 的策略核对 main frame 与精确 origin，并限制消息大小、重复 requestId 和在途请求数量。拾文只向 APK 内置可信页面开放资料/模型桥；远程页面和导入正文不获得这些权限。证据：[原生桥策略](https://github.com/saya-ch/dsh-mobile/blob/b829e50d6c86c96281c6fec379e2e6538e8fa0f4/apps/mobile/android/app/src/main/java/io/github/sayach/dshmobile/NativeBridgePolicy.kt)。
- **输入法与安全区。** saya 原生层消费系统栏、刘海与 IME Insets，避免网页重复补偿；dphmoblie 将 `captureInput` 保持 false，并记录中文输入法粘贴的兼容性原因。拾文明确原生和 CSS 各自的安全区职责，验证中文组合输入、粘贴、长按选择、软回车换行、横屏和手势返回；不仅检查截图。证据：[窗口 Insets](https://github.com/saya-ch/dsh-mobile/blob/b829e50d6c86c96281c6fec379e2e6538e8fa0f4/apps/mobile/android/app/src/main/java/io/github/sayach/dshmobile/WindowInsets.kt)、[Capacitor 配置](https://github.com/dphmoblie/deepseek-harness-android/blob/dd720649085d86606f223d896844af847dc82c28/capacitor.config.ts)。
- **后台连接不是持久同步。** sorsama 的 ConnectionService 按用户设置启用前台通知，实际 socket 由 ConnectionManager 持有；这不能证明关屏后永远在线。拾文同步继续采用每库唯一 WorkManager 作业、前台触发和手动同步共用一个引擎。长期模型任务是否需要前台服务，在目标 SDK 和实际任务类型下验证；默认不靠常驻通知、无障碍或自动拉起实现同步。证据：[连接前台服务](https://github.com/sorsama/deepseek-harness-mobile/blob/ab68eb62be48fd90c7d89525762d6967661bd492/app/src/main/java/com/labteto/dshmobile/connection/ConnectionService.kt)。
- **认证完成后再加载。** dphmoblie 用 HarnessPageLoadGate 防止异步 Cookie 回调重复打开页面，用应用/运行时版本区分页面入口缓存。拾文借鉴回调代次和缓存版本管理，但本地页面先启动并允许离线记录，不能把远端登录当成本地 UI 启动条件。证据：[页面会话门禁](https://github.com/dphmoblie/deepseek-harness-android/blob/dd720649085d86606f223d896844af847dc82c28/android/app/src/main/java/io/deepseekharness/mobile/HarnessPageSession.kt)。

## 6. 对现有计划的修订

1. 将“全 Kotlin/Compose UI”调整为“优先验证 React + Capacitor UI，Kotlin 承担原生业务能力”；Compose 保留为验证不通过时的可比较备选，不同时维护两套界面。
2. 保留 Room、原生同步、密码认证、来源/日期、服务回执、冲突规则和多库隔离；不因 UI 变化重做已确认协议。
3. 手机 Agent 运行时仍列为 P0 决策，不等同于 UI 选型。社区证明了多条技术路线存在，没有证明任何一条已经满足拾文全部需求。
4. 先提取可复用界面和平台接口，再做最小技术探针；不 fork 社区应用、不安装社区 APK 作为本轮交付。

P0 退出条件增加：

- 本地打包页面在飞行模式冷启动可读写；事务回执丢失后重试不重复，杀进程后正文/outbox 完整。
- 手动与后台同步均不依赖活动 WebView；共用事务、租约、回执对账。
- 两个同 IP 不同端口服务不串 Cookie；切节点时晚到的消息、模型结果和保存回执只归原库。
- 模型 Key 不通过普通 JS 状态/日志/数据库同步返回；桥拒绝远程来源、失效上下文和重复请求。
- 当前 Markdown 长文、键盘、主题/语言、回顾组件可复用；同一组件的桌面 Web 行为无回归。
- 成熟手机 Agent 候选完成流式、工具调用、取消、重启恢复验证；无法满足时先记录差距，不扩大为自研完整 Harness。
- 记录 APK/安装空间、内存、打开本地记录耗时、后台行为和依赖版本；不能用社区宣传数字替代实测。

未验证：上述候选在拾文上的构建、性能、真机和协议兼容。本轮没有运行社区测试，也未新增 Android 工程。

## 7. 框架依据

- [Capacitor Plugins](https://capacitorjs.com/docs/plugins)：JS 通过插件调用原生能力，原生实现仍需维护。
- [Capacitor 配置](https://capacitorjs.com/docs/config)：webDir 指向打包前端；Android 工程路径可配置，不能把远端 server.url 当作离线资源打包。
- [Android 持久任务定义](https://developer.android.com/develop/background-work/background-tasks/persistent/getting-started/define-work)：WorkManager 调度受系统约束，不代表实时保活。
