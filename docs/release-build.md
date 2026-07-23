# 跨平台应用打包与发布

最近更新：2026-07-23

## 交付矩阵

| 目标 | GitHub runner | 内置核心 | 应用产物 |
| --- | --- | --- | --- |
| Windows x64 | `windows-2022` | `torrent-core.exe` | NSIS `.exe`、`.zip` |
| macOS x64 | `macos-15-intel` | `torrent-core` | `.dmg`、`.zip` |
| macOS arm64 | `macos-15` | `torrent-core` | `.dmg`、`.zip` |
| Linux x64 | `ubuntu-22.04` | `torrent-core` | `.AppImage`、`.deb` |
| Android arm64-v8a | `ubuntu-22.04` + NDK | `libani_torrent_core.so` | Debug `.apk`、签名 Release `.apk/.aab`、`.aar` |

桌面流程位于 `.github/workflows/torrent-core-desktop.yml`，Android 流程位于 `.github/workflows/torrent-core-android.yml`。手动运行会把结果保存为 Actions Artifacts；推送 `v*` 标签后会创建或更新 GitHub 草稿 Release，并附带桌面与 Android SHA-256 清单，签收后再公开。

## 发布密钥

仓库不保存证书、私钥或密码。正式发布前在 GitHub Actions Secrets 配置：

| Secret | 用途 |
| --- | --- |
| `MAC_CSC_LINK` | macOS Developer ID Application 证书 `.p12` 的 Base64 或安全下载地址 |
| `MAC_CSC_KEY_PASSWORD` | macOS 证书密码 |
| `APPLE_ID` | Apple 公证账号 |
| `APPLE_APP_SPECIFIC_PASSWORD` | Apple 专用密码 |
| `APPLE_TEAM_ID` | Apple Developer Team ID |
| `WIN_CSC_LINK` | Windows 代码签名证书 `.pfx` 的 Base64 或安全下载地址 |
| `WIN_CSC_KEY_PASSWORD` | Windows 证书密码 |
| `ANDROID_KEYSTORE_BASE64` | Android upload keystore 的 Base64 |
| `ANDROID_KEY_ALIAS` | Android key alias |
| `ANDROID_KEYSTORE_PASSWORD` | Android keystore 密码 |
| `ANDROID_KEY_PASSWORD` | Android key 密码 |

Android 未配置密钥时只生成可安装的 Debug APK与 AAR，不生成 Release APK/AAB，也不会把 Debug APK放入 GitHub Release。

## 构建链路

桌面 runner 先编译固定 SHA-256 的 libtorrent 2.1.0 与 `torrent-core`，生成许可证和哈希清单并执行真实 `status/shutdown` 握手；随后只把当前目标资源复制到 `out/torrent-core`，最后由 electron-builder 打入应用 `resources/torrent-core`。

Android 使用 NDK 27、vcpkg 交叉编译 Boost/OpenSSL，CMake 编译同一核心运行时和 JNI。Gradle 在 AAR、APK 与 AAB 中仅加入 `arm64-v8a`，并校验 JNI `.so` 与许可证。APK 当前是下载核心控制宿主，用于前台服务、JNI、恢复和真机验收；完整移动追番界面仍需后续独立实现。

Android 与 iOS 均不提供远程 Renderer 和媒体转码。移动包不得包含 `.remote-pwa`、FFmpeg、FFprobe 或转码服务；Android CI 会对 APK/AAR 执行负向内容检查，后续 iOS 打包也必须采用同一验收规则。桌面包继续保留远程访问和按需转码能力。

## 发布验收

1. 各桌面包离线安装后无需安装 qBittorrent即可启动内置核心。
2. Windows、macOS 两种架构和 Linux 均完成磁链下载、暂停、恢复与重启恢复。
3. Android 真机允许通知后可启动前台服务，APK 内 ABI 为 `arm64-v8a`，杀进程后任务可恢复。
4. 草稿 Release 中的文件先完成签名、公证、病毒扫描和 SHA-256 复核，再转为公开版本。
