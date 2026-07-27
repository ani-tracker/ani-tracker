# Ani Tracker 实现状态

最近核对：2026-07-27

## 总体状态

Tauri 2 迁移 P0-P8 的代码实施已完成。Tauri 是 Windows、macOS、Linux、Android 和 iOS 的唯一正式宿主；Electron/Capacitor 源码、配置、脚本和依赖已退出活跃构建链并归档。

| 项目 | 当前状态 |
| --- | --- |
| 应用宿主 | Tauri 2 |
| 持久化 | SQLite；数据版本 23，Schema 版本 18 |
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
- Android/iOS 系统外链使用原生浏览器能力，并在 Rust 与原生端同时拒绝非 HTTP/HTTPS、无主机或携带凭据的地址。
- 移动设置保留完整业务与主题；隐藏并强制关闭 FFmpeg/FFprobe、转码、远程网关和桌面进程能力。
- Windows/Android/macOS 长期自签、iOS 未签名可重签包的发布工作流，以及 SHA-256、JSON 产物清单和独立 actionlint 门禁；Android Gradle Release 缺少长期 JKS 时会直接失败。
- Android/iOS 持续门禁会在相关推送和 Pull Request 上真实编译移动产物、编译原生策略测试，并执行 Renderer 与安装包内容边界检查。
- 本地主 Renderer 与远程 PWA 已拆分入口和 API Adapter；移动构建的模块图会拒绝远程页面、ArtPlayer、HLS.js 与远程转码客户端。
- 全平台 Logo 已替换，Tauri 与生成的 Android/iOS 工程使用统一品牌资源。
- 已增加旧宿主防回流门禁，持续拒绝 Electron/Capacitor 依赖、脚本、活跃路径和 Renderer bridge 重新进入正式构建链。

### 历史数据兼容

- 数据版本 23 会把历史空值或超过 200 字符的资源标识迁移为稳定短标识，并同步修复下载任务、单集偏好和资源记录关联。
- Bug 清单第 13–15 项均由历史 `downloadTask.releaseId` 超限触发，已归并到同一迁移回归；第 12 项与既有播放器路径、虚拟列表回顶修复重复，不新增重复实现。

## 验证结果

2026-07-27 全量收口门禁：

| 检查 | 结果 |
| --- | --- |
| `pnpm.cmd run typecheck` | 通过 |
| `pnpm.cmd run test:parsers` | 49/49 通过；退役 Node 主进程测试不再进入活跃入口 |
| `pnpm.cmd run test:theme` | 浅色/深色各 38 个令牌通过 |
| `pnpm.cmd run test:desktop-gates` | 桌面资源、libVLC 与发布工作流门禁 14/14 通过 |
| `pnpm.cmd run test:mobile-package` | 移动原生能力、许可证、持续构建、ARM64、自签与 iOS 未签名策略 33/33 通过 |
| `pnpm.cmd run test:retired-hosts` | 旧宿主门禁单元测试 7/7 通过 |
| `pnpm.cmd run verify:tauri:retired-hosts` | Electron/Capacitor 依赖、脚本、路径与活跃源码边界通过 |
| Tauri 主 Renderer | 生产构建通过 |
| 桌面远程 Renderer | 生产构建通过 |
| Renderer 模块边界 | 本地 316 个模块、远程 256 个模块通过 |
| Rust workspace 测试 | 162 项与 Doc tests 通过 |
| Rustfmt / Clippy | 通过 |
| `actionlint 1.7.12` | 全部 GitHub Actions 工作流通过 |
| Android 原生策略测试 | `testDebugUnitTest` 构建与测试通过 |

2026-07-27 本地原生产物：

| 目标 | 结果 |
| --- | --- |
| macOS x64 | DMG 生成并通过资源闭合检查；164754428 bytes；SHA-256 `24fee9a5d627c41e3f9392154ba30d382cd4ddb1b0177d27dbf01d9a2fb4aacd`；本机验证件未签名 |
| Android ARM64 Debug | APK 生成，仅含 `arm64-v8a`，包内容门禁通过；852444704 bytes；SHA-256 `2cac9c4d00db79541f7b717b1c80dc3d27d858bfee1c116c386c7f0d0bf12fa3` |
| iOS ARM64 | 用户重签 IPA 生成且保持未签名，包内容门禁通过；60311347 bytes；SHA-256 `295fb639d7d2f6f2e1fc71700ccb20b51319aee1dff665c73f5f568b3272f2bc` |

## 后续统一验证

- Windows、Linux 的安装包构建，以及 Windows/macOS 的正式自签、升级安装和实际 libVLC 播放。
- Android 正式自签 APK 安装升级、iOS 用户重签安装和两端真机生命周期。
- H.264、HEVC 10bit、HDR、ASS、外挂字幕、多音轨、横竖屏和自动下一集媒体矩阵。
- 公网 BT、网络切换、磁盘满、损坏恢复数据和移动后台限制。
- Linux 原生 Wayland 嵌入；首期正式范围为 X11/XWayland。

上述项目是平台发布验收，不再阻塞宿主迁移代码收口。Windows 之外的桌面平台与 Android/iOS 原生功能由项目负责人手动验收，CI 产物作为验收输入。

## 验证入口

```powershell
pnpm.cmd run typecheck
pnpm.cmd run test:parsers
pnpm.cmd run test:theme
pnpm.cmd run test:retired-hosts
pnpm.cmd run verify:tauri:retired-hosts
pnpm.cmd run build:tauri:desktop-renderers
pnpm.cmd run test:rust
pnpm.cmd run lint:rust
git diff --check
```
