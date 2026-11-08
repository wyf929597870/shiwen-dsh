# 拾文 Android

拾文 Android 是独立的本地资料库客户端。界面使用 React + Capacitor，资料、草稿、任务与同步状态保存在 Kotlin/Room 中，手机不需要运行 Node 服务。当前处于完整功能整合验收阶段；已执行结果与剩余验收项见 [验证记录](../docs/android/validation-2026-11-07.md)。

下载 [Android 0.1.1 正式签名 APK](https://github.com/wyf929597870/shiwen-dsh/releases/download/android-v0.1.1/shiwen-android-0.1.1.apk)，无需自行构建。最低 Android 9，应用 ID 为 `io.github.wyf929597870.shiwen`。升级直接覆盖安装，避免卸载造成未同步资料丢失。

图片同步需使用更新后的服务端，例如 Linux 0.1.9、Windows 0.1.9 预览版或插件 0.2.0-dev.4；旧服务遇到新图片时会提示升级。手机和服务电脑需网络互通，离线修改保留在手机。

## 日常使用

本节描述当前源码；已发布 APK 的具体功能以对应版本说明为准。

底部提供 **对话、素材、创作、回顾、设置**。没有电脑和服务器也可以记录、搜索、编辑和整理文章。资料不会按“最近 30 天”清理；回顾的 1/7/14/30 天和自然月只影响统计范围。

- **手机 AI**：在设置中填写兼容 OpenAI Chat Completions 的 HTTPS 服务地址、模型和 Key。模型设置留在原生层，使用 Android Keystore 保护，不返回网页、不参加资料同步。保存配置不调用模型；明确发送才发起请求。
- **远端 DSH**：选择已登录节点后使用该服务上的会话、Agent、工作区、Skills 与工具，审批、问题和取消均对应真实服务待办。手机不会把远端命令或 MCP 凭据当本机权限执行。
- **资料库**：多个资料库各有独立名称、身份和完整性状态。切换资料库不合并数据；跨库复制提供正文复制和包含库内图片的复制两种操作。
- **服务管理**：设置集中放置命名服务节点、插件、自动化、Agent 与记忆、模型及外部接入。服务器模型 Key 通过原生安全窗口填写；密钥不会进入 JavaScript。
- **系统分享**：其他 App 分享来的文本、链接或图片先进入待收集列表，选择目标库、类型与来源后才保存。只有链接时只保存链接参考，不声称已抓取网页正文。图片会先复制到应用私有存储，保存后作为库内附件，可随正文同步。

## 连接与同步

服务器需要加载同一版本的拾文移动接口。只更新 APK 不会升级另一台电脑上的服务。首次连接会核对库身份并复制完整正文、历史、来源、关联、活动和库内附件；未通过清单与散列校验前不会标为完整副本。

本机记录与远端服务副本分别保留。手动同步和自动同步可独立配置；后台同步使用 Android WorkManager，实际执行时间受系统电量、网络与后台策略影响。登录、人设同步、资料同步是不同状态，界面分别呈现错误和进度。

节点保存完整地址，例如 `http://192.168.1.10:3080`。HTTP 仅允许明确启用的私网地址，不允许跨源重定向；HTTPS 正常校验证书。手机和电脑应处于能够互访的网络。密码登录后的会话按精确 origin 加密保存，改地址需要重新登录；模型请求仍只允许 HTTPS。

离线编辑先提交手机本地事务，再排队同步；没有服务的独立库不会显示虚假的待上传数。并发修改通过版本基线检查，保留双方历史并由用户决议。初始化、换机与协调服务恢复有专门的核对流程，不通过“重装清空”解决。

## 导入、导出与备份

- Markdown 导入读取 UTF-8 文本，解析受支持的日期与来源元数据，保留原始文件。重复选择同一原件不会新建另一条记录。历史导入使用独立导入活动，不计为今日新增写作。
- Markdown 导出与系统分享通过 Android 文件选择器/FileProvider 进行，不把任意手机路径开放给网页。单独导出 Markdown 不包含图片；需要完整图文时选择“导出 Markdown 与图片”。
- 完整备份包含正文、版本、来源、关联、附件、草稿、回执与未同步分支，可选择包含本机 AI 会话，可使用密码加密。它不包含节点登录会话和模型 Key。
- 恢复原库保留 libraryId，不覆盖已存在的同库；导入为新库生成新的 libraryId，两库以后独立。恢复后的 AI 会话只读归档，中断任务不自动重发。
- 当前源码的 Markdown 导入上限为单文件 16 MiB、正文 100 万字符；完整备份使用流式文件处理，归档及解压数据上限 1 GiB，快照 JSON 上限 32 MiB。单张插图上限 8 MiB；图片选择一次最多 10 张、总计 32 MiB。备份需要足够的临时空间；超限或校验失败会明确报错，不把缺正文或附件的结果标为完整备份。旧版加密备份按旧版 64 MiB 上限读取。
- 清理功能只移除过期临时文件，不删除库内正文、历史或附件。异常中断留下的备份、恢复及导出临时文件在启动时按期限清理。卸载前应导出所需资料；调试包与正式包的数据目录互相隔离。

## 构建和安装

需要 Node 24、JDK 21、Android SDK Platform 36、Build Tools 36.0.0；最低 Android 9/API 28。SDK 许可证由安装者自行接受。

在仓库根执行：

```bash
npm ci
npm --prefix android ci
npm run android:doctor
npm --prefix android run check:ui
npm --prefix android run sync
cd android/native
./gradlew :app:testDebugUnitTest :app:assembleDebug :app:assembleDebugAndroidTest
```

设置 `ANDROID_HOME` 或在未跟踪的 `android/native/local.properties` 中填写 `sdk.dir`。`sync` 将当前本地网页装入 APK，配置不使用远端 `server.url`。

产物为 `android/native/app/build/outputs/apk/debug/app-debug.apk`。在已经使用调试包的手机上用 `adb install -r` 覆盖更新，保持原应用 ID 与签名，不要先卸载。正式签名、CI 和升级说明见 [构建与签名](../docs/android/build-and-signing.md)。

## 验证

```bash
# 仓库根：协议、服务和桌面回归
node --test --test-isolation=none tests/*.test.mjs
npm run mobile:contracts -- --check
npm run build
node scripts/check-mobile-sync-host.mjs
node scripts/check-mobile-sessions-host.mjs

# 已安装应用和测试 APK 的授权真机
ADB=/path/to/adb node scripts/check-android-host.mjs
ADB=/path/to/adb node scripts/check-android-sync-host.mjs
```

真实 Host 测试启动独立临时服务，通过 USB 端口转发连接；不读取个人服务、不调用付费模型，也不替代 Wi-Fi 验证。普通仪器测试使用随机命名资料库；`LibraryScaleTest` 需显式传入 `runScale=true`。

浏览器预览只能验证布局和交互，不能代替原生保存与系统文件入口。JVM/Node 测试、原生仪器测试、真实服务链路和最终人工交互各自的证据见验证记录。详细边界保留在 [Android 实施计划](../docs/android/README.md)。
