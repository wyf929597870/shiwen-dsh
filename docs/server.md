# 独立服务与局域网访问 / Standalone server and LAN access

本地构建的 v0.1.6 Linux 安装包同时包含桌面客户端、独立服务与 Node 运行环境。已发布的 v0.1.5 仍使用旧桌面后端。源码启动需要 Node.js >=24.9 与仓库依赖。

The local v0.1.6 Linux build bundles the desktop client, standalone server and Node runtime. Published v0.1.5 packages still use the older desktop host. Source launches require Node.js >=24.9 and repository dependencies.

## 桌面连接 / Desktop connections

首次打开桌面端，选择“本机服务”或“局域网 / 其他电脑”。本机模式先复用已运行服务，否则使用包内运行环境启动后台服务；可选择局域网访问及启动端口。已有服务不会因为新设置而被重启。下次启动记住上次连接，菜单“拾文 → 连接设置”可切换。

On first launch choose this computer or another server. Local mode connects to a running service or starts the bundled server. LAN access and startup port are selectable; an existing service keeps its binding. The last choice is remembered. Use Shiwen → Connection settings to switch.

在远端模式填写本机服务的 IP/端口时，会通过本机管理接口核实身份，并显示“本机服务 · 自动识别”，随后使用本机退出流程。同一 IP 的其他端口、其他电脑或无法核实的目标仍按远端处理，不会自动启动本机服务。识别到 HTTPS 服务时不会在重启时降级为 HTTP；需先按原证书配置启动服务。

When a remote address matches the authenticated local service authority, it is labeled “Local service · detected” and uses local exit management. Other ports, computers, or unverified targets stay remote with no local fallback. Detected HTTPS services must be restarted with their original certificate configuration; the client never downgrades them to HTTP.

首次启动本机服务后，在本机客户端的“访问密码与设备”页面设置密码（至少 10 个字符）。远端客户端填写服务地址和访问密码；电脑、手机浏览器直接打开服务地址即可登录，不再需要携带 token 的链接。勾选“记住此设备”保存 30 天的设备凭据；不勾选则使用浏览器会话 Cookie，服务端有效期最多 12 小时。密码不会写入客户端连接配置。

On first local launch, set an access password (at least 10 characters) on the Password and devices page. Remote clients use an address and password. Computer and phone browsers open the clean server address and sign in. Remembered devices receive a 30-day credential; otherwise a session cookie is issued with a server-side maximum lifetime of 12 hours. Desktop preferences never store the password.

在“设置 → 拾文资料 → 管理访问密码与设备”或“外部接入”管理密码和设备。修改密码需要当前密码，会撤销其他设备；可单独撤销设备或退出当前设备，撤销也会断开该设备的实时连接。服务重启不会使未过期的设备凭据失效，但协议、地址或端口改变后需要重新登录。所有登录设备都拥有同一份个人工作台的访问权限，这不是多用户权限系统。

Manage passwords and devices under Settings → Shiwen data, or External access. Password changes require the current password and revoke other devices. Individual revocation and sign-out also disconnect live connections. Unexpired credentials survive restarts at the same address, protocol and port. All signed-in devices share access to this personal workspace; this is not a multi-user authorization system.

退出本机模式时提供“保留服务并退出 / 停止服务并退出 / 取消”。停止服务会中断正在执行的任务并断开手机、浏览器。停止失败时不自动退出；异常终止桌面进程不会连带停止后台服务。远端模式退出只关闭客户端。切换离开本机服务时保留原服务运行。

Local exit offers keep, stop, or cancel. Stopping interrupts tasks and disconnects other clients; shutdown failure keeps the desktop open. Abnormal client termination leaves the server running. Remote exit never stops its server; switching away from a local server also leaves it running.

安装包中的管理命令位于应用资源目录 `resources/shiwen/shiwen-server`，支持 `status`、`url`、`stop`、`start --lan`；不要求系统安装 Node。升级软件前应停止独立服务，避免替换它正在使用的运行资源。本轮没有安装 systemd 服务或设置开机自启。

