# 拾文 DSH 插件 / Shiwen DSH plugin

为原生 DSH Web 提供素材、日记、文章、回顾和 Agent 工具。预构建包不依赖拾文 Electron 外壳，不需要编译安装脚本。

Requires **DSH 0.2.2-alpha.3** and **Node.js >=24.9**. This is a development build, not a new stable release. Windows/macOS desktop hosts have not yet been validated.

在已有 Web profile 中安装本 tgz：

```sh
dsh plugin --profile web add ./dsh-shiwen-0.2.0-dev.0.tgz
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

在外部接入页创建凭据并复制 MCP JSON。命令、参数和资料路径根据宿主生成，接口仍只监听宿主的回环地址。远程浏览器看到的路径属于 DSH 服务所在电脑；MCP 配置应在那台电脑使用。旧资料导入也是读取宿主文件路径。

External access remains loopback-only. Generated MCP commands and legacy-import paths belong to the DSH host, not a remote browser's computer.

## 卸载 / Remove

先撤下自行添加的主题/角色配置，再执行：

```sh
dsh plugin --profile web remove dsh-shiwen
```

重启 DSH 后移除拾文功能，保留库文件。已保存的个人资料不会随 npm 包删除。

[源码与说明 / Source and docs](https://github.com/wyf929597870/shiwen-dsh)
