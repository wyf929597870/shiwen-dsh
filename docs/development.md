# 开发与构建 / Development and builds

## 1. 拾文插件源码 / Shiwen plugin sources

需要 Node.js >=24.9、npm、Git。根目录 `package-lock.json` 管理拾文依赖；上游使用它自己的 pnpm 锁文件，不混用两套安装目录。

```bash
npm ci
npm run build
npm test
npm run check:source
```

`npm ci` 可能下载 Electron 开发依赖。根包目前保留的 Electron npm 依赖不是桌面发行运行时；实际启动和打包固定使用 `.runtime/electron-44.7.0`。不要用根 `node_modules/electron` 替换已验证的发行运行时。

The root lockfile owns Shiwen dependencies. The upstream has a separate pnpm lockfile. Build/test commands above do not require the full upstream or model credentials. The root Electron development dependency is distinct from the pinned desktop runtime used by launch/package scripts.

## 2. 固定上游 / Pinned upstream

`upstream.lock.json` 是上游基线与补丁的事实源：

- Repository: `https://github.com/deepseek-ai/deepseek-harness.git`
- Revision: `8bd073392eef6f54e921a093b95076248eb08cbb`
- DSH: `0.2.2-alpha.3`
- Upstream package manager: `pnpm@11.28.5`
- Desktop Electron: `44.7.0`

```bash
npm run upstream:prepare
npm run upstream:check
```

第一次准备会从公开上游克隆到 Git 忽略的 `upstream/dsh/`，切到固定提交并应用补丁。重复运行会识别已应用的补丁。已有目录的提交不符、存在其他源码改动或暂存改动时会停止，不会 reset、覆盖或清理开发者文件。`--check` 只验证，不下载、不修改上游源码。

准备脚本只管理源码，不安装上游依赖，不创建个人 profile，不下载完整桌面运行资源。现有本机上游 checkout 的 remote 可能是本地镜像；提交和补丁验证通过即可使用，新克隆则使用公开 URL。

The setup command clones and patches only when necessary. It refuses to overwrite an existing checkout with another revision or unrecorded changes. `upstream:check` checks the revision, checksum and patch applicability without modifying checkout files.

升级上游时，需要更新提交和补丁、重新计算 SHA-256，并重新验收插件契约、运行时和桌面包。请勿直接跟随上游默认分支滚动构建。

## 3. 桌面构建前置条件 / Desktop prerequisites

目前仅支持 Linux x64 构建脚本。完整桌面链路还要求：

1. 上游依赖已用固定 pnpm 版本安装：在 `upstream/dsh/` 执行 `pnpm install --frozen-lockfile`。
2. 满足上游原生构建工具要求（参见固定 checkout 的 `docs/development.md`、`native/system/README.md`）。
3. 上游构建产物已生成，包括 `apps/desktop/lib/main.js` 与 `command-manager-entry.js`。对应上游命令为 `pnpm run build:artifacts --profile local`。
4. `.runtime/electron-44.7.0/` 中已有官方 Linux x64 Electron 44.7.0 解压资源。
5. `upstream/dsh/apps/desktop/.desktop-build/targets/linux-x64/runtime/primary-runtime/` 已准备，含 Node、pnpm 与其余锁定资源。上游入口为 `apps/desktop/scripts/prepare-primary-runtime.ts`，使用 `SHIWEN_DESKTOP=1`、`DSH_DESKTOP_UNSIGNED=1`、`DSH_DESKTOP_TARGET_PLATFORM=linux`、`DSH_DESKTOP_TARGET_ARCH=x64`。

以上属于原生运行环境装配，不包含在 `upstream:prepare` 中。当前工作机器已具备这些资源，但**全新机器上的下载、工具链及完整桌面构建尚未验收**；不要把下述打包命令理解为一键从零安装脚本。

Desktop prerequisites include upstream pnpm dependencies and native build tools, compiled desktop artifacts, the extracted official Electron 44.7.0 Linux x64 distribution, and the complete upstream primary runtime. These are not prepared by `upstream:prepare`. The existing development machine is prepared; a fresh-machine desktop build remains unverified.

## 4. 启动、打包和桌面验收 / Launch, package and desktop checks

在上述前置条件满足后，从拾文根目录运行：

```bash
npm run upstream:check
npm run prepare:linux
npm start
# 退出开发窗口后打包
npm run package:linux
node scripts/check-linux.mjs
node scripts/check-record-tools.mjs
node scripts/check-external-desktop.mjs
node scripts/check-record-order.mjs
```

产物是 `release/shiwen-dsh_<version>_amd64.deb` 与 `release/linux-unpacked/`。验收脚本使用临时资料目录；GUI 检查需要可用的桌面会话和本机回环连接。安装包应作为 Release 附件分发，不提交到 Git。

`npm run desktop:install` 是可选操作，会注册依赖当前源码位置的开发菜单入口；不是安装包步骤。托盘是否显示取决于桌面环境。

运行开发版时，用 `SHIWEN_ROOT_DIR` 指定测试目录可与真实资料隔离，例如：

```bash
SHIWEN_ROOT_DIR=/tmp/shiwen-dev-sandbox npm start
```

Desktop checks launch the app against temporary data and need a graphical session plus loopback access. They do not call paid models. Installers belong in release assets, not Git history. `desktop:install` is optional and creates a source-location-dependent development launcher.

## 5. 发布前本地整理 / Local publication preparation

```bash
npm run check:source
npm run upstream:check
npm test
npm run build
git status --short
```

人工检查 README、图片、测试 fixture 和拟提交文件。自动检查不会识别所有敏感文本。提交集应只有程序、通用角色预设、文档、图标、测试、依赖锁和补丁；不包含个人资料库、WorkBuddy 私人配置、会话、访问令牌或备份。

仓库初始化与本地整理不等于已提交或已发布。创建远端后，再核对地址、提交范围并推送；加入 `dsh-plugin` 话题也不代表已经上架 DSH 内置发现列表。
