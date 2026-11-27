<p align="center"><img src="assets/shiwen-mark.png" width="80" alt="Shiwen"></p>

# Shiwen · 拾文

Shiwen is an open-source writing app and personal library. Start a freewriting entry on your phone, bring a passage together with a book highlight on your computer, or leave a question and come back to it after trying something. Original writing, AI annotations, questions and article drafts are stored separately, with links back to their sources.

[中文](README.md) · [Changelog](CHANGELOG.md) · [Screenshots](docs/screenshots/README.md)

## Install or upgrade

| Platform | Download | What you get |
| --- | --- | --- |
| Linux x64 | [0.1.67 Debian package](https://github.com/wyf929597870/shiwen-dsh/releases/download/v0.1.67/shiwen-dsh_0.1.67_amd64.deb) · [Checksum](https://github.com/wyf929597870/shiwen-dsh/releases/tag/v0.1.67) | Desktop client, standalone service and bundled Node runtime |
| Android 9 or later | [0.1.67 signed APK](https://github.com/wyf929597870/shiwen-dsh/releases/download/android-v0.1.67/shiwen-android-0.1.67.apk) · [Checksum](https://github.com/wyf929597870/shiwen-dsh/releases/tag/android-v0.1.67) | A local phone library with optional sync to your computer |
| Windows x64 | [0.1.9 desktop preview](https://github.com/wyf929597870/shiwen-dsh/releases/tag/windows-v0.1.9) | Earlier desktop release. See its release notes for supported features. |
| Existing DSH Web installation | [0.2.0-dev.7 plugin preview](https://github.com/wyf929597870/shiwen-dsh/releases/tag/v0.2.0-dev.7) | Uses the host's authentication and profile. [Plugin guide](docs/web-plugin.md) |

On Linux, run `sudo apt install ./shiwen-dsh_0.1.67_amd64.deb` after downloading. Before upgrading, quit the client and stop the old standalone service. Restart it after installation. On Android, install the signed update over the existing release to keep local data and unsynced edits. On macOS, you can open a running Shiwen service in a browser.

## Start with a freewriting entry

1. Create an entry in **Records**. Its content date determines where it appears in the list and in Review. An AI annotation links to the version it comments on, and your writing totals count your own text.
2. Open the entry's exploration pool (待探索) to ask a question about the whole entry or a selected passage. Open the pool from the records list to browse questions across the library. Android also has an entry point on Home. Suggestions arrive in the review queue (原始池). Accept one to keep it in your exploration pool (探索池).
3. When you have something to add, write a response or link a later entry. You can follow up on that response, record your current judgment, plan an experiment and attach the result to that experiment. Pin a question to today or this week to pick it up on Home.

**How does a question get linked to the entry?** A question written in an AI annotation becomes a pool item when discovery extracts it. An external agent can also submit a suggestion with its source when saving a record. In the library-wide pool, open **手动整理** (manual discovery). Choose **整理历史批注** to extract explicitly listed questions from older annotations, or **现在整理** to process recent changes. The per-entry view filters by source.

**Where are the controls?** On Linux and Android, open **Settings → Exploration**. **Daily discovery** schedules processing of new and edited records. **Allow model analysis of my original writing** lets discovery send your writing to the configured model for analysis. Both settings belong to the current library. A paired phone uses the computer service's discovery settings.

## Read, search and write

| Task | Where to start |
| --- | --- |
| Keep a book highlight | In Reading, save the excerpt with its book, chapter, page and your reflection. Each highlight can have its own entry so you can distinguish the author's words from your response. |
| Find a passage again | Global Search supports exact text and semantic search. Open a match to return to its source. The desktop service can download a local search model. Android bundles a Chinese BGE model and searches indexed content offline. |
| Turn material into a draft | Collect passages in a topic or explore related records on the canvas. Select material to generate an outline. The writing workspace keeps the draft, its source materials and its publication stage together. |
| Review recent work | Review shows writing and reading activity by content date, including trends and details. Original writing, book excerpts and AI annotations are accounted for separately. |
| Discuss an entry | DeepSeek Harness provides desktop conversations and tools. The phone has its own model configuration. Save a discussion as material or attach the AI's commentary to a version of the original. |

![Records list and reading pane in the desktop workspace, using a sample library in 0.1.17](docs/screenshots/desktop-materials.jpg)

This image shows the records list and reading pane in 0.1.17 with sample data. For the settings introduced in 0.1.67, see the exploration controls above.

## Storage and sync

The desktop client and browser use the library on the computer running the service. On Linux the default data root is `~/.local/share/shiwen-dsh`, respecting `XDG_DATA_HOME`. Override it with `SHIWEN_ROOT_DIR`. SQLite stores Markdown bodies, with separate attachment storage. The standalone DSH Web plugin stores data by host profile.

Android stores a full local library and accepts edits offline. To sync, connect to the computer under **Settings → Server nodes**, then open **Library sync** to check progress or resolve conflicts. The phone and computer manage model credentials separately. When you use a cloud model, the provider receives the conversation and relevant material included in that request. [Android guide](android/README.md) · [Connection guide](docs/node-connectivity.md)

To migrate an older Shiwen database, open **Settings → Shiwen data** on desktop, enter the database path on the service computer and preview the import. The destination library must be empty.

## Connect an external agent

Open **External access** on desktop, create a client credential, select permissions and copy the generated MCP configuration to the agent. Install the accompanying `shiwen-library` skill in that client. Shiwen supports MCP, HTTP and CLI access. The external interface listens on the service computer's loopback address and requires the library service to be running.

For example, an agent can save your freewriting as your own work, save its commentary as a separate annotation, and submit the annotation's questions to the review queue with the record as their source. Listing questions by record ID lets the agent verify which questions are linked to the entry. [External access reference](docs/external-access.en.md) · [Shiwen skill](skills/shiwen-library/SKILL.md)

## Run from source

Use Node.js 24.9 or later. To start the Web workspace from the repository root, run the following commands and open the address printed in the terminal. The default profile is `shiwen-web`.

```bash
npm ci
npm run start:web -- --no-open
```

To run the standalone service used by desktop, browser and Android clients, run these commands on the service computer. Open the one-time management link from `server:url` locally to set the initial password. Other devices sign in at the ordinary address printed by `server:status`. Use `--lan` on a trusted local network or omit it to listen on loopback only.

```bash
npm run server:prepare
npm run server:start -- --lan
npm run server:url
npm run server:status
```

## Development

| Directory | Responsibility |
| --- | --- |
| `plugins/library/`, `plugins/workbench/` | Records, versions, sources, search, exploration and the desktop/browser workspace |
| `desktop/`, `scripts/` | Electron client, service management and packaging |
| `android/web/`, `android/bridge/`, `android/native/` | Phone UI, Capacitor bridge, Kotlin/Room storage and background jobs |
| `integration/`, `plugins/external/`, `skills/` | External client integration and agent guidance |
| `contracts/`, `tests/` | Cross-platform contracts, fixtures and regression tests |

Run `npm test` and `npm run build` for the main project. For the Android UI, run `npm --prefix android ci` followed by `npm --prefix android run build`. Use a separate temporary library for development and acceptance checks. [Build guide](docs/development.md) · [Standalone service](docs/server.md) · [Android build and signing](docs/android/build-and-signing.md) · [Architecture diagram](diagram/system-architecture/architecture.en.svg) · [Contributing](CONTRIBUTING.md)

Shiwen builds on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) and is released under the [MIT License](LICENSE). Third-party components and models have their own terms. [Third-party notices](THIRD_PARTY_NOTICES.md)
