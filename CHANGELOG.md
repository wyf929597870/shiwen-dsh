# 更新记录 / Changelog

0.1.4 是本仓库首次公开的 Linux 预览版；0.1.0–0.1.3 为本地开发与打包记录。
0.1.4 is this repository's first public Linux preview; 0.1.0–0.1.3 are local development builds.

## android-v0.1.26 - 2026-11-12

### 中文

- 精简手机导航，优化会话、素材列表、类型选择和设置页面；支持从对话内容保存素材。
- 改进资料库同步冲突的比较、自动读取和处理入口，区分主动放弃的旧修改与未完成写入。
- 新建日记时显示追加说明，会话保存原文支持全部七种素材类型。
- Android versionCode 29，沿用既有发行签名。

### English

- Streamline Android navigation and improve chat, material lists, type selection, and settings; save conversation content as material.
- Improve sync conflict comparison and discovery, and distinguish discarded conflict branches from unresolved writes.
- Show journal append guidance inline and support all seven material types when saving chat input.
- Android versionCode 29, signed with the existing release key.

## android-v0.1.11 - 2026-11-12

### 中文

- 精简手机主导航为对话和素材，保留资料库连接、同步与旧草稿处理入口。
- 直接记录和素材编辑支持选择类型，保留文章关联与读书笔记来源；同日日记追加和类型冲突有明确提示。
- 手机助手使用服务端同步的人格与记忆；移除手机本地管理工具，应用标识旁显示实际安装版本。
- Android versionCode 14，沿用既有发行签名。

### English

- Simplify Android navigation to chat and materials while retaining library synchronization and legacy draft recovery.
- Support record types in quick capture and editing, preserving article links and reading-note sources.
- Use the selected server's assistant profile and display the installed app version beside the logo.
- Android versionCode 14, signed with the existing release key.

## android-v0.1.10 - 2026-11-11

### 中文

- 手机对话页的会话下拉改为底部会话列表：本地「手机助手」会话可直接删除（连同该会话的对话记录与草稿，不可恢复）；「服务器助手」会话可归档与恢复，归档后从列表移除，服务器数据保留，与电脑端右键菜单的归档语义一致。
- 两处会话列表都支持「显示已归档」筛选；运行中和只读会话的移除入口置灰并说明原因。
- 对话输入框可收起，收起后消息区占满；展开/收起状态本机记忆。
- 修正输入框固定占五行导致消息区被挤压、以及键盘弹起时整页滚动的问题。
- Android versionCode 13，沿用既有发行签名。

### English

- Replace the phone conversation dropdown with a bottom session list. Phone-agent conversations can be deleted with their turns and draft (not recoverable); server conversations can be archived and restored, leaving the server data intact and matching the desktop right-click archive.
- Both lists offer a "show archived" filter; running and read-only rows keep their action disabled with the reason shown.
- The chat input can be collapsed so the message list fills the screen, and the choice is remembered on the device.
- Fix the five-line input squeezing the message list and the whole page scrolling when the keyboard opens.
- Android versionCode 13, signed with the existing release key.

## v0.1.17 - 2026-11-11

### 中文

- 手机远程会话接口 `mobileSessions` 新增 `archive` 与 `unarchive`，转发到 DSH 工作区注册表的归档集合；`list` 结果一并返回 `archivedSessionIds`，供手机端过滤已归档会话。
- 归档与电脑端右键菜单共用同一份归档集合，两端状态一致；归档保留服务器数据，可随时取消归档。
- 缺少工作区注册表时返回 `SESSIONS_UNAVAILABLE`，归档被拒时返回 `SESSION_CONFLICT`，手机端可按明确结果提示。

### English

- Add `archive` and `unarchive` to the phone `mobileSessions` action set, forwarded to the DSH workspace registry archive set; `list` now returns `archivedSessionIds` so the phone can filter archived conversations.
- Archiving shares the archive set with the desktop right-click menu, so both clients agree; server data is preserved and can be unarchived at any time.
- Return `SESSIONS_UNAVAILABLE` when the workspace registry is missing and `SESSION_CONFLICT` when the host refuses an archive, so the phone can report a definite result.

## android-v0.1.9 - 2026-11-10

### 中文

