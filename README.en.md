<p align="center"><img src="assets/shiwen-mark.png" width="80" alt="Shiwen logo"></p>

# Shiwen DSH

**An agent-centered workspace for personal notes, collected materials and writing.**

[中文](README.md) | English

Shiwen uses [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) for native conversations, sessions and agent execution. Shiwen plugins add journaling, a material library, writing and activity reviews. This repository maintains only the DSH edition; the earlier standalone application is no longer maintained here.

Current version: **0.1.4**, [MIT license](LICENSE). Linux x64 desktop builds have been tested locally. Windows, macOS and standalone installation of the Shiwen plugin suite into stock DSH have not been validated. This repository provides the source code; local build versions in the changelog do not imply that matching GitHub Releases exist.

## Features

- One native DSH conversation interface, with discussion links from library records.
- Journals, ideas, collected web text and references stored as Markdown and rendered for reading.
- Authorship tracked separately from the client or agent saving the content.
- Articles linked to source materials and advisory pre-publication checks.
- Daily, 7/14/30-day and calendar-month reviews.
- Agent tools for search, reading, saving, updates, deletion/restoration and reviews. Lists and searches use descending content dates, with unknown dates last.
- Editable Pipi persona and communication style; proposed long-term memories require confirmation.
- External MCP, HTTP and CLI access with individual credentials, scoped permissions, revocation and retry deduplication.
- Preview and import of an earlier Shiwen database into an empty library, preserving dates and provenance.

Pre-publication checks are advisory. Disabling a memory affects subsequent context assembly, but previous conversations and summaries may retain earlier information.

## Linux installation

After obtaining a locally built `.deb`, fully quit Shiwen and install or upgrade:

```bash
sudo apt install ./shiwen-dsh_0.1.4_amd64.deb
```

Open 拾文 from the application menu or run `shiwen-dsh`. The package includes Electron, Node, DSH and Shiwen plugins; a source checkout or system Node is not required. Current desktop validation covers Ubuntu 26.04 x64. Other distributions still need validation.

Personal materials, conversations and model credentials are not bundled. There is no automatic update channel. Uninstalling or reinstalling does not automatically erase user data.

### Data and migration

The default root is `${XDG_DATA_HOME:-~/.local/share}/shiwen-dsh`:

| Directory | Contents |
| --- | --- |
| `library/` | Shiwen material database |
| `dsh/` | DSH sessions, configuration and skills |
| `desktop/` | Desktop preferences |
| `workspaces/` | Working files |

Set `SHIWEN_ROOT_DIR` to use a separate data root. Development and installed builds otherwise share the default root; tests must use temporary directories.

Use **Materials → Import previous library** to select and preview the old database. The destination must be empty. The source is read only; old conversations remain archives rather than being recreated as native DSH sessions.

### External agents

In **External access** (also available under **More**), create a client credential, select permissions and copy the generated MCP configuration into your agent. Creation is the only permission selected by default. Keep Shiwen running; the service listens only on loopback.

[Integration guide](docs/external-access.en.md) · [中文说明](docs/external-access.md) · [Companion Skill](skills/shiwen-library/SKILL.md)

## Development

Build and test the Shiwen plugins without downloading the full upstream or calling a model:

```bash
# From the cloned repository; Node.js >=24.9, npm and Git are required.
npm ci
npm run build
npm test
npm run check:source
```

Tests use temporary data and no paid models. HTTP/MCP tests need loopback networking. Source auditing checks common credential patterns and excluded artifact paths, but does not replace human review.

Desktop development additionally requires pinned upstream sources, patches and native runtime assets:

```bash
npm run upstream:prepare
npm run upstream:check
```

These commands prepare/check **sources only**, not the entire desktop runtime. See [development instructions](docs/development.md) for prerequisites and remaining validation limits. A full desktop build on a fresh machine has not yet been reproduced.

## Repository layout

```text
plugins/             Library, agent tools, UI, theme, memory and external-access plugins
integration/         External MCP / HTTP / CLI contracts and bridge
skills/              Instructions for external agents
desktop/             DSH desktop entry point
scripts/             Upstream setup, build, tests, migration and packaging
patches/             Adaptations for the pinned DSH revision
tests/               Automated tests with isolated data
upstream.lock.json   Upstream URL, revision, version and patch checksums
docs/                Development, integration and plugin publication status
```

Upstream checkouts, dependencies, runtime caches, generated bundles, installers and user data are excluded from Git. Plugins are currently assembled by the desktop launcher, not distributed as an independently installable DSH bundle. See [plugin status](docs/plugin-status.md).

## Validation limits

Local Linux verification covers startup, library operations, date ordering and filters, deletion/restoration, restart persistence, MCP/HTTP/CLI and credential revocation. Fresh-machine desktop builds, Windows/macOS, real-model end-to-end flows, independent DSH bundles, automatic updates, close-window behavior settings, article export/version UI and individual provider/agent configurations remain unverified or incomplete.

[Contributing](CONTRIBUTING.md) · [Changelog](CHANGELOG.md) · [Extension guide (Chinese)](docs/extensions.md)

## License

Shiwen uses the [MIT license](LICENSE). See [third-party notices](THIRD_PARTY_NOTICES.md) for the pinned upstream and its license. This is an independent community project, distinct from DeepSeek's official distribution. Dependencies retain their own licenses.
