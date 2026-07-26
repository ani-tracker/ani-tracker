# Tauri 跨平台打包与发布

最近更新：2026-07-26

## 发布工作流

| 工作流 | 目标 | 正式产物 |
| --- | --- | --- |
| `tauri-release-desktop.yml` | Windows x64 | 签名 NSIS `.exe`、MSI `.msi` |
| `tauri-release-desktop.yml` | macOS x64/arm64 | 签名、公证 `.dmg` |
| `tauri-release-desktop.yml` | Linux x64 | `.deb`、`.AppImage` |
| `tauri-release-android.yml` | Android arm64 | 签名 `.apk`、`.aab` |
| `tauri-release-ios.yml` | iOS arm64 | 签名归档/IPA 产物 |

工作流支持 `workflow_dispatch` 和 `v*` 标签。版本必须符合语义版本，发布脚本会同步 `package.json`、Tauri 配置与 Cargo 包版本，并为每组产物生成 SHA-256 和版本化 `manifest.json`。

## 签名凭据

仓库不保存证书、私钥或密码。正式发布必须配置对应 GitHub Actions Secrets；非 Linux 任务缺少任一必需值都会失败。

### Windows

- `WINDOWS_CERTIFICATE_BASE64`
- `WINDOWS_CERTIFICATE_PASSWORD`

### macOS

- `MACOS_CERTIFICATE_BASE64`
- `MACOS_CERTIFICATE_PASSWORD`
- `APPLE_SIGNING_IDENTITY`
- `APPLE_ID`
- `APPLE_APP_SPECIFIC_PASSWORD`
- `APPLE_TEAM_ID`

### Android

- `ANDROID_KEYSTORE_BASE64`
- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_ALIAS`
- `ANDROID_KEY_PASSWORD`

### iOS

- `IOS_CERTIFICATE_BASE64`
- `IOS_CERTIFICATE_PASSWORD`
- `IOS_PROVISIONING_PROFILE_BASE64`
- `IOS_KEYCHAIN_PASSWORD`

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

移动产物负向检查会拒绝远程 Web/网关资源、FFmpeg、FFprobe、HLS/转码、托管 qBittorrent 和桌面证书材料。

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

桌面正式打包前需按目标平台准备资源。CI 使用固定版本和摘要完成该步骤；本地可分别执行 `prepare:desktop-torrent-core-dev`、`prepare:qbittorrent`、`prepare:ffmpeg` 和对应 `prepare:tauri:*:libvlc` 命令。

## 发布验收

1. 校验 `manifest.json` 中版本、目标、文件大小和 SHA-256。
2. 验证 Windows/macOS 签名与 macOS 公证；Android/iOS 验证签名、应用标识和权限。
3. 从上一公开版本升级，确认旧 SQLite 只复制迁移、备份存在且追番/下载/播放进度不丢失。
4. 桌面包确认 torrent-core、qBittorrent-nox、libVLC、FFmpeg/FFprobe、远程 PWA 和许可证完整。
5. 移动包确认 torrent-core、libVLC、主题与本地通知完整，并通过禁止内容检查。
6. 运行确定性种子的添加、文件选择、暂停、恢复、重启恢复和删除流程。
7. 运行 H.264、HEVC 10bit、HDR、ASS、字幕、音轨、倍速、横竖屏、续播和自动下一集矩阵。
8. 完成低存储、权限拒绝、网络切换、后台恢复和退出资源回收验证。
9. 复核第三方许可证、源码获取说明、病毒扫描和 Release 文件列表后再公开版本。

## 回退

Electron/Capacitor 不再参与发布。宿主迁移前最后回退提交为 `6caf060`，归档清单见 `archive/legacy-hosts/README.md`。回退必须从该提交创建独立分支，不能把归档源码混入当前 Tauri 发布链。