- 修复手机助手待确认保存建议超出屏幕后无法找到操作按钮的问题：建议随对话滚动，确认与拒绝放在正文预览之前。
- 手机与服务器会话输入框默认至少显示 5 行；小屏可滚动访问输入和保存回执。
- 素材与创作详情的操作栏吸附顶部，编辑、保存、插入图片和更多操作随滚动保持可用；正文编辑区扩大到至少 360 像素。
- Android versionCode 12，沿用既有发行签名。

### English

- Keep phone-agent save proposals inside the scrollable conversation and place decisions before body previews so long proposals cannot hide their buttons.
- Show at least five lines in phone and server chat inputs; allow scrolling on short screens.
- Keep material and article actions at the top while scrolling, including edit, save, insert image and more; enlarge the body editor to at least 360 pixels.
- Android versionCode 12, signed with the existing release key.

## v0.1.16 - 2026-11-10

### 中文

- 素材页增加常驻“已删除”列表，可在重新打开应用后恢复记录；恢复保留正文、日期、版本和同步信息。同一天已存在另一篇日记时会提示冲突，避免覆盖。

### English

- Add a persistent deleted-records list to Materials so records can be restored after reopening the app. Restore preserves content, dates, versions and sync history, and checks for conflicting same-day journals.

## v0.1.15 - 2026-11-10

### 中文

- Linux 安装包版本升至 0.1.15，让已安装本地 0.1.14 的用户可以通过 apt 正常升级；包含读书笔记、回顾日目标、MCP/Skill 更新与选书框中文裁切修复。
- Android 继续为 0.1.8，DSH 插件继续为 0.2.0-dev.5。升级前保存编辑并停止旧服务，安装后重新启动。

### English

- Bump the Linux package to 0.1.15 so apt upgrades installations already running a local 0.1.14 build. Include reading notes, daily-goal review, MCP/Skill updates and the Chinese book-picker clipping fix.
- Android remains 0.1.8; the DSH plugin remains 0.2.0-dev.5. Save edits and stop the old service before installation, then restart.

## v0.1.14 / android-v0.1.8 / v0.2.0-dev.5 - 2026-11-10

### 中文

- 回顾整合日目标、单日详情及可切换项目的趋势图，支持阅读、运动、读书笔记、日记与自由书写。旧打勾保留完成状态，不推算时长或字数。
- 日记与自由书写按各自文件及内容日期统计。新增独立读书笔记页：按书归集、按日期逐条记录，支持多段原文摘录及页码、草稿恢复与编辑。回顾仅计感想字数，摘录不计入；对应文件字数优先于同日打卡字数，历史混合资料不自动归类或改写。
- 折叠积累明细、编辑与历史统计，分类字数不重复叠加到个人原文总计。
- MCP 与桌面 Agent 工具支持读书笔记分类及结构化章节、页码、摘录；读取返回元数据，更新保留未提交字段，感想与摘录分开。回顾工具增加与页面一致的 originals/goals 和指定日期查询，配套 skill 与中英文接口说明同步更新。
- 统一读书笔记与现有页面的字体、间距和主题，修复电脑端选书框中文裁切；本地安装包统一归档，成功构建后替换旧包。
- Android versionCode 11。使用新增读书笔记分类时，桌面服务与 Android 应配套升级。

### English

- Integrate daily goals, day details and selectable trends into Review. Legacy checks retain completion without inventing durations or character counts.
- Count journals and freewriting from their separate files and content dates. Add a dedicated reading-note page, grouping dated entries by book with optional excerpts, page references, draft recovery and editing. Review counts reflections only, excluding excerpts; matching file counts replace same-day checklist quantities. Leave mixed historical records unchanged.
- Collapse details, edits and historical statistics; category counts are not added again to personal-original totals.
- Extend MCP and desktop Agent tools with structured reading-note metadata, matching Review originals/goals and selected-date queries. Update the bundled skill and API documentation; Android Agent reads now include note metadata.
- Align reading-note typography, spacing and themes with existing pages; fix clipped Chinese book-picker text on desktop. Archive local packages in canonical directories and replace older builds only after successful validation.
- Android versionCode 11. Upgrade the desktop service and Android together before using the new reading-note category.

## android-v0.1.7 - 2026-11-09

### 中文

