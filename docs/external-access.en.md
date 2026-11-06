# External agents and Shiwen

Shiwen 0.1.3 (Linux x64) includes a local HTTP service, an official SDK stdio MCP bridge, a CLI and a portable Skill. All adapters use the same record service; they do not open the database directly.

## Connect

1. Start Shiwen and open **External access** (under **More** when the sidebar is compact).
2. Enter a client name and select Create, Read, Update and/or Delete permissions. Only Create is selected by default.
3. Create a credential and copy the generated MCP configuration into your agent. The token is displayed once.
4. Keep Shiwen running. Reconnect the MCP client after configuration. Revoke a credential in Shiwen to block subsequent calls, including existing connections.

The service binds to loopback only. Client identity is recorded separately from content authorship. A user-authored diary saved by an agent remains personal; a retrieved original article is external; generated content is AI.

The packaged command is `/opt/拾文/resources/shiwen/integration/shiwen-bridge`. It includes Node and the MCP SDK and requires no download. Use `SHIWEN_TOKEN` or `SHIWEN_TOKEN_FILE` for authentication and optional `SHIWEN_ROOT_DIR` for a custom data directory. The default root is `${XDG_DATA_HOME:-~/.local/share}/shiwen-dsh`. The bridge discovers the current port from `external-endpoint.json` on each request. Start Shiwen before the MCP client; reconnect if the application was unavailable during initialization.

## CLI and HTTP

- `shiwen-bridge tools` lists authorized tools and schemas.
- `shiwen-bridge call shiwen_save --input request.json` submits a JSON object. Without `--input`, JSON is read from stdin.
- `shiwen-bridge mcp` serves MCP over stdio.
- `shiwen-bridge configure --token-file FILE` reads a token from stdin and creates a new 0600 credential file without overwriting existing files.

HTTP clients read the discovery file, then use `GET /v1/tools` and `POST /v1/tools/call`. Both require `Authorization: Bearer TOKEN`. Calls use JSON `{"name":"shiwen_save","arguments":{...}}` and return `{"result":...}` or an HTTP error with `{"error":"..."}`. Browser cross-origin calls are rejected.

Example save arguments:

```json
{
  "requestId": "conversation-42-message-7-save-1",
  "kind": "journal",
  "origin": "personal",
  "title": "A walk",
  "body": "# Today\n\nI went for a walk after work.",
  "day": "2026-11-05",
  "source": {"sessionId": "conversation-42", "messageId": "message-7"}
}
```

Use a fresh request ID for each intended mutation. After a timeout, retry with the same ID and identical arguments. The result is persisted per client, including across application restarts. A conflicting reuse is rejected. Update/delete require the latest record revision; restore uses the deletion revision and a new request ID.

| Permission | Tools |
| --- | --- |
| create | `shiwen_save`, `shiwen_collect` |
| read | `shiwen_search`, `shiwen_read`, `shiwen_review` |
| update | `shiwen_update` |
| delete | `shiwen_delete`, `shiwen_restore` |

External tools do not expose Shiwen conversations, personal memories or credential management. `shiwen_collect` stores an already fetched web original and its URL; it does not fetch pages. Optional `source.file` records a reference path without reading the file. Unknown dates stay unknown. Only explicitly requested authorship corrections should change `origin`; newly added AI text keeps AI provenance. Metadata corrections do not create writing activity.

## Skill and provenance

Copy `/opt/拾文/resources/shiwen/skills/shiwen-library/` to the external agent’s supported skills directory. In the source checkout it lives at `skills/shiwen-library/`. The Skill explains when and how to use the tools; it does not install a connection or grant access.

Record details show external activity with the registered client name and supplied session/message/file references. Backups retain this provenance but exclude credentials and retry receipts; start a new request workflow after restoring a content backup.

Tests use temporary data and the official MCP client without a model account. Linux package checks cover the settings UI, external saves, revocation and restart persistence. Individual third-party product setup flows have not all been tested.

SDK reference: [stdio serving](https://ts.sdk.modelcontextprotocol.io/v2/serving/stdio).
