# 拾文插件架构与发布状态 / Plugin status

一个仓库、一套业务模块，供原生 DSH Web 和拾文桌面使用。拾文提供 Linux 和 Windows 预览安装包；官方 DSH Windows/macOS 桌面宿主兼容仍待验证。

| 模块 | 职责 / Responsibility |
| --- | --- |
| `plugins/library` | 资料存储、日期、来源、迁移；支持配置目录与 profile 隔离 |
| `plugins/agent-tools` | 内部 Agent 的 10 个业务工具 |
| `plugins/workbench` | 素材、创作、回顾、角色及接入界面 |
| `plugins/theme` | 可选拾文样式与品牌 |
| `plugins/personal-context` | 可选人设与已确认记忆注入 |
| `plugins/external` | 外部客户端的本机 HTTP 服务 |
| `integration` | 12 个外部资料与图片工具、MCP 与 CLI |
| `bundle` | DSH 组合包元数据、默认及可选配置、安装说明 |

## 组合包 / Bundle

`npm run package:plugin` 从以上模块构建 `release/dsh-shiwen-0.2.0-dev.4.tgz`：

- `dsh.bundle` 声明标准配置层，支持 `dsh plugin add/remove`。
- 六个插件的已构建服务端/浏览器代码及 manifest、图标、MCP/CLI 和 Skill 全部随包交付。
- 普通第三方依赖显式声明；DSH 服务共享宿主提供的 peer，不捆绑第二套 DSH。
- 相对插件入口保留各模块的浏览器元数据发现，安装不依赖源码位置。
- 主题和皮皮默认关闭，用户可通过 profile patch 独立开启。核心业务不切换默认 Agent，也不重写模型凭据。
- 默认资料位于 DSH home 内，以 profile 隔离；停用/卸载保留数据。

独立运行不再依赖 Linux 桌面补丁或 Electron。旧桌面配置仍由 `scripts/profile.mjs` 装配，`SHIWEN_DATA_DIR` 继续兼容。Web 开发入口为 `npm run start:web`，使用独立 `shiwen-web` profile。

## 验证与分发 / Validation and distribution

原生 DSH Web 的安装、重启、接口权限、MCP、主题可选加载、卸载与重装保留资料由 `scripts/check-web-plugin.mjs` 在隔离环境验收。浏览器视觉与完整点击流程尚未完成验证；官方 Windows/macOS 桌面宿主尚未验收。

当前组合包通过 [v0.2.0-dev.4 GitHub 预览版](https://github.com/wyf929597870/shiwen-dsh/releases/tag/v0.2.0-dev.4) 分发，未发布 npm，也未宣称官方收录。`bundle/` 是打包配方，不能直接当作 Git 安装目标；使用预构建 tgz。六个内部 workspace 包继续保留 `private: true`，不单独发布。

[Web 安装与开发说明](web-plugin.md) · [组合包配置](../bundle/README.md)

The same business modules now form a prebuilt DSH bundle for stock Web and remain shared with the existing Linux desktop. The bundle uses the host runtime, preserves native chat and credentials, scopes default storage by profile, and makes appearance/persona opt-in. Install/remove via DSH's plugin CLI; use the built tarball rather than a Git checkout. The tarball is available in the [v0.2.0-dev.4 GitHub pre-release](https://github.com/wyf929597870/shiwen-dsh/releases/tag/v0.2.0-dev.4); npm publication and official catalog inclusion are not claimed. Official Windows/macOS desktop hosts and browser visual/interaction checks remain unverified.