- Android 修复版，`versionCode=10`，沿用既有发行签名，可覆盖升级并保留资料。
- 移除资料库快照的 32 MiB 限制。备份快照逐项写入文件；恢复从文件流解析，避免整份字节数组、大字符串与跨库恢复的重复快照分配。压缩包及解压后总量仍限制为 1 GiB，并保留散列、附件集合和路径校验。
- 修复备份弹窗导出选项不显示，以及大快照导出时内存溢出闪退的问题。继续支持旧版 ZIP 和加密备份，保留恢复请求的幂等指纹。
- 修复接收电脑增量更新时漏存版本编号，导致手机后续修改一直等待前置版本的问题；核对原版本和内容后修复尚未发送的旧操作，明确显示仍被阻塞的同步。
- 使用现用手机的 51.15 MiB 快照分别进行普通 ZIP、加密备份的隔离恢复及重新导出比对：644 条记录、1,162 个版本、42 条编辑活动、570 个附件描述和 566 份去重附件均一致；来源、客户端归档及同步恢复信息保留。

### English

- Android fix release, versionCode 10, signed with the existing release key for in-place upgrades.
- Remove the 32 MiB library snapshot limit. Write snapshots to disk incrementally and parse restored snapshots from file streams, avoiding whole-file byte/string allocations and duplicate snapshots when restoring as a new library. Retain the 1 GiB archive/extracted-total bound and integrity, attachment and path validation.
- Fix missing export choices and large-snapshot export crashes. Keep legacy ZIP/encrypted backups and existing idempotent restore-request fingerprints compatible.
- Preserve version identities from desktop change events. Repair never-sent empty-parent operations only after verifying the acknowledged revision and original content; report blocked synchronization explicitly.
- Restore and re-export a real 51.15 MiB phone snapshot through both plain ZIP and encrypted backups in the isolated test application. All 644 records, 1,162 versions, 42 edit activities, 570 attachment descriptors and 566 deduplicated payloads matched, with provenance, client archives and recovery information preserved.

## v0.1.13 - 2026-11-09

### 中文

- Linux amd64 预览版，包含客户端、独立服务与 Node 运行环境。
- **配套升级：** 同步协议为 `1.0.0-draft.3`，请与 Android 0.1.6 一起升级。安装前保存编辑内容，并在退出时选择“停止服务并退出”；只关闭窗口或保留旧服务不足以加载新版。
- 原文和 AI 标注独立保存、编辑、同步及导出，标注关联不可变原文版本。MCP 与配套 Skill 区分作者来源和保存渠道，提供专用的来源纠正接口。
- 回顾主卡片、每日趋势与明细按内容日期统计当前个人原文字数，包含 MCP 归档的个人原文；真实编辑增减单独展示，独立 AI 标注不计入。
- 同一天新增日记追加到同一份记录，改进跨端合并、版本、附件、恢复及重试。
- 改进服务身份校验、备用地址、局域网发现和多网卡连接。创作时可阅读素材后加入文章或插入引用。
- AI 标注支持收起按钮、再次点击标题及 Esc 关闭。桌面可选择关闭到托盘或退出应用，真正退出时保留“保留服务并退出 / 停止服务并退出 / 取消”提示。
- 已通过隔离浏览器回归、Linux 成品包两次启动、回顾与标注交互、托盘和退出流程验证。历史资料不会自动拆分或改写。

### English

- Linux amd64 preview containing the client, standalone service and Node runtime.
- **Upgrade together:** synchronization uses `1.0.0-draft.3` and requires Android 0.1.6. Save edits, choose stop-service-and-quit, then install and reopen; leaving the old service running will keep old code loaded.
- Keep originals and AI annotations separate across editing, synchronization and export, with immutable version anchors. MCP and its Skill distinguish authorship from the saving client and provide a dedicated attribution-correction operation.
- Review cards, trends and details count current personal originals by content date, including MCP archives. Show observed edits separately and exclude independent AI annotations.
- Append new diary entries to one daily record and improve cross-device merges, versions, attachments, recovery and retries.
- Improve service identity checks, alternative addresses, LAN discovery and multi-adapter connections. Read material before selecting or quoting it while writing.
- Collapse annotations with buttons, title toggling or Escape. Choose close-to-tray or quit; explicit quit retains keep-service, stop-service and cancel choices.
- Isolated browser regressions and packaged Linux startup, review, annotation and close-lifecycle checks passed. Historical documents are not automatically split or rewritten.

