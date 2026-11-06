# 更新记录 / Changelog

0.1.4 是本仓库首次公开的 Linux 预览版；0.1.0–0.1.3 为本地开发与打包记录。
0.1.4 is this repository's first public Linux preview; 0.1.0–0.1.3 are local development builds.

## 0.1.6 - 本地构建 / Local build (not published)

- 独立服务支持密码登录、30 天记住设备、密码修改、设备撤销和退出登录；撤销同步断开实时连接。首次密码仅由本机管理入口设置，远端使用普通服务地址。
- Standalone password login, remembered devices, password rotation, device revocation and sign-out; revocation closes live connections. First setup uses local administration, while remote devices use clean URLs.

- 素材与创作使用可收起的窄列表，仅显示标题与日期，搜索和筛选置顶；旧资料导入入口移至设置。
- Materials and Writing use collapsible narrow lists with titles, dates and search at the top; legacy import moves to Settings.
- PC 安装包包含独立服务和 Node；桌面端支持本机自动启动/复用、远端连接与连接设置。
- 本机退出提供保留服务、停止服务和取消；远端退出不会停止远端服务。
- 远端地址与已认证本机服务匹配时自动按本机管理；其他端口或无法核实的目标不会被接管。
- 局域网服务复用桌面资料，浏览器认证保留；增加进程占用锁、认证控制接口和启停命令。
- 记录移动端离线资料、独立 AI 和同步方案，移动端尚未实施。

The desktop package bundles a Node service, supports local auto-start/reuse and remote connections, and offers local keep/stop/cancel exit behavior. LAN Web sharing retains authentication and ownership checks. The mobile offline/AI/sync design is documented only.

## 0.2.0-dev.1 - 2026-11-06

### 中文

DSH 独立插件预览版，要求 **DSH 0.2.2-alpha.3 / Node.js >=24.9**。

- 新增「外部接入 → 浏览器访问」，显示当前资料位置和 profile，并复制当前 Host 的本机浏览器登录地址。
- 只有浏览器会话可以获取登录地址；拒绝临时 API Peer 换取浏览器凭据。
- 在原生 Web 的安装、重启、卸载重装测试中增加新入口与身份限制验证。

