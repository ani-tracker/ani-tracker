# Ani Tracker

Ani Tracker 是基于 Tauri 2 的本地优先追番、资源搜索、BT 下载与媒体播放应用，支持 Windows、macOS、Linux、Android 和 iOS/iPadOS。

桌面端提供完整业务、媒体扫描、转码、远程 HTTPS 网关和系统集成；移动端保留发现、追番、来源、搜索、内置下载、原生 libVLC 播放、提醒、设置与主题，仅排除远程 Web/网关、FFmpeg/FFprobe、转码和无移动语义的桌面能力。

> Copyright (c) 2026 Ani Tracker contributors. 本项目源码免费公开，仅限个人及其他非商业用途；未经版权所有者书面许可，禁止商业使用。

## 核心能力

- 新番发现：合并 Bangumi、AniList、Mikan 元数据，支持季度、月份、搜索与详情刷新。
- 追番管理：状态、单集、字幕组、自动下载、画质、编码、字幕语言和目录偏好。
- 资源搜索：RSS、Torznab、DMHY、Mikan、AniBT、ACGNX、Nyaa、ACG.RIP，含限流、缓存、熔断和候选评分。
- 下载：内置 libtorrent `torrent-core`、外部 qBittorrent Web API；桌面额外支持托管 qBittorrent-nox。
- 播放：桌面 Rust libVLC、Android LibVLC、iOS MobileVLCKit，支持字幕、音轨、倍速、比例、续播、已看与自动下一集。
- 自动化：来源增量同步、自动扫描、自动下载、本地通知和提醒中心。
- 主题：跟随系统、浅色、深色、内置主题及自定义主题导入导出，桌面和移动共用语义令牌。
- 桌面专属：FFmpeg/FFprobe、媒体扫描、远程 HTTPS 网关、ArtPlayer/HLS、托盘、开机启动、外部播放器和文件管理器。

## 架构

```text
React / TypeScript / Tailwind / shadcn UI
                  |
               AppClient
                  |
          Tauri invoke / events
                  |
ani-contracts / ani-domain / ani-repository
ani-storage / ani-sources / ani-downloads
ani-media / ani-automation / ani-remote
                  |
SQLite / torrent-core / libVLC / platform adapters
```

业务服务依赖 `ani-repository` 中的 Repository Ports 与 UnitOfWork，不依赖 SQLite 类型。SQLite 是桌面与移动的默认本地 Adapter；未来 MySQL 应作为独立 Adapter 或服务端存储接入，不改变 Tauri commands、`AppClient` 或页面。

React 页面只通过 `AppClient` 访问业务能力。移动端不会回退到桌面远程页面，桌面远程 PWA 也不会获得本地命令权限。

## 技术栈

- Tauri 2、Rust 1.97、React 18、TypeScript、Vite
- Tailwind CSS、shadcn/ui 风格组件、lucide-react
- SQLite、Repository Ports、版本化迁移与备份
- libtorrent-rasterbar、qBittorrent Web API、qBittorrent-nox
- libVLC 3、LibVLC for Android、MobileVLCKit
- 桌面 FFmpeg/FFprobe、ArtPlayer、hls.js
- pnpm、Cargo、Node.js `node:test`

## 关键目录

```text
src-tauri                         Tauri 宿主、commands、生命周期与平台装配
crates/ani-*                     Rust 契约、领域、仓库、存储、来源、下载和媒体核心
crates/tauri-plugin-ani-*        Android/iOS torrent、播放器和移动平台插件
src/renderer/src                 桌面与移动 React UI，以及桌面远程 PWA 页面
src/shared                       TypeScript 共享领域模型与契约
native/torrent-core              桌面 sidecar 与移动原生核心共用的 C++ 运行时
resources                        libVLC、FFmpeg、qBittorrent 和许可证资源
archive/legacy-hosts             已退役 Electron/Capacitor 宿主，只读归档
docs                             架构、启动、发布、进度和专项计划
```

## 环境准备

推荐 Node.js 22、pnpm 10.34.5、Rust 1.97.1。桌面原生依赖和移动工具链见 [启动说明](docs/startup.md)。

```powershell
pnpm.cmd install --frozen-lockfile
```

## 常用命令

```powershell
# 桌面开发与构建
pnpm.cmd dev
pnpm.cmd build
pnpm.cmd run package:desktop

# Renderer
pnpm.cmd run dev:tauri:renderer
pnpm.cmd run build:tauri:desktop-renderers

# Android / iOS
pnpm.cmd run dev:tauri:android
pnpm.cmd run package:tauri:android
pnpm.cmd run dev:tauri:ios
pnpm.cmd run package:tauri:ios

# 门禁
pnpm.cmd run typecheck
pnpm.cmd run test:parsers
pnpm.cmd run test:theme
pnpm.cmd run test:rust
pnpm.cmd run lint:rust
```

`dev`、`build` 和 `package:desktop` 均以 Tauri 为唯一正式宿主。Electron/Capacitor 源码与依赖不参与当前构建；最后回退点和依赖清单见 [旧宿主归档](archive/legacy-hosts/README.md)。

## 平台边界

| 能力 | 桌面 | Android / iOS |
| --- | --- | --- |
| 本地 SQLite、追番、来源和搜索 | 支持 | 支持 |
| 内置 torrent-core | 支持 | 支持 |
| 外部 qBittorrent Web API | 支持 | 支持 |
| 托管 qBittorrent-nox | 支持 | 不适用 |
| 内置 libVLC 播放 | 支持 | 支持 |
| 主题与本地通知 | 支持 | 支持 |
| FFmpeg、FFprobe、扫描与转码 | 支持 | 不打包 |
| 远程 HTTPS 网关与远程 PWA | 支持 | 不打包 |
| 托盘、开机启动和外部播放器路径 | 支持 | 不适用 |

移动应用在桌面离线时仍可独立完成发现、追番、搜索、下载、播放和进度回写。iOS 下载遵循系统后台限制，不承诺应用被挂起后持续传输。

## 远程访问

远程 PWA 仅由桌面 Tauri 应用托管。启用“设置 -> 远程设备”后，使用本地 CA、一次性配对码和设备令牌建立 HTTPS 连接。远程播放支持 Range、字幕、播放列表和 FFmpeg HLS 回退；移动安装包不会携带这套页面或网关。

## 发布

`.github/workflows` 提供 Windows x64、macOS x64/arm64、Linux x64、Android arm64 和 iOS arm64 发布工作流。正式发布要求对应签名凭据，并为每组产物生成 SHA-256 与 JSON 清单。详见 [发布说明](docs/release-build.md)。

## 当前验证边界

Rust 工作区、Clippy、格式、TypeScript、共享契约测试、主题检查和两个 Renderer 构建已纳入门禁。原生 Android/iOS 编译、签名安装包和真机媒体矩阵按计划在对应平台统一验证，不能用 Windows 结果替代。

## 文档

- [总体设计](docs/design-plan.md)
- [实现进度](docs/progress.md)
- [启动与故障排查](docs/startup.md)
- [跨平台发布](docs/release-build.md)
- [Tauri 2 迁移记录](docs/tauri-2-migration-plan.md)
- [主题系统](docs/theme-system-progress.md)

## 版权与许可

Ani Tracker 原创源码采用 [PolyForm Noncommercial License 1.0.0](LICENSE)。允许个人学习、研究、娱乐及其他非商业用途使用、修改和分发；必须保留 [NOTICE](NOTICE) 与许可证。第三方组件继续遵循各自许可证。