## android-v0.1.6 - 2026-11-09

### 中文

- Android 预览版，正式应用 ID `io.github.wyf929597870.shiwen`，`versionCode=9`，使用既有发布签名。
- **配套升级：** 请与 Linux / 服务端 0.1.13 一起使用，同步协议为 `1.0.0-draft.3`。旧协议不会静默写入新结构；无需卸载应用或清空资料。
- 原文与 AI 标注分别保存，支持独立编辑、版本关联、图片、同步、备份和恢复；来源纠正与普通编辑分开处理。
- 回顾主统计、每日图表与明细统一显示按内容日期计算的个人原文字数，包含外部传入的本人原文；真实编辑增减单独展示。
- 增加服务身份校验、备用地址、局域网发现及定时连通性监测，当前资料库顶部显示节点状态。改进多网卡连接与离线恢复。
- 改进每天单份日记、同步合并、历史版本与附件保留、恢复和重试。历史混合文档不会自动拆分。
- 已通过 Android JVM 测试、页面回归、Kotlin / 仪器测试编译和正式签名校验；**本轮尚未完成 Android 真机覆盖安装及实际跨设备验收**，因此作为预览版发布。

### English

- Android preview, release-signed with the existing key; application ID `io.github.wyf929597870.shiwen`, versionCode 9.
- **Upgrade together:** use Linux / server 0.1.13 with sync protocol `1.0.0-draft.3`. Legacy protocols do not silently write the new structure. Do not uninstall or clear application data to upgrade.
- Keep originals and AI annotations separate, including editing, version anchors, images, synchronization, backups and recovery. Attribution correction is separate from ordinary editing.
- Review cards, daily charts and details count personal originals by content date, including personal text received through external tools. Observed edits are shown separately.
- Add service identity checks, alternative addresses, LAN discovery, periodic reachability checks and current-library header status. Improve multi-adapter connectivity and offline recovery.
- Improve one-diary-per-day merging, version and attachment preservation, recovery and retries. Historical mixed documents are not automatically split.
- Android JVM tests, UI regressions, Kotlin/instrumentation compilation and signing verification passed. **This round has not completed Android device upgrade or real cross-device acceptance**, so the package is published as a preview.

## android-v0.1.2 - 2026-11-08

- 修复安卓正文在重新渲染后，已同步的图片重新显示“图片加载中”的问题。
- Fix synchronized inline images reverting to a loading placeholder after the Android record view rerenders.

## android-v0.1.1 - 2026-11-08

### 中文

- 改进 Markdown 阅读，支持选择、保存、显示和放大库内图片，并接收系统分享的图片。
- 图片随正文同步，支持跨库复制、图文导出、历史版本、完整备份和加密恢复；旧备份保留兼容处理。
- 已使用同一正式签名在现用手机覆盖安装；隔离设备测试覆盖图片复制、分享、备份恢复和加密。图片同步需要更新后的服务端。

### English

- Improved Markdown reading, inline images and Android image sharing.
- Images participate in synchronization, cross-library copies, exports, history and encrypted backups; legacy backup compatibility is retained.
- Installed over the existing release-signed app on the current phone. Isolated device tests covered image copies, sharing and backup restoration. Image synchronization requires an updated service.

## windows-v0.1.9 - 2026-11-08

### 中文

- Windows x64 预览安装包包含更新后的桌面工作台和图片同步服务；安装器未进行代码签名。
- 与 Android 0.1.1、Linux 0.1.9 和插件 0.2.0-dev.4 配套。Windows 10 虚拟机隔离测试验证了打包服务的图片保存和读取；完整图形交互仍需进一步验证。

### English

- Windows x64 preview with the updated desktop workspace and image synchronization service; the installer is unsigned.
- Matches Android 0.1.1, Linux 0.1.9 and plugin 0.2.0-dev.4. An isolated Windows 10 VM test verified image writes and reads through the packaged service; full GUI validation remains outstanding.

## v0.1.9 - 2026-11-08

### 中文

