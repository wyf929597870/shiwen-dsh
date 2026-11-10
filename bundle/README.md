# 拾文 DSH 插件 / Shiwen DSH plugin

为原生 DSH Web 提供素材、日记、文章、回顾和 Agent 工具。预构建包不依赖拾文 Electron 外壳，不需要编译安装脚本。

Requires **DSH 0.2.2-alpha.3** and **Node.js >=24.9**. Version 0.2.0-dev.5 is a preview build, not a stable release. Windows/macOS desktop hosts have not yet been validated.

**本次更新：** 与桌面 v0.1.14 共用工作台，新增独立读书笔记、多段原文摘录与回顾日目标趋势，兼容旧打勾记录；MCP、Agent 工具和配套 Skill 同步更新；主题与皮皮仍可选。插件包版本为 0.2.0-dev.5。

**This update:** shares the desktop v0.1.14 workspace, adding dedicated reading notes, multiple excerpts and daily-goal trends with legacy checkmark support, plus matching MCP, Agent tools and Skill updates. Theme and Pipi remain optional. Bundle version is 0.2.0-dev.5.

本版加入 Android 同步、人设与远端会话/管理接口。原生 DSH 宿主仍负责认证；Android 密码登录请使用拾文独立服务或桌面安装包，插件包本身不安装密码认证层。

This version adds Android sync, profile and remote-session/management endpoints. Authentication remains owned by stock DSH; use the Shiwen standalone service or desktop package for Android password login. The tarball does not install that authentication layer.

在已有 Web profile 中安装本 tgz（尚未初始化时先执行 `dsh web --help`）：

```sh
dsh plugin --profile web add ./dsh-shiwen-0.2.0-dev.5.tgz --ignore-scripts
dsh web --no-open
```

先用原生 DSH 初始化 Web profile。安装后侧栏会增加素材、创作、回顾和外部接入等功能，原生对话和模型配置由 DSH 提供。

Install the tarball into an initialized Web profile, then restart DSH. The host supplies conversations and model settings. The bundle adds library, writing, review and external-access panels.

默认资料存于 `$DSH_HOME/shiwen/<profile>/library/library.sqlite`（DSH_HOME 默认 `~/.dsh`），按 profile 隔离。可在用户 profile 的 `cordis.patch.yml` 设置：

```yaml
- id: shiwen-library
  config:
    dataDir: /absolute/path/to/library
```

保留兼容旧拾文桌面的 `SHIWEN_DATA_DIR`，显式 `dataDir` 优先。卸载插件保留资料；重装相同 profile 可继续读取。不要让多个 DSH 实例同时打开同一个资料目录。

Data is stored on the DSH host, not in browser storage. Different profiles have separate libraries. Removing the bundle does not delete data. Avoid concurrently opening one library from multiple hosts. A cloud model receives the relevant context sent to it.

## 可选主题和皮皮 / Optional appearance and persona

默认保留 DSH 的主题和角色。将本包 `appearance.patch.yml` 中需要的行复制到用户 profile 的 `cordis.patch.yml`，可启用拾文品牌、主题和皮皮；移除这些自定义行即可恢复宿主默认行为。主题和个人上下文可单独启停。

The theme and Pipi are opt-in. Copy selected rows from `appearance.patch.yml` into your profile patch. Remove these custom rows before uninstalling the bundle. Existing model credentials and presets are not overwritten.

## 外部 Agent / External agents

共用桌面资料：在桌面端「外部接入 → 浏览器访问」复制本机登录地址。浏览器连接同一个 DSH Host，无需重复导入；保持桌面端运行，重启后重新复制。独立启动的 Web profile 仍然隔离，未保存草稿也不跨窗口同步。此入口从 `0.2.0-dev.1` 提供，仅限本机访问。插件包不安装拾文独立服务；需要服务生命周期管理和密码登录时，使用拾文桌面包或源码中的独立服务。

To share desktop data, copy the local browser login URL from **External access → Browser access** in the desktop app. Keep the app running; copy a fresh URL after restarting. Separate Web profiles and unsaved drafts remain independent. Available since `0.2.0-dev.1` for same-computer access. The plugin does not install the Shiwen standalone service; use the desktop package or source service for lifecycle management and password login.

在外部接入页创建凭据并复制 MCP JSON。命令、参数和资料路径根据宿主生成，接口仍只监听宿主的回环地址。远程浏览器看到的路径属于 DSH 服务所在电脑；MCP 配置应在那台电脑使用。旧资料导入也是读取宿主文件路径。

External access remains loopback-only. Generated MCP commands and legacy-import paths belong to the DSH host, not a remote browser's computer.

## 卸载 / Remove

先撤下自行添加的主题/角色配置，再执行：

```sh
dsh plugin --profile web remove dsh-shiwen
```

重启 DSH 后移除拾文功能，保留库文件。已保存的个人资料不会随 npm 包删除。

[源码与说明 / Source and docs](https://github.com/wyf929597870/shiwen-dsh)
