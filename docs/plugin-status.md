# 拾文插件架构与发布状态 / Plugin status

当前是一个仓库、一套业务代码，同时服务于基于 DSH 的桌面客户端和后续的独立插件分发。旧版独立 Agent/客户端不在本项目内维护。

| 模块 | 职责 / Responsibility |
| --- | --- |
| `plugins/library` | 资料存储、日期、来源、迁移 / Storage, provenance, migration |
| `plugins/agent-tools` | 内部 Agent 的 10 个业务工具 / Internal agent tools |
| `plugins/workbench` | 素材、创作、回顾、角色及接入界面 / Workspace UI |
| `plugins/theme` | 拾文样式与品牌 / Theme and branding |
| `plugins/personal-context` | 人设与已确认记忆的上下文注入 / Persona and memory |
| `plugins/external` | 外部客户端的本机 HTTP 服务 / External access service |
| `integration` | 8 个外部资料工具、MCP 与 CLI / External tools and bridge |

当前桌面端通过 `scripts/profile.mjs` 动态生成组合配置和插件路径。这是唯一维护的桌面配置来源；历史测试 profile 已移除。

## 已实现 / Implemented

- 插件模块、服务注入、桌面界面及内部工具。
- 外部 MCP/HTTP/CLI 和通用 Skill。
- 同一桌面安装包中离线携带插件及依赖。

## 独立插件分发尚需完成 / Independent distribution remains pending

- 可由 DSH 插件管理器安装的 `dsh.bundle` 入口与显式依赖声明。
- 将桌面启动器提供的数据路径、桥接器路径转换为独立插件配置。
- 补齐可独立分发的资源与构建产物，解决跨目录导入。
- 让主题和人设作为可选启用项，验证干净原生 DSH 上的安装、升级与卸载。
- 发布兼容版本信息和安装文档，再进行插件索引接入。

现有插件 package.json 的 `private: true` 保留，避免误发布尚未整理好的 npm 包。此项目可以添加 `dsh-plugin` GitHub 话题，但话题分类不等于可安装组合包或官方收录。

The modules currently run through Shiwen's desktop profile. Standalone installation into stock DSH is not yet supported or validated. Publishing an independent bundle requires portable configuration, complete dependencies/assets, optional theme/persona activation and clean-install verification. Packages remain private to prevent accidental npm publication. A GitHub topic is a discovery label, not an installation contract or endorsement.