- Linux 桌面和独立服务支持正文图片、图片同步、图文草稿及备份恢复。
- 使用隔离资料库验证了从 0.1.8 打包服务升级、原记录读取、图片保存和重启后读取。

### English

- Linux desktop and standalone service add inline images, image synchronization, drafts and backup compatibility.
- An isolated packaged-service upgrade from 0.1.8 verified existing records and image persistence across restart.

## v0.2.0-dev.4 - 2026-11-08

### 中文

- DSH / Web 预览插件增加图片插入、读取和同步，外部接口支持分块传入图片。
- 在隔离 Web 宿主中验证了安装、重启、卸载、重装和图片读取；需要 DSH 0.2.2-alpha.3 与 Node.js 24.9 或更高版本。

### English

- DSH / Web preview adds inline images, synchronization and chunked external image ingestion.
- Isolated host tests covered install, restart, removal, reinstall and image reads. Requires DSH 0.2.2-alpha.3 and Node.js 24.9 or newer.


## android-v0.1.0 - 2026-11-08

### 中文

Android 正式签名 APK，最低 Android 9 / API 28，版本 0.1.0，versionCode 3。

- 手机保留完整独立资料库，可离线记录、编辑日记与素材，整理文章、查看回顾；五栏导航和中英文/深浅主题。
- 配置多个命名服务节点，支持密码登录、手动/自动同步、完整性与冲突处理；模型密钥单独保存在手机，不随资料同步。
- 手机 Agent、远端 DSH 会话、人设与记忆、插件/自动化/外部接入管理，以及 Markdown 导入导出、完整备份和分享收件箱。
- 修复素材保存误传展示字段、草稿代次复用和旧待确认草稿恢复后无法进入编辑页的问题；恢复原请求重试，避免重复保存。

直接安装 APK；已有相同签名正式版请覆盖升级，不需要卸载。`.probe` 调试应用使用不同数据目录，不会自动迁移。同步请使用 Linux 0.1.8、Windows 0.1.7 预览包或当前仓库源码的独立服务。旧 Linux 0.1.7 不含此次同步接口；连接局域网服务时手机与电脑需网络互通。

**验证：** 源码回归 134 项通过，含编辑组件浏览器回归；Android release JVM 测试 19 项通过。同签名正式 APK 已在现用真机覆盖升级，原有编辑恢复/保存、页面切换及局域网同步通过：待同步 0、冲突 0、副本完整。未宣称所有 Android 设备、长期后台运行或真实模型供应商流程已验收。

### English

Release-signed Android APK, Android 9/API 28+, version 0.1.0, versionCode 3. Includes a complete local library, offline editing, named server nodes, manual/automatic sync, local/remote agents, settings and transfer workflows. Fixes rejected material updates and inaccessible pending edit drafts.

Upgrade over the existing release-signed app; do not uninstall to update. Debug `.probe` storage is separate. Use the standalone service from Linux 0.1.8, Windows 0.1.7 Preview or current source; older Linux 0.1.7 lacks these sync endpoints.

Validation: 134 source regressions and 19 release JVM tests passed. The current phone passed signed upgrade, pending draft recovery/save, navigation and LAN sync with zero pending operations/conflicts and a complete replica. Other devices, long-running background behavior and real model-provider workflows are not claimed as fully tested.

## windows-v0.1.7 - 2026-11-08

### 中文

首个 Windows x64 预览安装包，应用内版本保留已构建的 0.1.7。本平台独立使用 `windows-v0.1.7` 标签，与此前 Linux `v0.1.7` 安装包范围不同。

- 包含拾文客户端、独立服务、Node、DSH 和支持 Android 同步的拾文插件。
- 本机服务与局域网服务连接、密码认证；修复 Windows Node 路径、ESM 文件 URL 与已有资料库插件 junction 迁移。
- NSIS 安装程序包含 Microsoft 官方签名的 Visual C++ x64 运行库，安装需要管理员权限。拾文安装程序本身未代码签名，可能显示未知发布者。

**验证：** Windows 10 虚拟机首次/覆盖安装、隔离测试资料库迁移、独立服务启停通过；DSH 原生运行时及 DOCX/XLSX/PPTX 转 PDF 冒烟测试通过。完整图形界面、多机型和其他 Windows 版本尚未逐项验收，未调用真实模型。

