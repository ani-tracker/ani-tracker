# Ani Tracker 启动与故障排查

最近核对：2026-07-26

## 环境要求

- Node.js 22、pnpm 10.34.5。
- Rust 1.97.1，以及当前平台的 Tauri 2 系统依赖。
- Windows：Visual Studio 2022 C++ Build Tools、WebView2、CMake/Ninja。
- macOS：Xcode Command Line Tools；iOS 还需要完整 Xcode、CocoaPods 和签名环境。
- Linux：WebKitGTK 4.1、AppIndicator、X11、OpenSSL、VLC 3、FFmpeg、rustup 和构建工具；Debian/Ubuntu 会在首次桌面启动时自动检查并通过 APT 补齐，Rust 版本继续由 `rust-toolchain.toml` 固定。
- Android：JDK 17+、Android SDK 35、NDK `27.2.12479018`、Rust Android targets。

安装 JavaScript 依赖：

```powershell
pnpm.cmd install --frozen-lockfile
```

`pnpm-workspace.yaml` 只允许 `esbuild` 执行安装脚本。SQLite、libVLC 和 torrent-core 均由 Rust/原生构建链负责，不存在 Node 原生 ABI 重建步骤。

## 桌面开发

```powershell
pnpm.cmd dev
```

`dev` 会准备当前平台 libVLC、构建桌面远程 Renderer，再启动 `tauri dev`。Linux 首次运行会执行 `prepare:tauri:linux-deps`，仅在系统包缺失时通过 `sudo apt-get` 安装桌面编译、打包、中文字体和 Secret Service 依赖；可先用 `pnpm run prepare:tauri:linux-deps -- --check` 只检查而不安装。Linux 开发构建会从固定源码构建并整理 torrent-core，为尚未准备的托管 qBittorrent 创建空资源边界；正式打包校验仍要求所有发布二进制完整。FFmpeg/FFprobe 使用系统依赖。Windows/macOS 的 libVLC 步骤可能联网下载固定摘要的官方归档，Linux 使用系统提供的 VLC 3.0.x。

WSL 没有可无提示解锁的默认 Secret Service collection。WSL 运行时会在当前用户的 `userData/remote-secrets` 下自动生成独立随机主密钥并强制使用 `0600` 权限；Windows、macOS 和原生 Linux 继续使用系统凭据库。

只调试 React Renderer：

```powershell
pnpm.cmd run dev:tauri:renderer
```

此入口没有 Tauri command，业务调用会失败，仅适合布局和静态状态调试。

## 移动开发

```powershell
# Android
pnpm.cmd run dev:tauri:android
pnpm.cmd run package:tauri:android:debug

# iOS，仅 macOS
pnpm.cmd run init:tauri:ios
pnpm.cmd run dev:tauri:ios
```

Android/iOS 正式构建会先准备移动 torrent-core；iOS 同时准备 MobileVLCKit。移动包不生成远程 Renderer，也不复制 FFmpeg/FFprobe、HLS 转码或 qBittorrent-nox。

## 检查与测试

```powershell
pnpm.cmd run typecheck
pnpm.cmd run test:parsers
pnpm.cmd run test:theme
pnpm.cmd run build:tauri:desktop-renderers
pnpm.cmd run test:rust
pnpm.cmd run lint:rust
```

- `typecheck` 使用 `noEmit`，不应生成 `.js`、`.d.ts` 或 `*.tsbuildinfo`。
- `test:parsers` 使用当前 Node 运行共享契约测试，输出目录为 `out/test-node`。
- `test:theme` 校验浅色与深色主题令牌和对比度。
- `lint:rust` 同时执行 rustfmt 检查和 Clippy `-D warnings`。

## 构建与输出

```powershell
# 当前桌面平台，不生成安装器
pnpm.cmd build

# 当前桌面平台安装包
pnpm.cmd run package:desktop

# 两个 Renderer
pnpm.cmd run build:tauri:desktop-renderers
```

主要生成目录：

```text
out/tauri/                         本地主 Renderer
.tauri-remote-pwa/                 桌面远程 Renderer
out/cargo-target/release/          Tauri/Rust 二进制
out/cargo-target/release/bundle/   桌面安装包
out/torrent-core/                  桌面原生下载核心
out/qbittorrent/                   桌面托管 qBittorrent
out/ffmpeg/                        桌面 FFmpeg/FFprobe
out/libvlc/                        桌面 libVLC
src-tauri/gen/android/             Tauri Android 工程与产物
src-tauri/gen/apple/               Tauri iOS 工程与产物
```

## 资源维护

```powershell
pnpm.cmd run verify:torrent-core:all
pnpm.cmd run verify:qbittorrent
pnpm.cmd run verify:ffmpeg
pnpm.cmd run verify:libvlc
```

`download:ffmpeg`、`download:libvlc` 和原生依赖准备脚本属于显式资源维护或发布步骤。正式发布应校验固定版本、SHA-256、依赖闭合和许可证。

## 故障排查

### Tauri 开发模式白屏

1. 确认 `pnpm.cmd run build:tauri:renderer` 可完成。
2. 检查 WebView 开发者工具中的首个运行时错误。
3. 检查终端中 Tauri command、资源路径或 SQLite 初始化错误。
4. 确认 `window.__TAURI_INTERNALS__` 存在；普通浏览器不会获得本地能力。
5. 若只有业务数据失败，检查应用日志而不是仅检查页面资源。

### 下载或播放器运行时缺失

- 执行 `prepare:tauri:desktop-runtime`，确认 `out/torrent-core`、`out/qbittorrent`、`out/ffmpeg` 和 `out/libvlc` 对应当前平台架构。
- 使用 `verify:torrent-core`、`verify:qbittorrent`、`verify:ffmpeg`、`verify:libvlc` 定位缺失资源。
- Windows DLL、macOS dylib 或 Linux so 必须与当前 CPU 架构匹配；不要混用其他平台缓存。

### 构建资源被占用

托管 qBittorrent、torrent-core 或 Ani Tracker 可能占用 `out` 下资源。确认没有活动下载，优先从应用正常退出，再运行：

```powershell
pwsh -NoProfile -File scripts/stop-workspace-processes.ps1 -Root .
```

该脚本只处理可执行路径位于当前工作区内的进程。

### 远程 HTTPS 无法连接

- 远程网关仅在桌面设置中显式启用。
- 使用设置页列出的私网 IP，并在客户端安装、信任当前本地 CA。
- 默认远程端口为 `18083`；托管 qBittorrent 默认端口为 `18080`。
- 重新构建远程页面：`pnpm.cmd run build:tauri:remote-renderer`。

### Android/iOS 本地能力被识别为桌面

- 确认使用 `tauri android/ios` 构建，而不是直接打开 Renderer URL。
- 检查构建日志中的 `TAURI_ENV_PLATFORM`。
- 移动 WebView 必须存在 Tauri bridge；未知 WebView 会被安全地识别为远程页面。

### 站点返回 403 或 429

检查全局代理、来源代理开关和熔断状态。保护期内不要高频强制刷新；应用不会轮换 IP 或模拟 Cloudflare Cookie。

## 产物约束

`out/`、`.tauri-remote-pwa/`、`out/test-node/`、Rust `target/`、Tauri 生成的构建目录、`*.tsbuildinfo` 和临时 JS/声明文件均不得提交。

Electron/Capacitor 故障排查已随旧宿主归档；当前代码不再支持其启动、构建或原生模块修复。
