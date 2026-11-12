# Android 构建、签名与升级

Android 位于仓库的 `android/`，复用协议与服务插件，不影响 Linux 桌面包构建。Node 24、JDK 21、SDK Platform 36 和 Build Tools 36.0.0 是当前锁定的工具链。SDK 许可证由安装者自行接受。

## 调试与验收

在仓库根目录执行：

```bash
npm ci
npm --prefix android ci
npm --prefix android run check:ui
npm --prefix android run sync
cd android/native
./gradlew :app:testDebugUnitTest :app:assembleDebug :app:assembleDebugAndroidTest
node ../../scripts/collect-android.mjs --debug --include-tests
```

`check:ui` 检查 JSX 中未定义的变量引用，防止仅转译成功但打开页面白屏；它不等于完整类型检查。`sync` 把当前本地页面装入 APK，不加载远程页面。

调试应用 ID 为 `io.github.wyf929597870.shiwen.probe`，正式应用 ID 为 `io.github.wyf929597870.shiwen`。两个包的数据目录互相隔离。包名改变不会自动搬移资料，切换包名前须通过完整资料库导出/恢复。切勿通过卸载或清除数据来解决升级签名冲突。

已经在使用调试包的手机，覆盖安装应用和测试 APK，避免测试管理器自动卸载试用中的应用：

```bash
# 先确认当前 Android 用户；以下以用户 0 为例。
adb shell am get-current-user
adb install --user 0 -r ../../debug/android/shiwen-android-0.1.9-debug.apk
adb install --user 0 -r ../../debug/android/shiwen-android-0.1.9-debug-androidTest.apk
adb shell am instrument --user 0 -w io.github.wyf929597870.shiwen.probe.test/androidx.test.runner.AndroidJUnitRunner
```

原生测试使用隔离库和模拟模型，不调用真实付费模型。`scripts/check-android-host.mjs` 检查真实临时服务上的认证和人设；`scripts/check-android-sync-host.mjs` 检查真实临时服务的完整复制与离线修改。它们通过 USB 反向端口连接，不代替同 Wi-Fi 的网络验证。

`scripts/check-android-recovery-host.mjs` 使用空的临时服务，检查手机先建库初始化及历史、原件保留。运行这些脚本前，在仓库根目录先执行 `npm run build`，并安装匹配的应用与测试 APK。长程测试需要手机保持解锁；同步和恢复脚本会打开调试专用的前台状态页。该页不修改系统省电配置，不解除锁屏，也不进入正式 release。

`ExistingLibrarySyncAcceptanceTest` 默认跳过。只有显式传入 `verifyExistingLibrary=true` 和 `expectedNodeOrigin` 才会使用手机已保存的登录状态，对指定现用资料库执行正常同步并检查完整性；它不创建测试记录、不清空库，也不输出正文、密码或 Cookie。不要把这项真实资料验收混入默认隔离测试。

## 正式签名

签名私钥由维护者保存在仓库以外。不要把私钥、密码、`local.properties`、用户资料或服务器凭据加入 Git。后续升级必须使用同一应用 ID 和签名密钥，并增加 `versionCode`。

构建读取四个环境变量：

| 变量 | 含义 |
| --- | --- |
| `SHIWEN_ANDROID_KEYSTORE` | 私钥库绝对路径 |
| `SHIWEN_ANDROID_STORE_PASSWORD` | 私钥库密码 |
| `SHIWEN_ANDROID_KEY_ALIAS` | 签名别名 |
| `SHIWEN_ANDROID_KEY_PASSWORD` | 对应私钥密码 |

设置完成后在 `android/native/` 执行：

```bash
./gradlew :app:testReleaseUnitTest :app:assembleRelease
node ../../scripts/collect-android.mjs
```

设置签名环境变量时，不要将密码直接写入可公开的命令记录或工作流 YAML。未设置私钥路径时只能得到未签名的 release APK，不能把它当可安装版本发布。

正式 APK 发布前须用 Android SDK 的 `apksigner verify --verbose --print-certs` 校验签名，并生成 SHA-256 校验文件。首次上线还须验证从前一版本覆盖升级后资料库、草稿和凭据仍能读取；仅通过编译不足以证明升级安全。

当前源码 `versionName=0.1.26`、`versionCode=29`。正式构建使用发布签名；调试构建仍使用独立的 `.probe` 应用 ID 和 `-debug` 版本后缀。

## CI

`.github/workflows/android.yml` 在相关 PR 或手动触发时检查服务协议、页面引用、JVM 测试并编译调试 APK。产物保留 7 天，供验收下载；工作流不持有正式签名密钥、不发布 GitHub Release，也不把模拟测试标作真机通过。

## 大资料库备份验收（0.1.7）

快照不再单独限制为 32 MiB；ZIP 大小和解压后的总量仍各限制为 1 GiB。备份在临时文件中流式编码，恢复从已校验散列的文件流解析，不再同时保留完整原始字节数组和字符串。JSON 对象仍在内存中完成关系校验，实际容量受设备内存和空闲存储影响，不能把 1 GiB 安全边界视为所有手机的容量承诺。

`LibraryLargeArchiveTest` 覆盖超过 32 MiB 的正文、历史和附件往返，以及旧恢复指纹编码。真实备份可复制到独立 `.probe` 应用的 `cache/actual-library.zip`，通过仪器参数 `archiveFixture=actual-library.zip` 验证（需保持测试应用在前台，避免设备省电冻结）；设置 `encryptedFixture=true` 额外覆盖加密解密恢复。测试始终使用新资料库和独立 registry，输出 `cache/verified-restored.zip` 供逐项核对，不能将个人备份加入仓库或发行附件。

## 安装包保留规则

正式 APK 与校验文件只放在仓库根 `release/android/`，调试及仪器测试 APK 放在 `debug/android/`。每个渠道只保留最后一次成功构建的版本。收集脚本先检查签名及复制校验，再替换旧包并删除 Gradle 输出目录中的 APK 副本；失败时不删除上一版。不要手动建立版本或日期子目录。也可在仓库根使用 `npm --prefix android run android:release` 或 `android:debug` 一次完成构建与归档。