下载 `.exe`，升级前退出拾文并停止本机独立服务。Windows 包不包含开发者资料或模型凭据；与 Android 连接时需开放可达的局域网服务地址。

### English

First Windows x64 preview installer, retaining the built application version 0.1.7. The platform-specific `windows-v0.1.7` tag is distinct from the earlier Linux `v0.1.7` package. Includes the desktop client, standalone service, Node, DSH, Android sync endpoints and the Microsoft-signed Visual C++ x64 redistributable.

Administrator installation is required. The Shiwen installer is unsigned. First/upgrade installation, isolated test-library relocation, service lifecycle, native runtime and Office-to-PDF smoke tests passed in a Windows 10 VM. Full GUI workflows and other Windows environments remain unverified. Stop the local service and quit the app before upgrading. No personal data or model credentials are bundled.

## 0.1.8 - 2026-11-08

### 中文

Linux x64 预览版，配套 Android 0.1.0 的同步服务更新。

- 服务端加入完整资料库同步、分页与分块传输、幂等写入回执、历史与来源、冲突和恢复协议。
- 为 Android 提供人设快照、远端 DSH 会话和插件/自动化/外部接入管理接口，复用已认证的工作台会话。
- 保留既有 Web、桌面与外部 Agent 的资料入口和来源统计，补充同步活动记录；修复服务停止时的连接关闭竞态。

升级前退出客户端并停止旧独立服务，再安装 `.deb` 并重新启动。安装不预装或替换个人资料。资料库增加同步结构，旧程序不应继续并发操作同一库。Android 保存本地副本，PC/Web 仍连接服务端资料库，不是全端去中心化同步。

```sh
sha256sum -c SHA256SUMS-0.1.8.txt
sudo apt install ./shiwen-dsh_0.1.8_amd64.deb
```

**验证：** 134 项源码回归通过；Linux 打包服务的启动/复用/停止与临时真实服务的同步、会话接口验收通过。不代表全新发行版系统安装或真实模型流程已验收。

### English

Linux x64 preview with service endpoints for Android 0.1.0: full-library synchronization, paged/chunked transfers, idempotent receipts, history/provenance, conflict recovery, agent profiles and remote DSH sessions/management.

Stop the existing service and quit the app before installing the `.deb`, then restart. No personal data is bundled or replaced. Android has its own local replica; PC/Web still use the service's library. Validation covers 134 source regressions, packaged service lifecycle and isolated real-host sync/session checks, not all Linux distributions or real model-provider workflows.

## 0.2.0-dev.3 - 2026-11-08

### 中文

DSH 插件预览包，要求 DSH 0.2.2-alpha.3 / Node.js >=24.9。

- 与 Linux 0.1.8 共用资料库、同步活动与工作台代码，加入 Android 同步、人设、远程会话和管理接口。
- 仍保留 DSH 原生对话与模型配置，主题/皮皮可选；插件不包含 Electron、Node 或拾文独立服务。
- 认证由 DSH 宿主负责。Android 密码登录请使用拾文独立服务/桌面包，不能把此 tgz 当作完整服务安装包。

先停止目标 DSH 实例，再安装到原 profile 后重启；停用/卸载保留资料。

```sh
sha256sum -c SHA256SUMS-0.2.0-dev.3.txt
dsh plugin --profile web add ./dsh-shiwen-0.2.0-dev.3.tgz --ignore-scripts
dsh web --no-open
```

**验证：** 134 项源码回归通过；实际 tgz 在隔离原生 DSH 中完成安装、认证、资料读写/MCP、重启持久化和卸载重装验收。未调用真实模型，未验证所有 Windows/macOS 原生 DSH 宿主。

### English

Plugin preview for DSH 0.2.2-alpha.3 / Node.js >=24.9, sharing Linux 0.1.8 library/workbench code and adding Android sync, profile and remote-session/management endpoints. Native chat/model configuration are preserved; appearance and persona remain opt-in.

The tarball excludes Electron, Node and the Shiwen standalone service. Stock DSH owns authentication; use Shiwen's standalone service/desktop package for Android password login. Stop the host, install into the same profile and restart. Actual tarball installation, auth, records/MCP, restart persistence and uninstall/reinstall retention passed in an isolated DSH host; no real models were called.

