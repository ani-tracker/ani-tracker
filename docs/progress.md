# Ani Tracker 实现状态

最近核对：2026-07-26

## 总体状态

Tauri 2 迁移 P0-P8 的代码实施已完成。Tauri 是 Windows、macOS、Linux、Android 和 iOS 的唯一正式宿主；Electron/Capacitor 源码、配置、脚本和依赖已退出活跃构建链并归档。

| 项目 | 当前状态 |
| --- | --- |
| 应用宿主 | Tauri 2 |
| 持久化 | SQLite；数据版本 22，Schema 版本 18 |
| 数据边界 | Repository Ports + UnitOfWork；预留 MySQL Adapter |
| 桌面平台 | Windows、macOS、Linux |
| 移动平台 | Android、iOS/iPadOS |
| 内置下载 | 桌面 sidecar；Android JNI；iOS C ABI/XCFramework |
| 内置播放 | 桌面 libVLC；Android LibVLC；iOS MobileVLCKit |
| 主题 | 跟随系统、浅色、深色、内置与自定义主题，全平台保留 |
| 远程访问 | 仅桌面 Tauri HTTPS 网关与远程 PWA |
| 旧宿主 | `archive/legacy-hosts`，不参与构建 |

## 已实现

### 数据与核心业务

- Rust DTO、领域服务、数据库无关 Repository Ports、稳定错误、UnitOfWork 与 SQLite Adapter。
- SQLite WAL、外键、busy timeout、事务、版本化迁移、迁移前备份、完整性检查和失败恢复。
- 旧桌面数据库只复制迁移，不删除原数据；移动端使用各自应用私有目录。
- 设置、通知、首页、追番、单集、播放进度、新番目录、详情和来源绑定完整接入 Tauri commands。
- Bangumi、AniList、Mikan 元数据，以及 RSS、Torznab、AniBT、DMHY、ACGNX、Nyaa、ACG.RIP 来源。
- 限流、代理、缓存、熔断、增量同步、自动扫描、候选评分、自动下载和提醒。

### 下载与媒体

- 统一下载引擎和状态服务，支持添加、暂停、恢复、删除、文件优先级、限速、做种目标和重启恢复。
- 桌面内置 torrent-core、外部 qBittorrent、托管 qBittorrent-nox。
- Android/iOS 内置 torrent-core 生命周期、恢复目录、前后台保存和移动资源约束。
- 桌面 FFprobe/FFmpeg、媒体关联、扫描、外部播放器、定位文件和远程媒体服务。
- 桌面、Android、iOS 原生 libVLC 会话，支持播放控制、字幕、音轨、倍速、比例、续播、90% 已看和自动下一集。

### 平台与发布

- 桌面托盘、关闭到托盘、开机启动、系统通知、窗口状态、外部链接和主题同步。
- Android 生命周期、前台下载服务、WorkManager、Keystore、通知导航、文件导入导出和低存储保护。
- iOS 生命周期、BGTask 补跑、Keychain、安全作用域文件、通知导航和备份恢复。
- 移动设置保留完整业务与主题；隐藏并强制关闭 FFmpeg/FFprobe、转码、远程网关和桌面进程能力。
- Windows/Android 自签、macOS 临时签名、iOS 未签名可重签包的发布工作流，以及 SHA-256、JSON 产物清单和独立 actionlint 门禁。
- 本地主 Renderer 与远程 PWA 已拆分入口和 API Adapter；移动构建的模块图会拒绝远程页面、ArtPlayer、HLS.js 与远程转码客户端。
- 全平台 Logo 已替换，Tauri 与生成的 Android/iOS 工程使用统一品牌资源。

## 验证结果

2026-07-26 非原生门禁：

| 检查 | 结果 |
| --- | --- |
| `pnpm.cmd run typecheck` | 通过 |
| `pnpm.cmd run test:parsers` | 40/40 通过；退役 Node 主进程测试不再进入活跃入口 |
| `pnpm.cmd run test:theme` | 浅色/深色各 38 个令牌通过 |
| `pnpm.cmd run test:mobile-package` | iOS 未签名可重签包策略 4/4 通过 |
| Tauri 主 Renderer | 生产构建通过 |
| 桌面远程 Renderer | 生产构建通过 |
| Renderer 模块边界 | 本地 313 个模块、远程 245 个模块通过 |
| Rust workspace 测试 | 通过 |
| Rustfmt / Clippy | 通过 |
| YAML 工作流解析 | 通过 |

## 后续统一验证

- Windows、macOS、Linux 的安装包、升级、资源内容和实际 libVLC 播放。
- Android 自签 APK 与 iOS 未签名 IPA 的原生编译、用户重签、负向内容检查和真机生命周期。
- H.264、HEVC 10bit、HDR、ASS、外挂字幕、多音轨、横竖屏和自动下一集媒体矩阵。
- 公网 BT、网络切换、磁盘满、损坏恢复数据和移动后台限制。
- Linux 原生 Wayland 嵌入；首期正式范围为 X11/XWayland。

上述项目是平台发布验收，不再阻塞宿主迁移代码收口。Windows 之外的桌面平台与 Android/iOS 原生功能由项目负责人手动验收，CI 产物作为验收输入。

## 验证入口

```powershell
pnpm.cmd run typecheck
pnpm.cmd run test:parsers
pnpm.cmd run test:theme
pnpm.cmd run build:tauri:desktop-renderers
pnpm.cmd run test:rust
pnpm.cmd run lint:rust
git diff --check
```
