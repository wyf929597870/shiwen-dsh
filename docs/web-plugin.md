# Web 与插件使用 / Web and plugin usage

拾文现在可作为预构建的 `dsh-shiwen` 组合包安装在 **原生 DSH Web** 中。同一套业务代码仍供已有 Linux 桌面端使用；无需下载、编译或修改 DSH 上游源码来运行 Web 版。

当前目标版本为 **DSH 0.2.2-alpha.3 / Node.js >=24.9**。组合包版本 `0.2.0-dev.1` 通过 [GitHub Release](https://github.com/wyf929597870/shiwen-dsh/releases/tag/v0.2.0-dev.1) 提供预构建 tgz，尚未发布到 npm。现有 `v0.1.5` Release 仍是 Linux 桌面安装包。

## 在本仓库启动 / Run from this repository

在仓库根目录运行：

```sh
npm ci
npm run start:web -- --no-open
```

打开终端打印的带登录票据的地址。默认只监听 `127.0.0.1:3080`；不需要 Electron 或 `upstream/`。默认使用独立的 `shiwen-web` profile，不改已有 `web` 或 `desktop` profile。首启启用拾文外观与皮皮；可用 `--no-theme --no-persona` 在首次创建时保留宿主默认外观及角色。之后以 profile 中的用户配置为准，重复启动不会覆盖。

测试或试用时可以选择独立 DSH_HOME：

```sh
DSH_HOME=/tmp/shiwen-web-demo npm run start:web -- --no-open --port 3081
```

已有桌面版资料不会自动移动或导入。开发启动器会重建 `dist/dsh-shiwen`，运行时不要并行打包或重建同一目录。

## 安装到已有 DSH / Install into stock DSH

从 [Release](https://github.com/wyf929597870/shiwen-dsh/releases/tag/v0.2.0-dev.1) 下载 tgz 和 SHA256 校验文件即可安装，不需要源码。也可以自行构建 tarball：

```sh
npm ci
npm run package:plugin
```

产物为 `release/dsh-shiwen-0.2.0-dev.1.tgz`。将它复制到运行 DSH 的电脑，使用匹配版本的 DSH CLI：

```sh
# 初始化内置 Web profile；若已经有 Web profile，可跳过这一行。
dsh web --help
# 在 tgz 所在目录运行；需要下载普通 npm 依赖，不需要安装构建脚本。
dsh plugin --profile web add ./dsh-shiwen-0.2.0-dev.1.tgz --ignore-scripts
dsh web --no-open
```

核心组合包默认保留 DSH 的品牌、主题、默认 Agent 和模型配置，只增加拾文业务功能。启用品牌与皮皮等可选项，见 [组合包说明](../bundle/README.md)。现阶段请安装预构建 tgz，**不是**直接安装 GitHub checkout；源码目录 `bundle/` 是打包配方，运行资源由构建脚本收集。

## 共用桌面后端 / Share the desktop Host

从 `v0.1.5` 桌面包 / `v0.2.0-dev.1` 插件包提供。这两个已发布版本仅支持同一台电脑上的浏览器访问；源码新增的局域网独立服务见 [独立服务说明](server.md)。

1. 启动装有新版拾文插件的桌面端，打开「外部接入」。
2. 在「浏览器访问 · 共用当前资料」核对资料库位置，点击「复制浏览器登录地址」。
3. 在同一台电脑的浏览器打开地址。浏览器和桌面使用同一个 Host，资料、会话和服务端设置不需要复制或同步。

桌面 Host 原生提供已鉴权的 HTTP 入口；拾文仅展示这个入口，不增加第二个数据库连接或自建认证系统。普通状态请求不返回登录票据，只有点击复制时才获取。地址包含完整 DSH 访问凭据，请只用于自己的本机浏览器。非回环部署不生成此入口，使用部署时配置的 Web 地址。

另一端保存后，重新进入素材页或点击「刷新」读取列表；重新打开记录读取正文。未保存草稿不跨窗口同步，旧版本修改会被拒绝。桌面端退出后服务停止，重启后重新复制登录地址。

独立 `web` / `shiwen-web` 与 `desktop` profile 不会自动连接或合并。需要共享时，从桌面端获取浏览器入口；不要把两个运行中的 Host 配到同一个 SQLite 文件。此方案也不提供官方桌面端连接任意远程 Web 后端的设置。

From **External access → Browser access** in the desktop app, copy the login URL into a browser on the same computer. One desktop Host owns the data and serves both clients, including native DSH conversations. Keep it running and copy a fresh URL after restart. Refresh/reopen records to see changes; drafts remain in each window and stale writes are rejected. Independent Web profiles remain separate. Non-loopback deployments should use their configured Web URL. Available since desktop `v0.1.5` / plugin `v0.2.0-dev.1`; those published versions provide same-computer access. Source now also offers a [standalone LAN service](server.md) using existing desktop data.

Verification: after `npm run build`, run `node scripts/check-shared-host.mjs [path/to/linux-unpacked/resources]`. This launches the actual packaged Desktop Host through IPC with current source plugins and temporary data, then checks two authenticated HTTP clients, shared writes, conflicts, delete/restore, restart persistence and expired launch tokens. It does not automate Electron or browser UI clicks.

## 数据、路径和宿主 / Data and host boundaries

- Web 插件默认资料：`$DSH_HOME/shiwen/<profile>/library/library.sqlite`；没有指定 DSH_HOME 时为 `~/.dsh`。
- 数据保存在 DSH 服务所在电脑，不在浏览器 localStorage；远程浏览器和另一台电脑不会因此自动同步资料。
- `shiwen-library.config.dataDir` 可以指定资料库目录，优先于兼容旧桌面的 `SHIWEN_DATA_DIR`。
- 同一时刻只由一个宿主打开同一资料目录。跨 profile 默认隔离；不要通过复制运行中的 SQLite 文件迁移资料。
- 外部 MCP/HTTP 服务只监听 DSH 宿主回环地址，生成的命令、Skill 与旧库导入路径都属于宿主电脑。远程客户端不能直接运行这些本机路径。
- Web 入口保留原生 DSH 的登录票据与来源校验；本次只验收本机浏览器使用，不提供公网多用户托管。
- 插件停用/卸载不删除资料、模型配置或原生会话。自行加入的主题/皮皮 patch 行须先移除，再用 `dsh plugin --profile web remove dsh-shiwen` 卸载并重启。

## 验收 / Verification

```sh
npm test
npm run package:plugin
node scripts/check-web-plugin.mjs
```

集成验收使用全新的临时 DSH_HOME，实际执行 DSH 插件安装、原生 Web 启动、登录与来源校验、资料读写/排序、MCP、主题可选加载、重启持久化、卸载与重装保留资料。需要本机回环和 npm 依赖下载，不调用真实模型。

当前验证范围是 Linux 上的原生 Web 宿主。浏览器视觉与完整点击流程尚未完成验证；官方 Windows/macOS 桌面宿主、远程部署和真实模型对话也不在已验证范围内。

## English

The prebuilt `dsh-shiwen` bundle runs in stock **DSH 0.2.2-alpha.3**, using Node.js >=24.9. Run `npm ci` and `npm run start:web -- --no-open` from this repository, then open the login URL printed by DSH. This uses a dedicated `shiwen-web` profile and needs neither Electron nor an upstream checkout. Existing preferences are preserved. `--no-theme --no-persona` controls first-creation defaults only.

For an existing DSH installation, run `npm run package:plugin`, transfer the generated `.tgz`, initialize the Web profile with `dsh web --help` if needed, and use the installation commands above. The tarball includes built plugin modules and assets; ordinary npm dependencies are installed without build scripts. Direct Git checkout installation is not supported yet.

The default bundle preserves the host's theme and agent settings. Optional Shiwen appearance and Pipi are documented in [the bundle README](../bundle/README.md). Data defaults to `$DSH_HOME/shiwen/<profile>/library`, on the host computer. Profiles are isolated, and removal keeps library data. The old Shiwen desktop data location remains compatible and is not automatically migrated. Only one host should open a library at a time.

The MCP configuration and legacy-import paths refer to the host, not a remote browser. External access remains loopback-only; stock Web authentication is retained. This is not a multi-user cloud service.

`node scripts/check-web-plugin.mjs` checks real installation, Web authentication, record operations, dates, MCP, optional theme loading, restart persistence, removal and reinstallation using temporary data. Linux Web is the current verification target; browser interaction/visual checks, official Windows/macOS desktop hosts, remote deployments and real-model flows remain unverified. `0.2.0-dev.1` is a [GitHub pre-release](https://github.com/wyf929597870/shiwen-dsh/releases/tag/v0.2.0-dev.1), not an npm package; the published `v0.1.5` remains the Linux desktop preview.
