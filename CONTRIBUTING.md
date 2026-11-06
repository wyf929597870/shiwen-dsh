# 贡献指南 / Contributing

本项目只维护 DSH 版拾文。请先阅读 [README](README.md) 和 [开发说明](docs/development.md)。

- 业务功能优先写在 `plugins/`；共用服务保持单一数据入口，不新增第二套聊天引擎。
- 修改上游时以 `upstream.lock.json` 固定的提交为基础，将差异保存到 `patches/` 并更新 SHA-256。不要提交上游整个 checkout。
- 区分作者来源与保存渠道，保留内容日期；修改资料使用版本校验。
- 测试使用临时数据库及合成内容，不读写真实资料或自动调用付费模型。
- 用户可见功能同时维护中文和 English；更新相关文档与测试。
- 提交前执行 `npm test`、`npm run build`、`npm run check:source`；涉及桌面时补充原生验收。
- PR 描述说明问题、行为变化、验证结果及未验证的平台。

This repository maintains only the DSH edition. Prefer plugin changes over upstream modifications, preserve attribution and content dates, and use version checks for record mutations. Use synthetic test data and keep UI/docs bilingual. Run the checks above and state any platform or runtime validation gaps in your PR.

提交 Issue 时，请说明版本、系统、复现步骤和错误摘要。分享日志前移除资料正文、会话、模型密钥及客户端凭据。

For issues, include version, operating system, reproduction steps and a concise error summary. Remove personal content and credentials from any attached logs.
