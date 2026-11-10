# 拾文项目约定

## 安装包与发包

- 所有对外交付的正式包统一放在仓库根 `release/<平台>/`，调试包放在 `debug/<平台>/`；平台为 `linux`、`windows`、`android`、`plugin`。
- 每个平台、每个渠道只保留最后一次成功构建的版本。禁止按日期、修复名称或版本号另建发布目录，禁止把包散放在项目根目录、桌面或临时目录。
- 新包先完成构建与校验，再替换该平台该渠道的旧包，并一起删除旧校验文件、重复副本和临时解包目录。构建失败时保留上一版；不能因为发布 Android 就删掉 Linux 包。
- 使用 `scripts/artifact-output.mjs` 统一归档；Linux/Windows/plugin 打包脚本已接入。Android 使用 `npm --prefix android run android:release` 或 `android:debug`；手动 Gradle 构建后必须运行 `node scripts/collect-android.mjs`（调试加 `--debug`，仪器测试加 `--include-tests`）。
- `--dir` 桌面解包验收产物仅放在 `debug/<平台>/`。构建缓存不作为发包目录，完成交付后删除其中重复的 APK/安装包。
- 清理仅针对本地构建产物，不删除 GitHub Release、标签、签名密钥、用户资料、备份、依赖或测试报告。