The package includes `resources/shiwen/shiwen-server` for status/url/stop/start management without system Node. Stop the service before upgrading package resources. This does not install a systemd unit or enable boot startup.

## 源码启动 / Start from source

先从托盘菜单**退出旧版拾文程序（v0.1.5 及以前）**，仅关闭窗口可能仍在后台运行。在 `shiwen-dsh` 仓库目录执行：

Quit older Shiwen versions (v0.1.5 and earlier) from their tray menu first; closing their window may leave them running. From the repository directory:

```bash
npm ci
npm run server:prepare
npm run server:start -- --lan
npm run server:url
```

已有依赖时可跳过 `npm ci`。`server:prepare` 构建独立运行副本，不覆盖开发桌面或 Web 预览正在使用的插件构建。后台服务不依赖 Electron、桌面窗口或启动它的终端；电脑关机、休眠或服务停止后无法访问。暂不自动开机启动。

Skip `npm ci` if dependencies are already installed. Preparation builds a separate plugin snapshot. The background service needs no Electron window or open terminal. The host computer must remain awake. Automatic startup at boot is not configured.

`--lan` 自动选择唯一的私有 IPv4 网卡地址，排除常见隧道地址。存在多个地址时会列出候选并要求明确指定；不会默认监听所有网卡。不带 `--lan` 时仅监听 `127.0.0.1`。

`--lan` selects the sole private IPv4 address. Multiple candidates require explicit selection. Omitting it binds to loopback only.

```bash
npm run server:start -- --host 192.168.1.20 --port 3080
```

源码启动或无桌面窗口时，在服务电脑执行 `server:url`，使用输出的一次性本机管理链接设置首次密码。管理链接有效期 5 分钟、只能使用一次；它属于管理凭据，不应分享。桌面本机模式自动完成此步骤。之后在自己的其他设备上打开 `server:status` 中的普通服务地址，用密码登录；手机和电脑需在可互通的局域网内，手机不能通过 `127.0.0.1` 访问电脑。

For a source/headless launch, run `server:url` on the server computer and use its one-time administration link to set the first password. It expires after five minutes and must not be shared. Local desktop mode handles this automatically. Other devices open the clean URL from `server:status` and sign in with the password. A phone cannot reach the computer through `127.0.0.1`.

## 数据与切换 / Data and switching

默认直接使用现有桌面数据根目录 `${XDG_DATA_HOME:-~/.local/share}/shiwen-dsh`：`library/` 资料、`dsh/` 配置与会话、`workspaces/` 工作文件。沿用 `desktop` profile、模型配置和用户插件，不复制或重新导入资料。服务管理文件和私有日志位于 `server/`。

The service reuses the desktop root, its `desktop` profile, model configuration, sessions, library and workspaces. It does not import or copy your records. Service state and private logs are stored under `server/`.

自定义目录可通过 `SHIWEN_ROOT_DIR` 或每条命令的 `--root` 指定，启停、查询必须使用同一个目录。本启动器统一使用该根目录下的 DSH home 和 library；不继承独立的 `DSH_HOME`、`SHIWEN_DATA_DIR` 环境变量覆盖。已在插件配置中明确设置的 `dataDir` 仍由 DSH 保留。

Use `SHIWEN_ROOT_DIR` or `--root` consistently for a custom root. This launcher sets DSH home and the default library under that root, rather than inheriting separate `DSH_HOME` / `SHIWEN_DATA_DIR` overrides. An explicit library plugin `dataDir` remains effective.

```bash
npm run server:status
npm run server:stop
# v0.1.6 桌面可直接连接运行中的独立服务。
# The v0.1.6 desktop connects directly to a running service.
```

新版本有资料库进程锁，并在修改桌面 profile 前检查独立服务占用。启动独立服务时也会检查旧版桌面的外部接口。**旧安装包没有新锁，服务运行期间不要打开旧版桌面。** 此保护用于本机磁盘，不支持把数据库放在网络共享盘供多个主机同时写入。

New code uses a process ownership lock and checks service ownership before relocating desktop plugins. Service startup also checks the older desktop's external endpoint. **Older installed binaries lack the new lock: keep them closed while the service runs.** This is a local-disk design, not a shared network-drive database.

