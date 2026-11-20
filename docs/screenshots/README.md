# README 界面截图 / README screenshots

截图日期：2026-11-14。应用来自本机已安装的 **拾文 0.1.17** Linux 安装包，版本同时通过系统包信息与工作台左上角标识核对。

## 截图来源

- 使用安装包中的 `resources/shiwen/shiwen-server` 启动真实独立服务。
- 使用全新临时数据根目录和独立端口，未连接现有个人资料库，也未修改正在使用的服务。
- 通过正式 `/api/shiwen` 接口写入虚构的日记、想法、文章和读书笔记，资料实际保存在临时 SQLite 库中。
- 浏览器访问完整工作台，保留真实 DSH 导航、工作区、拾文页面及版本标识。没有使用独立组件预览页、模拟桥接或替代导航。
- 截图为浏览器页面内容，尺寸 1920 × 897；不包含 Electron 原生标题栏，也不代表 Android 界面。
- 未配置模型账号或调用模型；示例内容不是实际模型输出。登录凭据、个人记录与本机文件路径不进入截图。

These captures use the installed Shiwen 0.1.17 service and full workspace with a separate temporary database. The pages use real backend APIs and fictional records, not a component preview or mocked bridge. They are browser screenshots, not native Electron or Android captures. No personal library or model credentials were used.

| 文件 | 内容 |
| --- | --- |
| `desktop-home.jpg` | 完整工作台首页、今日积累、最近记录与继续创作 |
| `desktop-materials.jpg` | 素材列表与日记正文 |
| `desktop-reading.jpg` | 完整工作台中的读书笔记编辑与历史笔记 |
| `desktop-review.jpg` | 时间筛选、每日趋势、素材来源与文章进展 |

## 重新截取

在已安装拾文的 Linux 电脑上，以安装目录为准运行。例如：

```bash
screenshot_root=$(mktemp -d /tmp/shiwen-readme-XXXXXX)
/opt/拾文/resources/shiwen/shiwen-server start --root "$screenshot_root" --port 4183
/opt/拾文/resources/shiwen/shiwen-server url --root "$screenshot_root"
```

打开命令返回的一次性本机管理地址，完成临时库的首次设置，进入工作台。管理地址不要写入公开文档或图片。通过正常界面或正式 API 添加示例资料，展开真实侧栏，依次截取首页、素材、读书笔记和回顾。不要用 `preview-reading-notes.mjs` 或 Android `preview:build` 代替完整应用截图。

截图前核对应用版本，逐张检查页面内容、布局和隐私。截图完成后，仅停止该临时服务：

```bash
/opt/拾文/resources/shiwen/shiwen-server stop --root "$screenshot_root"
```

Android 截图待实际设备捕获后再加入；不使用浏览器模拟图替代真机截图。
