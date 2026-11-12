# 外部 Agent 接入拾文

适用版本：拾文 0.1.15，Linux x64（0.1.4 起的公开预览版沿用同一套流程；读书笔记与日目标趋势需 0.1.14 及以上）。MCP 使用官方 `@modelcontextprotocol/server` 2.2.0 的 stdio 服务；HTTP 和 CLI 调用同一套资料接口，不直接访问 SQLite。

## 桌面操作

1. 安装并启动拾文，打开侧栏「外部接入」（空间不足时位于「更多」内）。
2. 填写客户端名称，如 WorkBuddy。名称作为保存渠道记录，不决定内容作者。
3. 选择权限：**新增资料、读取与检索、修改资料、删除与恢复**。默认只选新增。
4. 点击「创建凭据」，复制 MCP JSON 到外部 Agent 的 MCP 设置。凭据仅显示一次；丢失时撤销旧凭据并创建新的。
5. 保持拾文运行，重新连接外部 Agent。现在可以要求它保存一条日记或收藏已抓取的网页原文。

服务只监听 `127.0.0.1`，不会向局域网或公网提供接口。凭据在拾文中仅保存哈希；可随时撤销。撤销会阻止已连接 MCP 客户端的后续调用。修改权限采用创建新凭据、撤销旧凭据的方式。

日记（`kind: "journal"`）在同一资料库内按内容日期每天保留一篇。`shiwen_save` 的 `day` 指定补写日期；省略或为 `null` 时使用服务端当天日期。同一天再次保存会把新增正文追加到已有日记末尾，返回同一个记录 ID，插图和来源标记一并保留。重试必须沿用原 `requestId`，避免重复追加。修改整篇日记仍使用 `shiwen_update` 和最新 `revision`。

手机首页也按此规则保存；离线新增在同步时与 MCP 的同日日记合并。已有重复日记在服务端打开资料库时归并，原记录、版本和附件保留在回收站中；手机独立资料库在打开列表时归并。同步资料库由服务端统一归并后下发。全文编辑冲突保留为待处理冲突，不覆盖另一端内容。日期未知的历史资料不会被擅自归到某一天。

此规则需要更新服务端和 Android 客户端后生效；它约束当前日记记录，历史版本和回收站仍会保留恢复所需的数据。

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
| create | `shiwen_save`, `shiwen_collect`, `shiwen_annotation_create` |
| read | `shiwen_search`, `shiwen_read`, `shiwen_review`, `shiwen_image_read`, `shiwen_original_version`, `shiwen_annotation_list`, `shiwen_annotation_read` |
| update | `shiwen_update`, `shiwen_correct_origin`, `shiwen_annotation_update` |
| delete | `shiwen_delete`, `shiwen_restore`, `shiwen_annotation_delete`, `shiwen_annotation_restore` |

拥有 create 或 update 权限的客户端还可使用图片暂存工具，具体用途分别要求 create 或 update 权限。拾文内部的会话读取、个人记忆和凭据管理不在外部接口中。

`shiwen_save` 接受完整 Markdown 和显式 `kind`、`origin`，不要求 DSH 消息 ID。外部会话、消息和文件路径放在可选 `source` 对象中。`source.file` 只保存出处文字，不读取本机文件。`shiwen_collect` 接受已抓取的正文和 HTTP(S) URL，固定为 `web/external`，不自行联网。

图片通过 `shiwen_image_begin`、`shiwen_image_part` 和 `shiwen_image_status` 分块暂存，再把返回的附件 ID 写入 `![说明](attachment:ID)`，并在 `shiwen_save`、`shiwen_collect` 或 `shiwen_update` 的 `imageIds` 中提交。更新时上传用途为 `update` 并提供记录 ID；新增使用 `create`。暂存按客户端隔离，正文、附件和版本一起提交；请求超时仍使用原 `requestId` 重试。图片单张上限 8 MiB，每次提交最多 20 张，支持 PNG、JPEG、GIF、WebP。暂存过期时间为七天。

CLI 可使用 `shiwen-bridge upload-image ./photo.png` 上传，命令输出附件 ID；为已有记录添加时使用 `--purpose update --record RECORD_ID`。上传文件由 CLI 读取，不依赖 `source.file`。读取凭据可通过 `shiwen_image_read` 分块获取记录所属图片。

