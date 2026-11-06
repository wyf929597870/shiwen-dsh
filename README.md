<p align="center"><img src="assets/shiwen-mark.png" width="80" alt="拾文 Logo"></p>

# 拾文 · Shiwen DSH

**以 Agent 为入口的个人记录、资料整理与创作工作台。**

中文 | [English](README.en.md)

拾文基于 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness)，复用其原生对话、会话和 Agent 执行能力，通过插件加入日记、素材库、文章创作和回顾。这里只维护 DSH 版；旧版独立客户端不在本项目的维护范围内。

当前版本 **0.1.4**，采用 [MIT](LICENSE)。提供 Linux x64 桌面构建；Windows、macOS 和在原生 DSH 中独立安装拾文插件套件尚未验收。本仓库已提供源码；更新记录中的本地构建版本不表示已有对应的 GitHub Release。

## 能做什么

- **统一对话**：首页使用 DSH 原生 Agent 对话，从资料详情进入同一套会话。
- **记录与资料库**：保存日记、想法、网页原文和参考资料；Markdown 存储、可读排版、类型筛选和检索。
- **清晰来源**：区分个人书写、外部资料与 AI 内容；实际作者与代存客户端分别记录。
- **创作与回顾**：文章关联素材、发布前检查；按当日、近 7/14/30 天或自然月回顾。
- **资料操作工具**：Agent 可读取、保存、修改类型/来源/正文/日期、删除及恢复资料。列表与查询按内容日期倒序，未知日期置底。
- **角色与记忆**：内置皮皮角色，身份与交流方式可编辑，候选长期记忆须确认后才使用。
- **外部接入**：通过 MCP、HTTP API、CLI 和配套 Skill，让其他 Agent 操作拾文；独立凭据、分项权限、随时撤销。
- **旧资料迁移**：预览旧拾文数据库后导入空资料库，保留原始日期、来源和历史消息归档。

发布前检查只是提示；资料回顾和生成内容仍应核对。记忆停用影响后续上下文装配，已有会话或摘要可能仍包含之前的内容。

## 使用 Linux 安装包

拿到本项目构建的 `.deb` 后，完整退出拾文再安装或升级：

```bash
sudo apt install ./shiwen-dsh_0.1.4_amd64.deb
```

随后从应用菜单启动「拾文」，或运行 `shiwen-dsh`。安装包包含 Electron、Node、DSH 和拾文插件，无需另外安装 Node 或保留源码目录。现有验证环境是 Ubuntu 26.04 x64；其他 Linux 发行版仍需验证。

安装包不会预装个人资料、会话或模型凭据，也没有自动升级渠道。重装或卸载软件不会自动删除用户资料。

### 数据与旧版导入

默认数据目录为 `${XDG_DATA_HOME:-~/.local/share}/shiwen-dsh`：

| 子目录 | 内容 |
| --- | --- |
| `library/` | 拾文资料数据库 |
| `dsh/` | DSH 会话、配置与技能 |
| `desktop/` | 桌面偏好 |
| `workspaces/` | 工作文件 |

通过 `SHIWEN_ROOT_DIR` 可指定独立的数据根目录。开发版与安装版默认使用同一资料目录，测试时请显式指定临时目录。

在「素材 → 导入旧版资料」中选择旧库文件、预览并导入。目标必须为空；源库只读，历史对话归档不会伪造成 DSH 原生会话。不要为了重新导入而删除未知用途的数据目录。

### 外部 Agent 接入

打开侧栏「外部接入」（空间不足时位于「更多」），创建客户端凭据、选择权限，再将生成的 MCP 配置填入外部 Agent。默认仅允许新增资料，使用时保持拾文运行。接口只监听本机。

详细说明：[中文接入指南](docs/external-access.md) · [English guide](docs/external-access.en.md) · [配套 Skill](skills/shiwen-library/SKILL.md)

## 开发与验证

只构建和测试拾文插件，不需要下载完整上游或启动模型：

```bash
# 在克隆后的 shiwen-dsh 目录内；需要 Node.js >=24.9、npm 和 Git
npm ci
npm run build
npm test
npm run check:source
```

测试使用临时数据，不读取个人资料，不调用付费模型；HTTP/MCP 测试需要允许本机回环连接。`check:source` 检查拟提交文件与常见凭据模式，不能代替人工复核。

桌面开发还需要固定的上游源码、Linux 补丁和原生运行资源：

```bash
npm run upstream:prepare
npm run upstream:check
```

这两步只准备或检查源码，**不会自动准备完整桌面运行环境**。后续步骤和验证边界见 [开发与构建说明](docs/development.md)。当前尚未完成全新机器上的桌面全流程构建复现。

## 项目结构

```text
plugins/             六个拾文插件：资料、工具、界面、主题、记忆、外部接入
integration/         外部 MCP / HTTP / CLI 协议与桥接器
skills/              可交给外部 Agent 使用的技能说明
desktop/             DSH 桌面入口
scripts/             上游准备、构建、测试、迁移和打包
patches/             针对固定 DSH 版本的桌面适配补丁
tests/               隔离数据的自动化测试
upstream.lock.json   上游仓库、提交、版本与补丁校验值
docs/                接入、开发、贡献和插件发布状态说明
```

`upstream/`、`node_modules/`、`.runtime/`、构建产物、安装包和用户数据不纳入 Git。当前插件由桌面端统一装配，尚不是可直接通过 DSH 插件管理器安装的独立组合包，见 [插件架构与发布状态](docs/plugin-status.md)。

## 当前边界

- 已验证：本机 Linux 桌面启动、资料读写/筛选/排序、删除恢复、重启持久化、MCP/HTTP/CLI、凭据撤销。
- 待验证或实现：全新机器桌面构建、Windows/macOS、真实模型端到端流程、独立插件组合包、自动更新、关闭窗口行为设置、文章导出与版本界面等。
- 模型供应商与外部服务配置依赖 DSH；尚未逐项验收所有供应商及外部 Agent 产品。

更多：[扩展工具与 Skills](docs/extensions.md) · [贡献指南](CONTRIBUTING.md) · [更新记录](CHANGELOG.md)

## 许可证与上游

拾文代码采用 [MIT](LICENSE)。DSH 固定版本及许可证说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。本项目是独立社区项目，与 DeepSeek 官方发行版区分；第三方依赖分别遵循各自许可证。
