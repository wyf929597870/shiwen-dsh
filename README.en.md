<p align="center"><img src="assets/shiwen-mark.png" width="80" alt="Shiwen logo"></p>

# Shiwen DSH

**Keep everyday thoughts and useful material, and gradually make something of them.**

Shiwen is a personal AI workspace built on [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness). Write a journal, capture an idea, collect something worth reading, or discuss it with an agent. Return to those records to reflect, develop your thinking and write articles. The library is stored on your own computer.

[中文](README.md) | English

[Why Shiwen](#why-shiwen) · [What it does](#what-it-does) · [Getting started](#getting-started) · [Data and privacy](#data-and-privacy) · [Contributing](#contributing)

Latest desktop release: **[0.1.5 · Linux Preview](https://github.com/wyf929597870/shiwen-dsh/releases/tag/v0.1.5)**, under active development and licensed under [MIT](LICENSE). Desktop checks have passed locally on Linux x64. Official Windows/macOS desktop hosts have not been validated. The Web plugin is available as a [0.2.0-dev.1 preview](https://github.com/wyf929597870/shiwen-dsh/releases/tag/v0.2.0-dev.1).

## Why Shiwen

Shiwen began with a personal wish: a more comfortable place to keep my notes.

Many note-taking and knowledge-management tools offer a lot of functionality, but learning and maintaining them takes effort. I wanted recording things to feel simpler: write down a thought, save an interesting article, or talk a question through with AI, without first having to design an entire system of categories, templates and workflows.

There was another reason. Some things feel better kept on my own computer. Journals, unfinished thoughts and notes from work can be deeply personal. I wanted control over where they live, without having to host the whole library in the cloud just to organize it.

That became Shiwen. Built on DSH, it brings conversation, note-taking, organizing and writing into one workspace. I want the agent to help capture ideas, find earlier records, make sense of collected material and, when useful, develop those fragments into an article.

The name 拾文 reflects that wish: gathering the fragments of daily life worth keeping, and letting them become something I can return to and build on.

> Shiwen stores its library locally. When you use a cloud AI model, conversations and relevant material included in requests are still sent to the configured provider. Local storage does not mean all AI processing happens offline.

## What it does

| What you want to do | How Shiwen helps |
| --- | --- |
| Capture a moment | Save journals, ideas, freewriting and references, with Markdown editing and a readable preview |
| Think with AI | Use native DSH conversations; discuss a selected record and save AI responses as material |
| Organize your library | Filter by type and search text; ask the agent to update type, authorship, dates or content, and delete or restore records |
| Look back | Review a day, the last 7/14/30 days or a calendar month; ask the agent to search and read records from that period |
| Develop an article | Create an article, link its source material and review pre-publication prompts |
| Connect another agent | Save, query and manage material through MCP, HTTP, CLI and a companion Skill |

Lists and searches use descending content dates, then creation times within each day, with unknown dates last. Personal writing, external sources and AI content have separate attribution. An agent saving your words does not automatically make them AI-authored.

The built-in Pipi persona is editable. You can change its identity and communication style, and proposed long-term memories require confirmation before use.

## Ways to use it

You can write directly in the material library or, after configuring a model, ask the agent for help. For example:

> “Save what I just said verbatim as today's journal entry, attributed to me.”

> “Find last month's journals and ideas, read them, and help me look back on what happened. Tell me which records you used.”

> “Find existing material for this topic. Discuss an outline with me first, then help turn it into a draft.”

These are example requests; results depend on your material, model and tool configuration. Pre-publication checks are advisory. Facts, citations and private information still need human review.

## Getting started

### Web plugin preview

With **DSH 0.2.2-alpha.3 / Node.js >=24.9**, download the **[prebuilt plugin (.tgz)](https://github.com/wyf929597870/shiwen-dsh/releases/download/v0.2.0-dev.1/dsh-shiwen-0.2.0-dev.1.tgz)** without cloning this repository. See the [release notes](https://github.com/wyf929597870/shiwen-dsh/releases/tag/v0.2.0-dev.1) for installation, checksums and limitations.

Run from this repository, without Electron or an upstream checkout:

```bash
npm ci
npm run start:web -- --no-open
```

Open the login URL printed by DSH. This uses a dedicated `shiwen-web` profile. Alternatively, run `npm run package:plugin` and install the prebuilt tarball into stock DSH Web. DSH supplies conversations and models; the plugin adds the library, organization, review and writing features.

[Web setup, storage and validation](docs/web-plugin.md) · [Bundle configuration](bundle/README.md)

### Linux desktop

Download the **[Linux x64 installer (.deb)](https://github.com/wyf929597870/shiwen-dsh/releases/download/v0.1.5/shiwen-dsh_0.1.5_amd64.deb)**. This preview is intended for users willing to report issues; Windows builds are not published yet. See the [release notes](https://github.com/wyf929597870/shiwen-dsh/releases/tag/v0.1.5) for checksums and known limitations.

Fully quit Shiwen, then install or upgrade from your download directory:

```bash
sudo apt install ./shiwen-dsh_0.1.5_amd64.deb
```

Open 拾文 from the application menu or run `shiwen-dsh`. The package includes Electron, Node, DSH and Shiwen plugins; no separate Node installation or source checkout is required. Desktop validation currently covers Ubuntu 26.04 x64. Other distributions still need testing.

Start by creating a record in Materials. For AI conversations, configure a model and credentials through DSH first. The installer does not include a model-service account or API key.

### Bring an earlier Shiwen library

Open **Materials → Import previous library**, select the old Shiwen database and preview it before importing. The destination must be empty. The source is read only, and old messages remain archives rather than being converted into native DSH sessions.

This repository maintains the DSH edition only. The earlier standalone client is no longer updated here.

### Connect an external agent

Open **External access** (under **More** if the sidebar is crowded), create a client credential, select permissions and copy the generated MCP configuration into your agent. Only creation is allowed by default. Permissions can be granted separately and credentials revoked. Keep Shiwen running; the service listens only on loopback.

[Integration guide](docs/external-access.en.md) · [中文说明](docs/external-access.md) · [Companion Skill](skills/shiwen-library/SKILL.md)

## Data and privacy

Web plugin data defaults to `$DSH_HOME/shiwen/<profile>/library`, with DSH_HOME defaulting to `~/.dsh`. Data lives on the DSH host; profiles are isolated by default.

**Sharing desktop data with a browser:** open **External access → Browser access** in the desktop app and copy its login URL into a browser on the same computer. Both clients use one DSH backend, library and conversations. Keep the desktop running; obtain a new URL after restarting. Reopen a panel or refresh to read changes saved by the other client. Unsaved drafts remain local to each window; stale record saves are rejected. A separately launched `shiwen-web` profile is still independent. Available starting with desktop `v0.1.5` and plugin `v0.2.0-dev.1`, for same-computer access only. LAN access and a separate backend service are not implemented. See [shared Host usage](docs/web-plugin.md#共用桌面后端--share-the-desktop-host).

The existing Linux desktop keeps its data root at `${XDG_DATA_HOME:-~/.local/share}/shiwen-dsh`:

| Directory | Contents |
| --- | --- |
| `library/` | Shiwen records, content and provenance in a local database |
| `dsh/` | DSH sessions, configuration and skills |
| `desktop/` | Desktop preferences |
| `workspaces/` | Working files |

Markdown content lives in the local library database; each record is not a separate `.md` file. Personal material, sessions and credentials are not bundled. Uninstalling or reinstalling does not automatically erase user data.

Set `SHIWEN_ROOT_DIR` to choose another data directory. Development and installed builds otherwise share the default root, so development tests should use a separate temporary directory.

External data transfer depends on the models and tools you use. Cloud models receive the conversation context and relevant tool results included in requests. External MCP servers or other services receive the arguments sent when calling them. Choose configurations appropriate to your material. Disabling a memory changes subsequent context assembly; earlier conversations and summaries may still contain it.

## Current status

| Status | Scope |
| --- | --- |
| Verified locally | Linux startup, library operations/filtering/date order, deletion/restoration, restart persistence, external MCP/HTTP/CLI and credential revocation |
| Still needs validation | Full desktop builds and system-level installation/upgrades on a fresh machine, Windows/macOS, real-model end-to-end flows and individual provider/external-agent configurations |
| Still to implement | Automatic updates, close-window behavior settings, article export and version-history UI |

A standalone bundle can now be built and installed through DSH's CLI, while the Linux desktop shares the same business modules. The bundle is distributed through [GitHub Releases](https://github.com/wyf929597870/shiwen-dsh/releases/tag/v0.2.0-dev.1) and is not published to npm; the `dsh-plugin` topic does not imply official inclusion. See [plugin architecture and publication status](docs/plugin-status.md).

## Contributing

With Node.js >=24.9, npm and Git installed, build and test Shiwen's plugins from the cloned repository:

```bash
npm ci
npm run build
npm test
npm run check:source
```

Tests use temporary material and no paid models. HTTP/MCP tests need loopback networking. These commands do not launch the full desktop application.

Desktop development also needs the pinned DSH upstream, Linux patches and native runtime assets. See [development instructions](docs/development.md) for preparation and acceptance commands. `upstream.lock.json` records the upstream revision and patches; business modules live in `plugins/`.

Questions, bugs and ideas are welcome in [Issues](https://github.com/wyf929597870/shiwen-dsh/issues). Read the [contribution guide](CONTRIBUTING.md) before submitting code.

[Changelog](CHANGELOG.md) · [Tools and Skills guide](docs/extensions.md) · [Development](docs/development.md)

## Acknowledgments and license

Thanks to [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) for the native conversations, session management and agent execution that let Shiwen focus on notes, materials and writing.

Shiwen is an independent community project under the [MIT license](LICENSE). Dependencies retain their own licenses; see [third-party notices](THIRD_PARTY_NOTICES.md).