## 0.2.0-dev.2 - 2026-11-06

### 中文

DSH 独立插件预览版，要求 **DSH 0.2.2-alpha.3 / Node.js >=24.9**。

- 与桌面 v0.1.7 共用工作台源码：原生对话首页摘要、手机底部导航、素材/文章列表与正文切换、回顾图表与明细、分项发布前检查。
- 校对页面排版，修复宽屏首页输入框对齐和未注明日期的历史记录计数；旧资料导入入口位于设置。
- 可选拾文主题修复标题并显示共享 UI 构建版本 0.1.7；插件包自身版本为 0.2.0-dev.2。主题与皮皮默认保持可选，不覆盖已有模型配置。

**安装或升级：** 先停止目标 DSH 实例，再在同一 profile 安装并重启；资料不会预装或替换。尚未初始化 Web profile 时，先执行 `dsh web --help`。

```sh
sha256sum -c SHA256SUMS-0.2.0-dev.2.txt
dsh plugin --profile web add ./dsh-shiwen-0.2.0-dev.2.tgz --ignore-scripts
dsh web --no-open
```

**验证：** 48 项单元测试通过；预构建 tgz 在隔离 DSH 环境中完成安装、认证、资料读写与排序、MCP、可选主题、重启持久化和卸载重装保留资料验证；未调用真实模型。

