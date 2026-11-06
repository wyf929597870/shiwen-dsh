# 外部 Agent 接入拾文

适用版本：拾文 0.1.3，Linux x64。MCP 使用官方 `@modelcontextprotocol/server` 2.2.0 的 stdio 服务；HTTP 和 CLI 调用同一套资料接口，不直接访问 SQLite。

## 桌面操作

1. 安装并启动拾文，打开侧栏「外部接入」（空间不足时位于「更多」内）。
2. 填写客户端名称，如 WorkBuddy。名称作为保存渠道记录，不决定内容作者。
3. 选择权限：**新增资料、读取与检索、修改资料、删除与恢复**。默认只选新增。
4. 点击「创建凭据」，复制 MCP JSON 到外部 Agent 的 MCP 设置。凭据仅显示一次；丢失时撤销旧凭据并创建新的。
5. 保持拾文运行，重新连接外部 Agent。现在可以要求它保存一条日记或收藏已抓取的网页原文。

服务只监听 `127.0.0.1`，不会向局域网或公网提供接口。凭据在拾文中仅保存哈希；可随时撤销。撤销会阻止已连接 MCP 客户端的后续调用。修改权限采用创建新凭据、撤销旧凭据的方式。

## MCP 配置

界面生成的配置包含实际安装位置和数据目录，优先直接复制。默认安装示例：

```json
{
  "mcpServers": {
    "shiwen": {
      "command": "/opt/拾文/resources/shiwen/integration/shiwen-bridge",
      "args": ["mcp"],
      "env": {
        "SHIWEN_TOKEN": "粘贴刚创建的凭据"
      }
    }
  }
}
```

安装包附带 Node 和 SDK，无需 `npx` 或在线安装依赖。配置文件中支持自定义数据目录 `SHIWEN_ROOT_DIR`；桥接器每次请求都会读取该目录的 `external-endpoint.json`，因此重启后端口变化不影响调用。启动 MCP 时拾文必须已运行；若启动顺序相反，打开拾文后重连 MCP。

也可以用 `SHIWEN_TOKEN_FILE` 指向仅当前用户可读的凭据文件，从配置中移除 `SHIWEN_TOKEN`。令牌不应出现在命令行参数、笔记或日志中。

## CLI

安装后桥接器路径为 `/opt/拾文/resources/shiwen/integration/shiwen-bridge`。源码环境可运行 `node integration/cli.mjs`，要求 Node 24.9+ 和已安装的项目依赖。

```bash
export SHIWEN_TOKEN_FILE="$HOME/.config/shiwen/workbuddy-token"
/opt/拾文/resources/shiwen/integration/shiwen-bridge tools
/opt/拾文/resources/shiwen/integration/shiwen-bridge call shiwen_save --input request.json
```

凭据文件可通过 `shiwen-bridge configure --token-file PATH` 创建：该命令从标准输入读取凭据、以 0600 权限写入新文件，不覆盖已有文件。`call` 省略 `--input` 时从标准输入读取 JSON。

`request.json`：

```json
{
  "requestId": "workbuddy-conversation-42-message-7-save-1",
  "kind": "journal",
  "origin": "personal",
  "title": "散步日记",
  "body": "# 今天\n\n下班后散步，想清楚了一些事情。",
  "day": "2026-11-05",
  "source": {"sessionId": "conversation-42", "messageId": "message-7"}
}
```

每次新的写入用一个新的 `requestId`；网络超时后，使用同一个 ID 和完全相同的参数重试。同一凭据下重复请求返回原结果，不重复写入。不同操作或不同正文复用 ID 会被拒绝。成功响应含记录 ID、版本和登记的客户端名称。

## HTTP API

读取数据目录的 `external-endpoint.json` 得到 `endpoint`。默认数据目录为 `${XDG_DATA_HOME:-~/.local/share}/shiwen-dsh`。不要硬编码端口。

- `GET /v1/tools`：返回此凭据获准使用的工具和 JSON Schema。
- `POST /v1/tools/call`：请求体为 `{"name":"shiwen_save","arguments":{...}}`。
- 两个接口均要求 `Authorization: Bearer TOKEN`；POST 使用 `Content-Type: application/json`。
- 成功响应为 `{"result":...}`；失败为 `{"error":"说明"}`，HTTP 401 表示凭据无效，403 表示权限不足，参数错误通常为 400。
- 不提供浏览器跨域访问。前端插件应通过自己的受控后端或 MCP 调用。

## 工具与权限

| 权限 | 工具 |
| --- | --- |
| create | `shiwen_save`, `shiwen_collect` |
| read | `shiwen_search`, `shiwen_read`, `shiwen_review` |
| update | `shiwen_update` |
| delete | `shiwen_delete`, `shiwen_restore` |

对外提供 8 个资料工具；拾文内部的会话读取、个人记忆和凭据管理不在外部接口中。

`shiwen_save` 接受完整 Markdown 和显式 `kind`、`origin`，不要求 DSH 消息 ID。外部会话、消息和文件路径放在可选 `source` 对象中。`source.file` 只保存出处文字，不读取本机文件。`shiwen_collect` 接受已抓取的正文和 HTTP(S) URL，固定为 `web/external`，不自行联网。

`shiwen_update` 要求最近读到的 `id` 和 `revision`，只更新提供的字段。正文替换前读完所有分页；内容变化时重新读取后决定如何处理。新增 AI 文字保留 AI 片段来源。`kind` 不自动改变 `origin`；只有用户明确纠正作者归属时才修改来源。素材与文章之间不能直接互改，创建文章并关联素材即可。

`day` 为内容日期，未知时省略或传 null，不会用保存日期伪造内容日期。撤销删除使用删除响应中的 revision，并提供新的 requestId。纯分类、来源或日期修改不凭空增加写作字数。

## Skill 与出处

随包 Skill 位于 `/opt/拾文/resources/shiwen/skills/shiwen-library/`，源码位于 `skills/shiwen-library/`。将整个文件夹复制到外部 Agent 支持的技能目录。它说明分类、来源、日期、重试和版本处理规则；MCP 凭据与连接仍由上面的流程配置。Skill 不自动授权操作。

素材详情的「外部保存与修改记录」展示客户端名称、操作、时间和提供的外部会话/消息/文件出处。作者来源独立显示。例如：自己书写，由 WorkBuddy 保存。备份包含这些出处；不导出凭据或请求重试账本。普通应用重启会保留凭据和请求账本，恢复内容备份后应重新开始请求流程。

## 验证范围

自动化使用隔离临时库验证真实 HTTP、CLI 和官方 MCP 客户端；不调用付费模型、不读取真实素材。Linux 安装包验证桌面配置、外部保存、撤销凭据和重启持久化。具体外部产品的设置界面可能不同，尚未逐一验收。

官方 SDK 参考：[stdio 服务](https://ts.sdk.modelcontextprotocol.io/v2/serving/stdio)。