本次只提供**本机访问**入口，局域网和独立后端服务尚未实现；不同 profile 的资料仍然隔离。Linux 桌面用户可使用同批发布的 [v0.1.5](https://github.com/wyf929597870/shiwen-dsh/releases/tag/v0.1.5)。

下载 `.tgz` 和 `SHA256SUMS-0.2.0-dev.1.txt`，停止目标 DSH Web 实例后运行：

```sh
sha256sum -c SHA256SUMS-0.2.0-dev.1.txt
# 首次使用时初始化 Web profile；已有则跳过。
dsh web --help
dsh plugin --profile web add ./dsh-shiwen-0.2.0-dev.1.tgz --ignore-scripts
dsh web --no-open
```

主题与皮皮继续可选；数据、模型配置不自动迁移。本包未发布到 npm。已验证 Linux 原生 Web 下的安装、鉴权、资料读写、MCP、主题、持久化与卸载重装；浏览器视觉/完整点击流程、官方 Windows/macOS 宿主及真实模型调用仍未验收。

### English

Standalone plugin preview for **DSH 0.2.2-alpha.3 / Node.js >=24.9**.

- Add **External access → Browser access**, showing the library/profile and copying this Host's local browser login URL.
- Restrict login URL issuance to browser sessions; temporary API Peers cannot exchange their credentials for browser access.
- Extend stock Web installation/restart/removal tests with the new endpoint and identity restrictions.

This release provides **same-computer access only**. LAN access and a separate backend service are not implemented; profiles remain isolated. Linux desktop users can install [v0.1.5](https://github.com/wyf929597870/shiwen-dsh/releases/tag/v0.1.5).

Download the tarball and checksum file, stop the target DSH Web instance, and run the commands above. Appearance/Pipi remain optional; no automatic data or model-configuration migration. Not published to npm. Verified on Linux stock Web: installation, authentication, records, MCP, appearance, persistence and removal/reinstallation. Browser visuals/full clicks, official Windows/macOS hosts and real-model calls remain unverified.

## 0.1.5 - 2026-11-06

### 中文

Linux x64 预览版。新增「外部接入 → 浏览器访问」，在同一台电脑的浏览器访问桌面端正在运行的 DSH 后端，共用已保存的资料和原生会话。

- 显示当前资料库、profile 和本机地址，支持复制完整登录地址及手动复制回退。
- 登录地址仅向浏览器会话开放；临时 API Peer 无法换取浏览器凭据。
- 保留现有版本冲突检查，防止旧草稿覆盖另一端的新修改。
- 同步更新中英文使用说明和隔离验收脚本。

**范围**：仅本机浏览器访问。保持桌面端运行；重启后重新复制登录地址。局域网访问、独立后端服务、手机本地资料库和离线同步尚未实现。独立 Web profile 不会自动合并资料，未保存草稿不跨端同步。

下载 `.deb` 与 `SHA256SUMS-0.1.5.txt` 到同一目录，完整退出拾文后运行：

```sh
sha256sum -c SHA256SUMS-0.1.5.txt
sudo apt install ./shiwen-dsh_0.1.5_amd64.deb
```

**验证**：35 项自动测试；实际打包 Desktop Host 的登录、API Peer 拒绝、双客户端读写、冲突、删除恢复和重启持久化；原生 Web 插件安装与生命周期检查。此次新增面板的实际浏览器点击、视觉验收、全新机器系统级安装、Windows/macOS 和真实模型调用尚未完成验证。安装包不包含个人资料或凭据。

### English

Linux x64 preview. **External access → Browser access** connects a browser on the same computer to the running desktop DSH Host, sharing saved records and native conversations.

- Display the current library, profile and local address; copy the full login URL with a manual-copy fallback.
- Issue browser login URLs only to browser sessions; temporary API Peers are refused.
- Preserve revision checks against stale edits and update bilingual usage/verification docs.

**Scope**: same-computer access only. Keep the desktop app running and copy a new login URL after restart. LAN access, an independent backend service, mobile local storage and offline synchronization are not implemented. Separate Web profiles are not merged; unsaved drafts are not synchronized.

Download the `.deb` and `SHA256SUMS-0.1.5.txt`, fully quit Shiwen, then run the commands above. Verified: 35 automated tests, the packaged Desktop Host with two HTTP clients, authentication/API Peer denial, shared writes, conflicts, delete/restore and restart persistence, plus stock Web plugin lifecycle checks. New panel browser clicks/visuals, fresh-machine system installation, Windows/macOS and real-model calls remain unverified. No personal data or credentials are bundled.

## 0.2.0-dev.0 - 2026-11-06

### 中文

**拾文独立插件预览版**，安装进原生 DSH Web。需要 **DSH 0.2.2-alpha.3、Node.js >=24.9** 和 pnpm；宿主需提供可用的 DSH CLI 插件管理命令。

- 预构建组合包包含资料库、Agent 工具、素材/创作/回顾界面，以及 MCP/HTTP/CLI 和 Skill。
- 保留 DSH 原生对话、模型配置和登录鉴权；不需要拾文 Electron 外壳或桌面补丁。
- 默认按 profile 隔离资料；卸载插件保留数据，重装后可继续使用。
- 拾文主题与皮皮人设为可选项，默认保留原生 DSH 外观与角色。

下载本页的 `.tgz` 和 `SHA256SUMS-0.2.0-dev.0.txt` 到同一目录，在终端执行：

```sh
sha256sum -c SHA256SUMS-0.2.0-dev.0.txt
# 首次使用时初始化原生 Web profile，已有则跳过。
dsh web --help
# 先停止正在运行的目标 DSH Web 实例，再安装并重启。
dsh plugin --profile web add ./dsh-shiwen-0.2.0-dev.0.tgz --ignore-scripts
dsh web --no-open
```

打开终端打印的登录地址。安装需要下载普通 npm 依赖，不会运行插件构建脚本；本包不附带模型账号、API Key 或个人资料。默认资料目录为 `$DSH_HOME/shiwen/web/library`，DSH_HOME 默认 `~/.dsh`。已有拾文桌面资料不会自动迁移。

**验收范围**：Linux 原生 Web 下的安装、登录/来源校验、资料读写/日期排序、MCP、主题可选加载、重启、卸载重装及数据保留。浏览器视觉与完整点击流程、官方 Windows/macOS 桌面宿主及真实模型对话仍未完成验收。本次不提供新的桌面安装包；Linux 桌面用户仍可使用 v0.1.4。

[完整安装与数据说明](https://github.com/wyf929597870/shiwen-dsh/blob/v0.2.0-dev.0/docs/web-plugin.md) · [主题、皮皮及卸载配置](https://github.com/wyf929597870/shiwen-dsh/blob/v0.2.0-dev.0/bundle/README.md)

### English

The first **standalone Shiwen plugin preview** for stock DSH Web. Requires **DSH 0.2.2-alpha.3, Node.js >=24.9** and pnpm, with a working DSH CLI plugin manager.

- Prebuilt library, agent tools, material/writing/review panels, MCP/HTTP/CLI integration and companion Skill.
- Native DSH conversations, model settings and Web authentication; no Shiwen Electron shell or desktop patch required.
- Profile-scoped default storage, retained through plugin removal and reinstallation.
- Optional Shiwen appearance and Pipi persona; the default bundle preserves host branding and agent preferences.

Download the `.tgz` and `SHA256SUMS-0.2.0-dev.0.txt` into one directory, then run:

```sh
sha256sum -c SHA256SUMS-0.2.0-dev.0.txt
# Initialize the Web profile if needed.
dsh web --help
# Stop the target DSH Web instance before installing, then restart it.
dsh plugin --profile web add ./dsh-shiwen-0.2.0-dev.0.tgz --ignore-scripts
dsh web --no-open
```

Open the login URL printed by DSH. Installation downloads ordinary npm dependencies but needs no plugin build scripts. No model account, API key or personal data is bundled. Data defaults to `$DSH_HOME/shiwen/web/library`, with DSH_HOME defaulting to `~/.dsh`; existing Shiwen desktop data is not automatically migrated.

**Verified on Linux Web**: installation, login/origin checks, records/date ordering, MCP, optional theme loading, restart persistence, removal and reinstallation. Browser visual/full interaction checks, official Windows/macOS desktop hosts and real-model conversations remain unverified. No new desktop installer is included; v0.1.4 remains available for Linux desktop users.

[Installation and storage guide](https://github.com/wyf929597870/shiwen-dsh/blob/v0.2.0-dev.0/docs/web-plugin.md) · [Appearance, persona and removal](https://github.com/wyf929597870/shiwen-dsh/blob/v0.2.0-dev.0/bundle/README.md)

## 0.1.4 - 2026-11-06

### 中文

首次公开发布拾文 DSH 的 **Linux x64 预览版**，适合体验和反馈，尚非稳定版。Windows 暂不发布。

- 基于 DSH 原生对话的桌面工作台，集成资料库、日记、想法、文章创作和日期回顾。
- Agent 可检索、阅读、保存和修改资料的正文、类型、作者来源及日期；支持删除和恢复。
- 提供 MCP、HTTP API、CLI 和配套 Skill，外部 Agent 可使用分项授权、可撤销的本机凭据接入；写入支持重试去重。
- 保存渠道与作者来源分离；由 Agent 代存的个人书写不必标为 AI 内容。
- 列表和查询统一按内容日期倒序，同日按创建时间倒序，未知日期置底。
- 提供中英文文档、固定上游版本与补丁准备脚本、源码提交检查。

**安装与校验**：下载本页的 `.deb` 和 `SHA256SUMS-0.1.4.txt` 到同一目录，完整退出拾文后运行：

```bash
sha256sum -c SHA256SUMS-0.1.4.txt
sudo apt install ./shiwen-dsh_0.1.4_amd64.deb
```

从应用菜单打开「拾文」，或运行 `shiwen-dsh`。安装包包含 Electron、Node、DSH 和拾文插件，不包含个人资料、会话或 API Key。AI 对话需自行配置模型与凭据。

**验证与限制**：在 Ubuntu 26.04 x64 上验证解包后的真实桌面程序、隔离资料读写/删除恢复、重启持久化、从 0.1.3 数据启动以及外部 MCP 接入。全新机器上的系统级安装/升级、其他发行版和真实付费模型端到端流程尚未验证。当前没有自动更新，也暂不提供可在原生 DSH 中独立安装的插件组合包。

资料库默认存于 `${XDG_DATA_HOME:-~/.local/share}/shiwen-dsh`，重装不会自动清除资料。使用云端模型时，对话与参与请求的相关资料仍会发送给所配置的服务商。

### English

The first public **Linux x64 preview** of Shiwen DSH, intended for evaluation and feedback rather than a stable release. Windows builds are deferred.

- A desktop workspace built around native DSH conversations, with a library, journals, ideas, article drafting and date-based reviews.
- Agent tools to search, read, save and edit records, including content, type, authorship and dates, plus deletion and restoration.
- MCP, HTTP API, CLI and a companion Skill for external agents, with scoped/revocable local credentials and deduplicated write retries.
- Client provenance is separate from authorship: having an agent save your writing does not make it AI-authored.
- Consistent descending content-date order, then creation time within each day, with unknown dates last.
- Bilingual documentation, pinned upstream setup and patches, and a source publication audit.

**Install and verify**: download the `.deb` and `SHA256SUMS-0.1.4.txt` from this release into the same directory. Fully quit Shiwen, then run:

```bash
sha256sum -c SHA256SUMS-0.1.4.txt
sudo apt install ./shiwen-dsh_0.1.4_amd64.deb
```

Open 拾文 from the application menu or run `shiwen-dsh`. Electron, Node, DSH and the Shiwen plugins are bundled; personal data, sessions and API keys are not. Configure your own model and credentials for AI conversations.

**Validation and limitations**: the extracted desktop application was checked on Ubuntu 26.04 x64 using isolated data, including record operations, deletion/restoration, restart persistence, opening data from 0.1.3 and external MCP access. System-level installation/upgrades on a fresh machine, other distributions and paid-model end-to-end flows remain unverified. Automatic updates and an independently installable stock-DSH plugin bundle are not available yet.

The default data root is `${XDG_DATA_HOME:-~/.local/share}/shiwen-dsh`; reinstalling does not automatically erase it. Cloud models still receive conversations and relevant material included in requests.

## 0.1.3

- 外部接入界面、分项权限与可撤销凭据；提供 MCP、HTTP、CLI 和配套 Skill。
- External access with scoped/revocable credentials, MCP, HTTP, CLI and companion Skill.
- 保存渠道与作者分离，写入支持重试去重。
- Separate client provenance from authorship and deduplicate write retries.

## 0.1.2

- 扩展内部 Agent 的资料修改与来源工具。
- Extend internal agent tools for record updates and attribution.

## 0.1.1

- 素材删除及撤销恢复。
- Record deletion and restoration.

## 0.1.0

- 基于 DSH 的 Linux 桌面集成与拾文核心插件。
- Initial Linux desktop integration and core Shiwen plugins on DSH.
