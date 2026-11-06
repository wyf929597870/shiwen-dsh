# Third-party notices / 第三方说明

## DeepSeek Harness

- Source: https://github.com/deepseek-ai/deepseek-harness
- Pinned revision: `8bd073392eef6f54e921a093b95076248eb08cbb`
- Package version: `0.2.2-alpha.3`
- License: MIT; the upstream notice is reproduced in [licenses/DSH-MIT.txt](licenses/DSH-MIT.txt).
- Shiwen's desktop adaptations are stored in `patches/desktop/`, with checksums in `upstream.lock.json`.

The upstream checkout is downloaded separately and is not copied into this repository. Desktop distributions include upstream components; retain their license files and the licenses of bundled dependencies. Electron, the MCP SDK and other dependencies retain their respective licenses; the root MIT license does not replace them.

上游源码通过固定提交单独准备，不把完整 checkout 放入本仓库。桌面发行物携带上游与第三方组件，打包时应保留它们各自的许可证。本项目的 MIT 许可证不替代依赖许可证。

The Pipi persona is a customizable conversational preset, not personal history or a model credential. Runtime user configuration and data are not part of the source distribution.
