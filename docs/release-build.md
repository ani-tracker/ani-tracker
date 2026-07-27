# Tauri 跨平台打包与发布

最近更新：2026-07-27

## 发布工作流

| 工作流 | 目标 | 正式产物 |
| --- | --- | --- |
| `actions-lint.yml` | 全部 GitHub Actions 配置 | actionlint 静态门禁 |
| `tauri-mobile.yml` | Android/iOS 持续集成 | ARM64 Debug APK、未签名 IPA 与原生策略测试，不发布 |
| `tauri-release-desktop.yml` | Windows x64 | 自签 NSIS `.exe`、MSI `.msi` |
| `tauri-release-desktop.yml` | macOS x64/arm64 | 自签 `.dmg` |
| `tauri-release-desktop.yml` | Linux x64 | `.deb`、`.AppImage` |
| `tauri-release-android.yml` | Android arm64 | 自签 `.apk` |
| `tauri-release-ios.yml` | iOS arm64 | 未签名 `.ipa`，由用户重签 |

移动持续门禁在相关源码的分支推送和 Pull Request 上真实编译 Android ARM64 Debug APK 与 iOS ARM64 未签名 IPA，执行 Kotlin/Swift 策略测试编译、Renderer 隔离和包内容检查，但不发布产物。发布工作流支持 `workflow_dispatch` 和 `v*` 标签。版本必须符合语义版本，发布脚本会同步 `package.json`、Tauri 配置与 Cargo 包版本，并为每组产物生成 SHA-256 和版本化 `manifest.json`。任何 `.github/workflows` 修改都会触发固定版本及摘要的 actionlint 门禁。macOS 同时产出 Intel/Apple Silicon 的自签 DMG，iOS 则固定产出供用户自行重签的 ARM64 IPA。

## 签名凭据

仓库不保存证书、私钥或密码。Windows、macOS 与 Android 使用项目自行生成并长期保存的证书；macOS 自签包不具备 Apple Developer ID 公信力且不公证；iOS 通过 Tauri `--no-sign` 输出可重签的 IPA。

### Windows

- `WINDOWS_CERTIFICATE_BASE64`
- `WINDOWS_CERTIFICATE_PASSWORD`

### macOS

- `APPLE_CERTIFICATE_BASE64`
- `APPLE_CERTIFICATE_PASSWORD`
- `APPLE_SIGNING_IDENTITY`

### Android

- `ANDROID_KEYSTORE_BASE64`
- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_ALIAS`
- `ANDROID_KEY_PASSWORD`

iOS 不需要 GitHub 签名 Secrets。

本地执行 Android Release 时使用对应的 `ANI_ANDROID_KEYSTORE_PATH`、`ANI_ANDROID_KEYSTORE_PASSWORD`、`ANI_ANDROID_KEY_ALIAS` 和 `ANI_ANDROID_KEY_PASSWORD` 环境变量；正式 Gradle 任务缺少任一值会直接失败，不会生成未签名 APK。

## 自签名材料

Windows 使用 PowerShell 生成可导出的代码签名证书：

```powershell
$aniCertificate = New-SelfSignedCertificate -Type CodeSigningCert -Subject "CN=Ani Tracker" -CertStoreLocation Cert:\CurrentUser\My -KeyAlgorithm RSA -KeyLength 3072 -HashAlgorithm SHA256 -KeyExportPolicy Exportable -NotAfter (Get-Date).AddYears(10)
$aniCertificatePassword = Read-Host "PFX password" -AsSecureString
Export-PfxCertificate -Cert $aniCertificate -FilePath .\ani-tracker-windows.pfx -Password $aniCertificatePassword
Export-Certificate -Cert $aniCertificate -FilePath .\ani-tracker-windows.cer
```

Android 使用 JDK `keytool` 生成长期发布密钥：

```powershell
keytool -genkeypair -v -keystore ani-tracker-android.jks -alias ani-tracker -keyalg RSA -keysize 4096 -validity 10000
```

macOS 自签证书必须包含 Code Signing EKU，并将证书和私钥导出为 P12。工作流会把 P12 导入临时钥匙串，在临时 runner 中信任该自签根，构建后提取 `.app` 的实际签名证书并比对 SHA-256，最后清理钥匙串和系统信任。公开 PEM 会随 DMG 发布，目标 Mac 仍需手动信任证书或在系统设置中确认运行。

将 `.pfx`、`.p12` 与 `.jks` 的原始文件内容编码为 Base64 后分别写入 `WINDOWS_CERTIFICATE_BASE64`、`APPLE_CERTIFICATE_BASE64` 和 `ANDROID_KEYSTORE_BASE64`；密码、macOS identity 和 Android alias 写入同组 Secrets。私钥文件必须离线备份，不能提交到仓库。Windows 工作流会自动导入自签 PFX、调用 Tauri 签署 MSI/NSIS、逐个核验证书指纹，并在产物中附带不含私钥的 `.cer` 供目标机器建立信任；密钥缺失、证书过期、不是自签证书、不含 Code Signing 用途或签名校验失败都会终止发布。

## 资源边界

桌面 runner 会准备并验证：

- 对应平台和架构的 torrent-core、libtorrent、动态依赖、清单和许可证。
- 托管 qBittorrent-nox、Qt 运行库、WebUI、版本和依赖闭合。
- Windows/macOS 的 FFmpeg/FFprobe；Linux 使用声明的系统依赖。
- 对应平台 libVLC 运行时、插件、来源信息和许可证。
- 桌面远程 PWA、本地 CA/TLS 所需运行能力和应用许可证。

Android/iOS 只打包移动本地闭环：

- 内置 torrent-core 原生库。
- Android LibVLC 或 iOS MobileVLCKit。
- 本地主 Renderer、SQLite、主题、通知和平台插件。

移动产物检查会拒绝远程 Web/网关资源、FFmpeg、FFprobe、HLS/转码、托管 qBittorrent 和桌面证书材料；同时强制 Android 包含 ARM64 `libani_torrent_core.so`、LibVLC JNI 运行库，iOS 包含 `AniTorrentCore.framework`、`MobileVLCKit.framework`，两端均必须携带应用、torrent-core 和 VLC 许可证。本地主 Renderer 与远程 PWA 使用独立入口和 API Adapter；Vite 在模块图阶段拒绝本地包引入远程页面、远程 HTTP 客户端、ArtPlayer 或 HLS.js，并为产物写入可复核的边界证明。

## 本地命令

```powershell
# 当前桌面平台
pnpm.cmd run package:desktop

