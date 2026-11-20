# 系统架构图

README 的中英文架构图，按当前独立服务架构绘制。

- `architecture.zh.svg` / `architecture.en.svg`：可编辑矢量源文件，无外部字体或网络依赖。
- `architecture.zh@2x.png` / `architecture.en@2x.png`：2880 × 2120 PNG，用于预览和分享。
- 上半部分展示运行与存储边界；跨区域连线表示客户端与服务的交互，区域内部表示主要调用和持久化关系。
- 下半部分单独展示模型与外部 Agent 接入，不把它们混入部署连线。
- 青色为界面，绿色为服务，紫色为存储，黄色为用户配置的模型服务。

服务端认证与启动参见 `scripts/server-worker.mjs`、`integration/`；业务接口参见 `plugins/workbench/src/index.mjs` 与 `plugins/mobile/`；Android 持久化与同步参见 `android/native/`。这里只表达主要组件关系，不是完整调用图或网络协议时序。

桌面与 Web 共用服务端资料库；Android 拥有独立本地库并依赖协调服务同步。独立插件安装到原生 DSH 时使用宿主认证，不自带拾文独立服务的密码层。
