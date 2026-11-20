# PC 共用搜索验收记录

日期：2026-11-17。测试均使用虚构记录和独立临时资料库，不读取个人资料库。此记录区分真实模型、替身模型、源码运行和包内运行；尚未完成的项目不视为通过。

## 模型固定与对照

- 原始模型 `BAAI/bge-small-zh-v1.5` 修订 `7999e1d3359715c523056ef9478215996d62a620`；未量化 ONNX 为 `Xenova/bge-small-zh-v1.5` 修订 `75c43b069aac4d136ba6bc1122f995fedcfd2781` 的 `onnx/model.onnx`，SHA-256 `69a0b846f4f116b5e6aabf9546ea6754d02264f3211a13a1bd69b31b8040749a`，94,851,877 字节。
- 原始 `tokenizer.json` SHA-256 `48cea5d44424912a6fd1ea647bf4fe50b55ab8b1e5879c3275f80e339e8fae26`，`tokenizer_config.json` SHA-256 `e6f3b96db926a37d4039995fbf5ad17de158dfb8f6343d607e4dbaad18d75f5a`。下载总计 95,291,369 字节。Node 使用 onnxruntime-node 1.22.0 CPU、@huggingface/tokenizers 0.1.3，CLS 池化、L2 归一化和固定中文查询指令。
- 全新临时目录实际联网下载、逐文件 SHA 校验并启动 CPU worker，得到 512 维向量；已安装资产在临时目录离线校验后复用。模拟首次离线、下载流中断、校验错误与进程异常退出，验证失败状态、重试和无半成品；没有模拟磁盘不足。
- 固定虚构集 90 段和 10 查询的全部 100 个向量与本机原始 PyTorch 模型对照，最小余弦 0.9999998846，最大分量绝对差 2.5213e-7；10 条查询的前 5 名均 5/5 重合。输入样本来自 `../reports/shiwen-retrieval-evaluation/`，不表示真实个人资料准确率。

复现对照需要另行取得固定修订原始模型、已校验的 ONNX 资产及带 PyTorch/transformers 的 Python 环境，随后：

```sh
node scripts/verify-pc-semantic-model.mjs "$MODEL_PARENT" ../reports/shiwen-retrieval-evaluation /tmp/shiwen-vectors.json
OMP_NUM_THREADS=2 "$PYTHON" scripts/verify-pc-semantic-model.py "$ORIGINAL_MODEL_DIR" ../reports/shiwen-retrieval-evaluation /tmp/shiwen-vectors.json
```

真实 SQLite 中创建虚构自由书写记录后，经 `createContentSearch`、真实 worker 和派生索引，查询“从想法到付诸行动”得到对应原文及 UTF-16 锚点；实际浏览器和桌面验收另列。

## 测试与环境

- `node --test tests/pc-search-service.test.mjs tests/pc-search-index.test.mjs`：10 项通过。模型错误使用受控网络流和真实 Node worker，索引一致性测试使用模拟向量；真实临时 SQLite 覆盖新增、日记追加、Wiki 导入、mobileSync.push 接收、删除与恢复，另有重启、同版本内容变化、旧计算回写竞态测试。
- 首次 `npm test` 在受限沙箱中 58 个测试文件中 54 通过、4 失败：`external-http` 本地 127.0.0.1 监听报 `EPERM`，`service-network` 回环监听报 `EPERM` 后地址无效，`upstream-setup` 报 `spawnSync git EPERM`，`server-control` 进程出现 Node 内部 `execution_async_id` 断言。不是全量通过。
- 允许本地回环和临时 Git 子进程的环境下，上述四个文件单独复跑 5 项均通过；随后 `npm test` 全量为 233 项，223 通过、10 跳过、0 失败。10 项跳过均为未启用浏览器测试的 UI 场景，不能算浏览器通过。其后增加的故障及真实 SQLite 测试单独通过，最终整体回归以交付时结果为准。
- `npm run package:linux -- --dir` 生成的 Linux 解包构建中，使用包内 Node 执行包内搜索 worker，读取临时已校验模型成功产生 512 维向量。这项只验证包内 worker/依赖的真实推理，不等同完整桌面 UI 验收。
- 派生索引损坏回归：临时资料库中的 search.sqlite 写入无效内容，服务仍可初始化并返回 failed 状态，保存与原文查询可用，重建恢复索引初始化；真实模型正常检索同时复测。目录权限及实际磁盘空间耗尽尚未用真实磁盘故障验证。
- `npm run check:source` 沙箱内执行因 `spawnSync git EPERM` 失败；允许只读 Git 子进程后通过（该次检查 567 个文件；最终检查为 569 个文件）。
- Windows：打包脚本要求 Windows x64；本机 Linux 仅有 linux-x64 目标，未构建、未运行 Windows 包。Linux 最终包验收另行记录。
- 最终服务与索引故障修复后，允许回环环境 `npm test`：246 项，235 通过、11 跳过、0 失败；跳过不计为浏览器验证。独立服务与索引测试另验证运行中索引表故障、后台任务关闭、worker 卡死时并发查询失败与重试、并发重建互斥。
- 本机已安装版本 0.1.25，原 Linux 正式包 297,396,796 字节，SHA-256 `c095b62a569c24b352708e8225e0c8d97c2d96f6eac0b7ebf5d840b0189c4a7f`。新版本 0.1.26。
- 正式包：`release/linux/shiwen-dsh_0.1.26_amd64.deb`，369,827,888 字节，SHA-256 `feab907ada7cccadf2f7471183958304bd93df1789c7e84bc9c11c6f4efc12cb`；包内 dpkg Version、源码版本、文件名均为 0.1.26。较 0.1.25 增加 72,431,092 字节（约 69.1 MiB），不包含首次使用另行下载的模型。包构建首次在沙箱中因发布前 `spawnSync dpkg-deb EPERM` 失败，旧包被保留；允许本机打包子进程后重建、包结构与版本校验成功并按项目规则替换旧包。
- 实际正式 deb 解压到临时目录，以包内 Node、包内 worker 和包内 CPU 依赖，在隔离的已校验模型目录上离线执行推理，返回 512 维向量；临时解包目录已删除。该测试不等同正式包的完整 GUI 安装测试。
- 一万片段隔离真实 SQLite + 搜索服务 + ONNX 基准，热查询 30 次 p95 198.24 ms，未含 HTTP；详细数据见 `docs/design/pc-semantic-search-acceptance.md` 与基准记录。浏览器与 Electron 的实际四入口及同服务结果对照见 `.qa/pc-semantic-search-20261117/`；没有安装用户主环境、Windows 未构建或实机测试。
