# 脚本说明

本目录只保留 Tauri、Rust 原生资源和发布链使用的脚本。已退役 Electron/Capacitor 脚本位于 `archive/legacy-hosts`，不应从当前分支执行。

## 日常入口

优先通过 `package.json` 调用：

```powershell
pnpm.cmd dev
pnpm.cmd build
pnpm.cmd run package:desktop
pnpm.cmd run typecheck
pnpm.cmd run test:parsers
pnpm.cmd run test:theme
pnpm.cmd run test:rust
pnpm.cmd run lint:rust
```

## torrent-core

| 脚本 | 用途 |
| --- | --- |
| `prepare-desktop-torrent-core-dev.mjs` | Windows/macOS 准备依赖、构建并验证桌面核心 |
| `prepare-android-torrent-dependencies.sh` | 交叉构建 Android Boost/OpenSSL/libtorrent 依赖 |
| `prepare-ios-torrent-core.sh` | 构建 iOS C ABI 与 XCFramework |
| `package-torrent-core-bundle.mjs` | 整理桌面 bundle 与依赖 |
| `create-torrent-core-manifest.mjs` | 生成版本和 SHA-256 清单 |
| `prepare-torrent-core-resources.mjs` | 校验并复制目标平台资源 |

## qBittorrent

| 脚本 | 用途 |
| --- | --- |
| `prepare-qbittorrent-build-sources.mjs` | 准备固定版本源码与摘要 |
| `build-qbittorrent-nox-windows.ps1` | 构建 Windows 无头运行时 |
| `build-qbittorrent-nox-unix.sh` | 构建 macOS/Linux 无头运行时 |
| `package-qbittorrent-bundle.mjs` | 整理可分发 bundle |
| `verify-qbittorrent-bundle.mjs` | 校验版本、依赖、许可证和 WebUI |
| `prepare-qbittorrent-resources.mjs` | 将目标资源复制到 `out/qbittorrent` |
| `smoke-managed-qbittorrent.mjs` | 验证受管进程登录、任务 API 与退出 |

## FFmpeg 与 libVLC

| 脚本 | 用途 |
| --- | --- |
| `download-ffmpeg-resources.mjs` | 显式下载固定 FFmpeg/FFprobe 资源 |
| `prepare-ffmpeg-resources.mjs` | 离线校验并整理桌面资源 |
| `download-libvlc-archive.mjs` | 下载并验证官方 VLC 归档 |
| `prepare-*-libvlc-dev.mjs` | 按 Windows/macOS/Linux 整理运行时并执行 Rust FFI 冒烟 |
| `prepare-ios-libvlc.sh` | 准备 MobileVLCKit XCFramework |
| `prepare-libvlc-resources.mjs` | 统一运行时布局、来源与许可证校验 |

桌面 libVLC 直接由 Rust C API Adapter 加载，不存在 Node 原生模块或宿主 ABI 重建。

## Tauri 与发布

| 脚本 | 用途 |
| --- | --- |
| `prepare-tauri-desktop-runtime.mjs` | 构建远程 Renderer并准备当前平台 libVLC |
| `verify-tauri-mobile-package.mjs` | 检查 APK/AAB/IPA 必需内容与禁止内容 |
| `set-tauri-release-version.mjs` | 同步发布版本 |
| `create-tauri-release-manifest.mjs` | 生成发布产物 SHA-256 与 JSON 清单 |
| `stop-workspace-processes.ps1` | 仅停止当前工作区的 Tauri/sidecar 进程 |

## 验证脚本

- `run-node-tests.mjs`：编译并使用 Node 执行 `src/shared/__tests__`。
- `verify-theme-contrast.mjs`：校验浅色、深色主题令牌和对比度。

## 约束

- 下载脚本必须固定版本与 SHA-256，不得静默使用最新版本。
- 资源脚本必须保留来源、许可证和目标架构信息。
- 移动包不得包含远程 PWA、FFmpeg/FFprobe、转码或 qBittorrent-nox。
- 临时目录、缓存、`out/`、Rust target 和平台构建目录不得提交。