所有浏览器访问同一个后端。已保存数据共用，切换页面或点击「刷新」读取其他端修改；同一记录的过期版本保存会被拒绝。未保存草稿各自独立。这里没有多设备离线资料库同步。

Browsers share one backend. Refresh or change pages to read another client's saved changes. Stale edits are rejected. Unsaved drafts remain per browser; this is not offline device synchronization.

## 访问边界 / Access boundaries

密码登录授予此 DSH 实例的完整访问权限，包括 Agent 能力，仅供自己的设备使用。HTTP 局域网访问没有传输加密，只用于可信网络；不要做公网端口映射。可使用受浏览器信任的证书启用 HTTPS：

Password login grants full access to this DSH instance, including Agent capabilities. Use only on your own devices. LAN HTTP is unencrypted and intended for trusted networks; do not forward the port to the public Internet. HTTPS accepts a browser-trusted certificate:

```bash
npm run server:start -- --host 192.168.1.20 --tls-cert /path/to/cert.pem --tls-key /path/to/key.pem
```

Host / Origin 校验继续由 DSH 执行，独立服务的浏览器会话由拾文密码认证适配管理。外部 Agent 的 MCP/HTTP 接口与本地控制接口继续仅监听回环地址；局域网 Web 不会自动扩大这些接口的访问范围。纯 HTTP 下自动复制可能不可用，页面提供手动复制登录地址。

DSH still enforces Host / Origin checks; the standalone password adapter manages browser sessions. External Agent MCP/HTTP and the service control endpoint remain loopback-only. On HTTP, clipboard access may be unavailable; copy the displayed link manually.

无法连接时，检查电脑 IP 是否变化、系统防火墙是否允许所选端口，以及 Wi-Fi 是否开启访客/客户端隔离。本项目不自动更改防火墙。

For connection failures, check the computer's IP, the chosen port's firewall rule and Wi-Fi client isolation. The launcher does not change firewall settings.

## 更新与验证 / Updates and validation

更新代码或依赖前先停止服务，再执行准备和启动命令。不要删除运行中或 desktop profile 正在引用的 `.runtime/server/build-*` 目录。独立运行副本仍使用仓库的 Node dependencies，不是独立分发安装包。

Stop the service before updating code or dependencies, then prepare and start it again. Do not remove a runtime snapshot still used by a running service or referenced by the desktop profile. Snapshots use repository Node dependencies; they are not standalone distribution packages.

```bash
npm test
node scripts/check-server.mjs
node scripts/check-password-auth.mjs
# 可选：使用本机实际局域网 IP，验证临时资料。
# Optional: test a real LAN binding with temporary data.
node scripts/check-server.mjs 192.168.1.20
```

验证脚本使用临时资料，不调用模型。覆盖启停、重复启动、认证、两个浏览器客户端读写、重启持久化、旧凭据失效，密码登录、跨站请求防护、设备撤销、实时连接断开和密码轮换。浏览器窄屏检查不等于真实手机、移动网络或所有防火墙环境均已验收。

Checks use temporary data and no model calls. They cover lifecycle, duplicate startup, authentication, two clients, persistence, expired bootstrap links, password login, cross-origin rejection, device revocation, WebSocket disconnection and password rotation. Narrow-screen browser checks do not constitute physical-phone or network-environment certification.

密码认证状态独立存储在 `server/access.sqlite`：密码使用随机盐和 scrypt 派生，设备随机凭据只存摘要。首次启用后，旧 DSH 浏览器 Cookie 不再作为独立服务的登录凭据。直接安装到原生 DSH 的 Web 插件仍使用宿主认证；本适配仅用于拾文独立服务，当前针对 DSH `0.2.2-alpha.3` 验证。

Authentication is stored separately in `server/access.sqlite`, with salted scrypt password derivation and hashed random device credentials. Old DSH browser cookies do not grant access to this standalone service. The plugin installed in stock DSH retains its host authentication; this adapter is tested against DSH `0.2.2-alpha.3`.