插件包不包含 Electron、Node 或拾文独立服务；Web 认证和服务监听由 DSH 宿主负责。需要拾文桌面连接管理、独立服务与密码登录，请使用 [Linux v0.1.7](https://github.com/wyf929597870/shiwen-dsh/releases/tag/v0.1.7)。手机 Web 仍需联网，离线库与同步尚未实现。

### English

Standalone plugin preview for **DSH 0.2.2-alpha.3 / Node.js >=24.9**.

- Shares desktop v0.1.7 workspace code: native-chat home summaries, mobile navigation, library/article list-detail views, review charts/details and publication checks.
- Refines layouts, aligns the wide-screen composer and fixes undated historical-record counts. Legacy library import is in Settings.
- Optional Shiwen appearance preserves branded titles and displays shared UI build version 0.1.7. The bundle itself is 0.2.0-dev.2; theme/persona remain opt-in and model settings are preserved.

**Validation:** 48 unit tests passed. The packed tarball passed isolated stock-DSH installation, authentication, record operations/order, MCP, optional theme loading, restart persistence and uninstall/reinstall data-retention checks. No real model calls were made.

Stop the target host before upgrading, install into the same profile with the commands above, then restart. Personal data is neither bundled nor replaced. The tarball excludes Electron, Node and the Shiwen standalone service; authentication and network binding remain the DSH host's responsibility. For Shiwen connection management and password authentication, use [Linux v0.1.7](https://github.com/wyf929597870/shiwen-dsh/releases/tag/v0.1.7). Offline mobile libraries and synchronization are not implemented.

## 0.1.7 - 2026-11-06

### 中文

Linux x64 预览版，安装包包含桌面客户端、独立服务与 Node 运行环境。

- 修复页面切换后恢复 DSH 标题的问题；客户端标题栏、菜单、连接设置和托盘显示版本，侧栏显示 Web 版本。
- 原生对话首页加入今日积累、继续创作与最近记录；输入框、工作区选择和内容卡片对齐，适配宽屏。
- 校对素材、创作、设置等页面的边距、字号和层次；列表仍支持收起，让正文获得更多阅读空间。
- 手机 Web 增加底部导航、列表与正文切换、返回和草稿恢复；支持中英文及深浅主题。
- 回顾支持期间与自然月切换、逐日图表和记录明细；修复未注明日期的历史记录计数。发布前检查分项展示规则结果与人工核对提示。

**安装或升级：** 先退出客户端并停止旧独立服务，再安装并重新启动。安装不会预装或替换个人资料。

```bash
sha256sum -c SHA256SUMS-0.1.7.txt
sudo apt install ./shiwen-dsh_0.1.7_amd64.deb
```

**验证：** 48 项测试通过；完成插件构建、源码检查及 Linux 打包。浏览器检查覆盖桌面、宽屏与手机尺寸、中英文和深浅主题。未进行真实模型请求、手机真机软键盘或全新系统安装/升级验收。

**范围：** 仅发布 Linux amd64 安装包；移动端为联网访问的 Web 页面，离线资料库与同步尚未实现。单独的 Web 插件预览包仍为 v0.2.0-dev.1，不包含本次新增功能。

### English

Linux x64 preview bundling the desktop client, standalone service and Node runtime.

- Keep Shiwen titles after navigation and show client/Web versions in the relevant UI.
- Add daily activity, ongoing articles and recent records to the native chat home; align the composer and cards on wide screens.
- Refine library, writing and settings typography and spacing while retaining collapsible lists.
- Add phone Web navigation, list/detail views, back navigation and draft restoration, with Chinese/English and light/dark layouts.
- Expand review periods, calendar months, daily charts and record details; correct the undated historical-record count. Show publication checks as individual rules and manual-review prompts.

**Upgrade:** quit the client and stop the old service before installing, then restart. Personal data is neither bundled nor replaced. Verify the download using `SHA256SUMS-0.1.7.txt`.

**Validation:** 48 tests passed, plus plugin build, source checks, Linux packaging and desktop/wide/phone browser layout checks. Real model calls, physical phone keyboards and fresh-system installation/upgrades were not tested.

**Scope:** Linux amd64 installer only. Mobile Web requires a server connection; offline libraries and synchronization are not implemented. The separate Web plugin preview remains v0.2.0-dev.1 and does not include these changes.

## 0.1.6 - 2026-11-06

### 中文

Linux x64 预览版，安装包同时包含桌面客户端、独立服务与 Node 运行环境。

- 本机服务已运行时直接连接，未运行时自动启动；也可连接局域网其他电脑。退出时可选择保留或停止本机服务，远端退出不会停止远端服务。
- 独立服务支持密码登录、30 天记住设备、密码修改、设备撤销和退出登录。撤销设备同步断开实时连接；首次密码仅由本机管理入口设置，远端使用普通服务地址。
- 电脑和手机浏览器共用服务端资料、会话与配置；增加资料库进程锁，避免多个后端同时写入同一资料库。
- 素材与创作使用可收起的窄列表，仅显示标题与日期，搜索和筛选置顶；旧资料导入入口移至设置。
- 更新中英文 README、独立服务使用说明与移动端方案。

**安装或升级：** 先退出客户端并停止旧独立服务，再安装；升级后重新启动服务。本机首次启动设置访问密码。安装不会预装或替换个人资料。

```bash
sha256sum -c SHA256SUMS-0.1.6.txt
sudo apt install ./shiwen-dsh_0.1.6_amd64.deb
```

**验证：** 46 项测试通过；已验证隔离资料库的密码登录、设备撤销与实时连接断开、重启持久化、共享资料，以及真实 Electron 会话和打包后客户端启动。未完成全新机器的系统安装/升级验收。

**范围：** 仅发布 Linux amd64。Windows/macOS、移动端离线资料库及同步尚未交付。HTTP 只用于可信局域网；加密访问配置见独立服务说明。

### English

Linux x64 preview bundling the desktop client, standalone service and Node runtime.

- Reuse or automatically start a local service, or connect to another computer on the LAN. Local exit offers keep/stop/cancel; remote exit leaves the server running.
- Password login, 30-day remembered devices, password changes, device revocation and sign-out. Revocation closes live connections. First setup uses local administration; remote devices open clean server URLs.
- Computer and phone browsers share server-side data, conversations and configuration. Library ownership locks prevent concurrent backend writers.
- Collapsible narrow lists show titles and dates, with search and filters at the top. Legacy import moves to Settings.
- Updated bilingual README, service instructions and mobile design notes.

**Upgrade:** quit the client and stop the old service before installing the `.deb`, then restart. Set the access password on first local launch. Personal data is neither bundled nor replaced. Verify the download using `SHA256SUMS-0.1.6.txt`.

**Validation:** 46 tests passed, plus isolated service checks for authentication, revocation/live disconnection, persistence and shared data; real Electron cookie handling and packaged-client startup were checked. Fresh-machine system installation/upgrades remain unverified.

**Scope:** Linux amd64 only. Windows/macOS and mobile offline storage/synchronization are not delivered. Use HTTP only on a trusted LAN; see the service guide for HTTPS.

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