# Android
pnpm.cmd run package:tauri:android:debug
pnpm.cmd run package:tauri:android

# iOS，仅 macOS
pnpm.cmd run package:tauri:ios
```

Android 正式命令只生成 ARM64 自签 APK，不再生成应用市场使用的 AAB。iOS 命令先生成未签名 ARM64 设备 App，再按标准 `Payload/*.app` 结构封装为 IPA，并强制检查包内不存在 `_CodeSignature` 或 `embedded.mobileprovision`。

桌面正式打包前需按目标平台准备资源。CI 使用固定版本和摘要完成该步骤；本地可分别执行 `prepare:desktop-torrent-core-dev`、`prepare:qbittorrent`、`prepare:ffmpeg` 和对应 `prepare:tauri:*:libvlc` 命令。

## 发布验收

1. 校验 `manifest.json` 中版本、目标、文件大小和 SHA-256。
2. 验证 Windows/macOS 自签证书指纹、Android APK 自签证书，以及 iOS IPA 保持未签名且可由用户重签。
3. 从上一公开版本升级，确认旧 SQLite 只复制迁移、备份存在且追番/下载/播放进度不丢失。
4. 桌面包确认 torrent-core、qBittorrent-nox、libVLC、FFmpeg/FFprobe、远程 PWA 和许可证完整。
5. 移动包确认 torrent-core、libVLC、主题与本地通知完整，并通过禁止内容检查。
6. 运行确定性种子的添加、文件选择、暂停、恢复、重启恢复和删除流程。
7. 运行 H.264、HEVC 10bit、HDR、ASS、字幕、音轨、倍速、横竖屏、续播和自动下一集矩阵。
8. 完成低存储、权限拒绝、网络切换、后台恢复和退出资源回收验证。
9. 复核第三方许可证、源码获取说明、病毒扫描和 Release 文件列表后再公开版本。

Windows 之外的桌面平台以及 Android/iOS 原生功能由项目负责人手动验收；CI 构建和产物校验只提供验收输入，不替代签名安装、真机生命周期与媒体矩阵签收。

Windows 目标机器需先信任随发布提供的 `.cer` 公钥证书；Android 允许未知来源安装且升级必须沿用同一 JKS。macOS 目标机器需信任随发布提供的 PEM，首次运行仍可能需要移除隔离属性或在系统设置中确认。iOS IPA 不能直接安装，用户需使用自己的 Apple ID 或证书通过 AltStore、Sideloadly、Xcode 等工具重签。

## 回退

Electron/Capacitor 不再参与发布。宿主迁移前最后回退标签为 `legacy-hosts-final`，对应提交为 `6caf060f7247576f0f2f49d6ba9892e1149ed236`，归档清单见 `archive/legacy-hosts/README.md`。回退必须从该标签创建独立分支，不能把归档源码混入当前 Tauri 发布链。
