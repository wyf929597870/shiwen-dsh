# 更新记录 / Changelog

0.1.4 是本仓库首次公开的 Linux 预览版；0.1.0–0.1.3 为本地开发与打包记录。
0.1.4 is this repository's first public Linux preview; 0.1.0–0.1.3 are local development builds.

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