`shiwen_update` 要求最近读到的 `id` 和 `revision`，只更新提供的字段。正文替换前读完所有分页；内容变化时重新读取后决定如何处理。普通更新不接收 `origin`；更正来源使用独立的 `shiwen_correct_origin`，同样要求最新版本和请求 ID。`kind` 不自动改变作者来源。AI 总结、分析和改写必须使用 `shiwen_annotation_create` 独立保存，不能拼入原文。素材与文章之间不能直接互改，创建文章并关联素材即可。

`day` 为内容日期，未知时省略或传 null，不会用保存日期伪造内容日期。撤销删除使用删除响应中的 revision，并提供新的 requestId。纯分类、来源或日期修改不凭空增加写作字数。

## 原文与 AI 标注

先保存原文，再调用 `shiwen_original_version({id})` 获取 `recordId/versionId/contentHash`；用 `shiwen_annotation_create({requestId,originalId,originalVersionId,originalContentHash,title,body})` 保存标注。标注拥有独立 ID、版本和附件，原文后续编辑不会更新标注锚点。`shiwen_annotation_list` 默认只列未删除标注，`deleted:true` 列已删除标注；恢复使用标注自己的删除后 revision。父原文删除时隐藏其标注，恢复父原文不会复活被单独删除的标注。标注图片上传和普通图文使用相同的分块流程。

独立 AI 文章仍以普通 `origin:ai` 文档保存。来源含义、同步兼容性及预览统计口径见 [原文与 AI 标注](original-annotations.md)。

## Skill 与出处

随包 Skill 位于 `/opt/拾文/resources/shiwen/skills/shiwen-library/`，源码位于 `skills/shiwen-library/`。将整个文件夹复制到外部 Agent 支持的技能目录。它说明分类、来源、日期、重试和版本处理规则；MCP 凭据与连接仍由上面的流程配置。Skill 不自动授权操作。

素材详情的「外部保存与修改记录」展示客户端名称、操作、时间和提供的外部会话/消息/文件出处。作者来源独立显示。例如：自己书写，由 WorkBuddy 保存。备份包含这些出处；不导出凭据或请求重试账本。普通应用重启会保留凭据和请求账本，恢复内容备份后应重新开始请求流程。

## 验证范围

自动化使用隔离临时库验证真实 HTTP、CLI 和官方 MCP 客户端；不调用付费模型、不读取真实素材。Linux 安装包验证桌面配置、外部保存、撤销凭据和重启持久化。具体外部产品的设置界面可能不同，尚未逐一验收。

官方 SDK 参考：[stdio 服务](https://ts.sdk.modelcontextprotocol.io/v2/serving/stdio)。

## 读书笔记与日目标趋势

原有保存、搜索、读取和修改工具均支持 `kind: "reading_note"`。`title` 为书名，`body` 仅为感想；章节、页码、原文摘录使用结构化 `readingNote`，与页面共用存储格式。一本书可分日期多次记录，同日也可有多条；重试沿用 requestId，编辑用记录 ID 和最新 revision。未知日期保持未知，历史混杂资料不自动归类。

```json
{"requestId":"reading-note-unique-id","kind":"reading_note","origin":"personal","title":"书名","body":"我自己的感想","day":"2026-11-10","readingNote":{"chapter":"第一章","page":"12","excerpts":[{"text":"书中原文","page":"12"}]}}
```

`shiwen_read` 返回结构化 `readingNote`。更新省略章节、页码、摘录即保留；传入 excerpts 数组表示完整替换，空数组清空。不能同时提交 readingNote 和原始 annotation。旧备注无法识别时不能静默覆盖。只摘录、没有感想的内容应作为参考资料保存。

`shiwen_review` 保留原有 totals/daily 编辑统计，并增加 originals（现存个人原文字数）和 goals（definitions/daily/summary），与页面复用同一算法。查询某一天用 `{"period":"1","day":"2026-11-10"}`；近 7/14/30 天、自然月沿用原参数。日记与自由书写分开统计；读书笔记只计感想，已有笔记字数优先于当天打卡数字，不重复相加。旧打勾只统计完成天数，未知数值为 null，不推算分钟或字数；统计结果不返回日记正文。
