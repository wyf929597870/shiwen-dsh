# 为拾文扩展 Agent 工具、Skills 和 MCP

本文对应本地 DSH 基线 `8bd073392eef6f54e921a093b95076248eb08cbb` 和拾文 0.1.3。

## 当前预设

“拾文助手 · 皮皮”目前只挂载人设和上下文压缩，搭配全局拾文资料查询、归档、修改、网页收藏、删除/恢复、回顾和记忆工具。它尚未挂载 DSH 的终端、文件、网页及 Skills 消费工具。安装技能文件本身不会补齐这些工具。

在新建会话的 Agent 预设选择器中选择“标准模式”，即可使用原生的文件读写、搜索、终端、Skills 等能力。也可在“设置 → Agent 预设”中把它设为新任务默认。已有对话不会因此改变预设，请新建会话。全局拾文资料工具、个人身份和记忆上下文仍会加载；标准模式自身也包含编码助手提示词，暂不能视为与专门的拾文人设完全相同。

后续应给拾文预设补齐所需原生工具，并保留 DSH 的权限控制；无须重写 Agent 引擎。

## 添加 Skills

默认用户技能目录：

```text
~/.local/share/shiwen-dsh/dsh/skills/
  article-review/
    SKILL.md
    scripts/
    references/
```

设置了 `XDG_DATA_HOME` 或 `SHIWEN_ROOT_DIR` 时，以实际数据根目录下的 `dsh/skills` 为准。工作区也可使用 `.dsh/skills/` 或 `.agents/skills/`。

每个技能放在直属子目录，入口为 `SKILL.md`，例如：

```markdown
---
name: article-review
description: 在发布前检查文章结构、表达和来源。
---
先读取文章，列出逻辑断点和需核实的事实；未经用户要求不要直接改正文。
```

复制整个技能文件夹，保留其脚本和参考资料。开启 Skills 的预设会扫描目录；新建会话后要求“使用 article-review 检查这篇文章”。Skill 是指令与资源包，不会自动安装它依赖的 Python/Node 软件，也不能凭空增加缺失的工具。针对其他客户端专用 API 编写的技能需要适配。

## 接入 MCP

当前构建已启用全局 `mcp-manager`，支持 `stdio` 和 `streamable-http`，但没有独立的新增服务器表单。“设置 → 内置插件”仅展示运行清单。

一种方式是安装声明了 MCP 连接的 DSH 插件。另一种方式是在用户配置文件中合并 `mcp-manager` 行：

```text
~/.local/share/shiwen-dsh/dsh/profiles/desktop/cordis.patch.yml
```

例如下面是一个远程服务器配置条目，URL 为占位符，必须换成实际服务地址：

```json
{
  "id": "mcp-manager",
  "config": {
    "servers": {
      "my-server": {
        "transport": "streamable-http",
        "url": "https://your-server.example/mcp",
        "enabled": true
      }
    }
  }
}
```

把条目合并进文件已有的顶层数组，不要覆盖主题、语言等其他条目；已有 `mcp-manager` 时编辑原条目并保留其他服务器。该文件允许 YAML，也允许 JSON 格式。不要编辑自动生成的 `shiwen.desktop.patch.yml`。

本地服务改用 `transport: "stdio"`，配置 `command`、`args`，按需填写 `env` 和 `cwd`，不填 `url`。对应可执行程序及其依赖必须安装。远程服务需要由服务提供方运行。

需要密钥时可使用 `${credential:凭据名称}` 引用 DSH 凭据。保存后完整退出并重新启动拾文，新建会话检查 MCP 工具是否出现；连接成功的工具名形如 `mcp__my-server__tool-name`。接入第三方服务后，它只获得实际发给该工具的输入；按任务需要选择服务和授权范围。

## 安装 DSH 插件

侧栏“插件 → 添加插件”可安装兼容当前 DSH 版本的组合包。Skills、MCP 服务器和 DSH 插件是不同形式：Skill 提供工作方法，MCP 提供外部工具，DSH 插件能扩展界面、服务及预设。

## 拾文资料管理工具（0.1.2）

这些工具挂在全局，拾文助手和标准模式均可使用，无须另装 MCP：

| 工具 | 用途 |
| --- | --- |
| `shiwen_read` | 读取 Markdown 原文、版本、来源、日期、链接和关联；长文分页，并可验证续读版本 |
| `shiwen_update` | 修改 `kind/title/body/day/origin/url/annotation`，文章还支持 `stage/sourceIds` |
| `shiwen_collect` | 将已抓取的网页原文存为 `web + external`，保留原文链接和收藏请求出处 |
| `shiwen_delete` | 软删除指定版本的记录，返回撤销所需版本 |
| `shiwen_restore` | 撤销指定版本的删除 |

例如：“把那篇散步记录改为日记，来源改成自己书写，日期改为 2026-10-12。”Agent 先搜索、读取，再提交记录 ID、读取到的 revision 和需要修改的字段。未传字段保持原值；冲突必须重新读取。素材与文章不能直接互改，以免破坏关联语义；创作文章时新建文章并关联素材。

作者来源与操作人分开：代存用户原话是 personal；工具采集网络原文是 external；AI 自行生成或实质补写是 ai。`shiwen_save` 的 original 模式保存用户原话；organized 默认标 AI，只有用户确认归属、或仅排版其原话时才显式设 personal。来源可经 `shiwen_update.origin` 纠正，正文已有片段随之重标；同一次操作新增的 AI 文字仍保留 AI 片段来源，`shiwen_read.contentOrigins` 可显示混合来源。类型变更本身不改变来源。

来源纠正保留旧正文版本，并在新版本原因中记录来源变更；不改原始导入文件，不凭空添加写作字数。历史编辑事件保持不变；记录数按当前分类、来源和内容日期统计。网页收藏工具存储调用方已获取的正文，不自行联网，也不能验证上游抓取内容是否真实，Agent 必须先通过网页工具读取原文。

程序接口为 `POST /api/shiwen`，请求体 `{"method":"updateRecord","args":{"id":"记录ID","revision":1,"kind":"journal","origin":"personal","day":"2026-10-12"}}`，沿用 DSH 连接认证。正文 `body` 为完整 Markdown，`day` 为空字符串或 null 时清除日期。AI 调用在服务端固定新增文字为 AI 来源，客户端编辑的新增文字为 personal；调用方不能通过修改请求伪造编辑执行者。

## 外部 Agent 调用拾文（0.1.3）

已提供独立的本机 HTTP 服务、官方 SDK stdio MCP 桥接、CLI 和可复制的 Skill。请在「外部接入」页面创建凭据、选择权限，并复制 MCP 配置。这里是让外部 Agent 操作拾文，与上文的“拾文接入其他 MCP 服务”方向相反。详细流程见 [外部接入说明](external-access.md)。
