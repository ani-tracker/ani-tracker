# Ani Tracker Tauri 2 全平台迁移计划

最近更新：2026-07-25

状态：P0 已完成，P1 待实施

## 1. 迁移目标

在当前 `master_android` 分支和现有代码基础上，将应用宿主从 Electron / Capacitor 逐步迁移到 Tauri 2，同时保留迁移期间可工作的旧入口，直到新入口通过完整功能验收。

目标平台：

| 平台 | 目标形态 | 功能边界 |
| --- | --- | --- |
| Windows | Tauri 2 桌面应用 | 保留全部桌面功能 |
| macOS | Tauri 2 桌面应用 | 保留全部桌面功能 |
| Linux | Tauri 2 桌面应用 | 保留全部桌面功能；播放器首期支持 X11/XWayland |
| Android | Tauri 2 移动应用 | 保留全部具有移动语义的业务与主题功能；不包含远程 Web/网关、转码和 FFprobe |
| iOS / iPadOS | Tauri 2 移动应用 | 保留全部具有移动语义的业务与主题功能；不包含远程 Web/网关、转码和 FFprobe |

完整业务闭环包括：新番发现、追番管理、来源配置、资源搜索、内置下载、文件选择、媒体关联、原生 VLC 播放、续播、已看状态、自动检查、通知和设置。

移动端必须具备以下本地原生能力，不允许降级为依赖桌面端或远程网页：

- Android 和 iOS 均随应用提供内置 `torrent-core`，支持添加磁链 / torrent、任务控制、文件优先级、状态恢复和下载完成关联。
- Android 使用 LibVLC for Android，iOS 使用 MobileVLCKit；两端播放器必须支持本地下载文件、直接网络媒体、外挂字幕、音轨、倍速、比例、续播和自动下一集。
- 移动应用离线于桌面端时仍可独立完成“发现、追番、搜索、下载、播放、进度回写”闭环。
- 移动端保留当前主题系统，包括浅色、深色、跟随系统、主题变量、用户主题选择和持久化；所有移动页面必须使用同一语义主题契约。

桌面端额外保留：

- 托管 qBittorrent、外部 qBittorrent 和内置 torrent-core。
- FFmpeg / FFprobe、媒体扫描、实时转码和桌面播放器选择。
- 托盘、窗口、主题、外部播放器、文件管理器和系统集成。
- 远程 HTTPS 网关、设备配对、远程 Renderer、远程播放和媒体代理。

移动端默认保留全部具有移动语义的业务能力，仅明确排除：

- `.remote-pwa`、远程 Renderer、局域网配对和远程播放器页面。
- 远程 HTTPS 网关、本地 CA、远程设备令牌和媒体代理服务。
- qBittorrent-nox 托管进程、托盘、开机启动和桌面窗口能力。
- FFmpeg / FFprobe、HLS 生成和实时转码；移动端使用 libVLC 完成媒体解析与直接播放。
- 任意桌面可执行文件路径。外部播放使用 Android Intent 或 iOS 系统能力。

上述裁剪不包含内置下载引擎和 libVLC 播放器；二者是移动端发布必需能力。

移动端功能矩阵：

| 能力 | Android / iOS |
| --- | --- |
| 首页、发现、追番、详情、单集和提醒 | 保留 |
| 来源管理、RSS、Torznab、站点搜索和匹配 | 保留 |
| 内置 torrent-core、任务控制和文件优先级 | 保留，发布必需 |
| 外部 qBittorrent Web API | 保留 |
| libVLC 本地/网络播放、字幕、音轨和续播 | 保留，发布必需 |
| 自动扫描、系统允许的后台调度和本地通知 | 保留 |
| 设置、主题、安全存储、备份、恢复和日志 | 保留 |
| 远程 Web 页面、配对、远程 HTTPS 网关和媒体代理 | 排除 |
| FFmpeg、FFprobe、HLS/实时转码 | 排除 |
| 托盘、桌面窗口控制、开机启动、可执行文件路径 | 平台不适用 |
| 托管 qBittorrent-nox 进程 | 平台不适用；保留外部 Web API 模式 |

## 2. 迁移原则

1. **并行迁移**：Tauri、Electron 和现有移动宿主在迁移期共存，禁止先删除旧入口再补功能。
2. **垂直闭环**：按可运行的业务链路迁移，不按目录一次性翻译 2.6 万行主进程代码。
3. **Rust 持有后台状态**：Repository、网络、下载编排、自动化和远程网关不能依赖 WebView 存活。
4. **React 只依赖 `AppClient`**：页面不直接调用 Tauri、Electron、Capacitor、SQL、文件或 shell API。
5. **窄命令面**：Tauri command 和移动插件只暴露业务命令，不向 Renderer 开放任意 SQL、任意路径或任意进程启动。
6. **契约先行**：TypeScript / Rust / Kotlin / Swift 使用版本化 JSON fixture 验证字段、默认值、错误码和状态机一致。
7. **保持数据兼容**：桌面端读取现有 SQLite 数据；路径迁移必须先备份、校验版本并支持失败回滚。
8. **阶段可回退**：每阶段单独提交、单独验收；未通过门禁时旧入口仍可运行。
9. **平台能力显式化**：桌面、Android、iOS 和远程客户端通过 `PlatformCapabilities` 控制功能，不散布临时平台判断。
10. **不混入用户改动**：每次提交只暂存本阶段文件，提交前检查 `git diff --cached`。

## 3. 目标架构

```text
React / Tailwind / shadcn UI
              |
           AppClient
              |
    Tauri invoke / event bridge
              |
+------------------- Rust workspace --------------------+
| ani-contracts | ani-domain | ani-storage | ani-sources |
| ani-downloads | ani-media  | ani-automation            |
+-------------------------------------------------------+
              |
+-------------------- Platform adapters ----------------+
| Desktop: process / tray / remote gateway / libVLC      |
| Android: Kotlin plugin / Service / PlayerActivity      |
| iOS: Swift plugin / BGTask / MobileVLCKit              |
+-------------------------------------------------------+
              |
 SQLite | torrent-core | qBittorrent | libVLC | OS APIs
```

### 3.1 Rust 模块边界

| 模块 | 职责 |
| --- | --- |
| `ani-contracts` | 与 `src/shared` 对齐的序列化 DTO、版本和错误模型 |
| `ani-domain` | 追番、来源、匹配、播放进度、下载状态和自动化规则 |
| `ani-storage` | SQLite、迁移、事务、备份、路径迁移和安全字段引用 |
| `ani-sources` | Metadata、RSS、Torznab、站点适配、限流、缓存和熔断 |
| `ani-downloads` | 下载引擎接口、任务编排、恢复、文件优先级和状态归一化 |
| `ani-media` | 文件关联、桌面探测、播放会话和平台播放器接口 |
| `ani-automation` | 来源同步、自动扫描、提醒和平台调度入口 |
| `src-tauri` | Tauri 状态装配、commands、events、capabilities 和生命周期 |

Rust 后台采用应用状态容器装配服务。业务模块不得依赖 Tauri 类型，便于单元测试和移动复用。

### 3.2 Renderer 边界

- 保留 `src/renderer/src`、设计系统、页面和响应式布局。
- 保留 `src/shared/app-client.ts` 作为页面唯一业务入口。
- 新增 `TauriClient`，将方法映射到类型化 commands 和 events。
- `AppRuntimeKind` 扩展为桌面、Android、iOS 和远程，运行时探测不再把未知 WebView 当作远程页面。
- 移动构建通过独立入口和 feature manifest 排除远程页面、远程客户端和桌面设置分组。
- Electron Client 在迁移期保留，用于回归和功能对照。

### 3.3 数据与安全

- Rust Repository 使用 SQLite 单写者模型，启用 WAL、外键、busy timeout 和事务。
- 复用当前 schema 语义与版本，不允许 Tauri 首启创建不兼容的第二套桌面数据。
- 桌面首次启动检测 Electron `userData` 数据库，执行只复制不删除的版本化迁移。
- Android / iOS 使用各自应用数据目录，保持设备本地数据库，不依赖桌面在线。
- 敏感凭据通过 `SecureStore` 端口访问 DPAPI / Keychain / Android Keystore；SQLite 只保存引用或非敏感设置。
- Tauri capabilities 按窗口和平台配置最小权限，不为 Renderer 开放通配 shell、fs、http 或 SQL 权限。

### 3.4 torrent-core 与下载

- 保留当前 C++ `native/torrent-core` 和版本化 JSON 命令协议。
- 桌面迁移初期继续以受管 sidecar 运行，Rust 负责启动、握手、重启、日志和退出。
- Android 首期复用现有 JNI、`TorrentDownloadService` 和 resume 目录，通过 Tauri Kotlin 插件连接。
- iOS 使用稳定 C ABI 和 XCFramework，由 Swift 插件管理前台生命周期与有限后台刷盘。
- 三个平台共享下载 DTO、错误码、状态合并和 fixture；桥接方式允许不同。
- 托管 qBittorrent 和 FFmpeg 仅编入桌面 feature，移动产物执行负向文件检查。

### 3.5 libVLC

桌面不能复用 `electron-vlc-player` 的 N-API 绑定，但可以复用当前播放器契约、React 控制层、受控资源会话和双窗口交互模型。

| 平台 | 实现 |
| --- | --- |
| Windows | Rust libVLC 3 C API 动态加载；原生 HWND 视频宿主；透明 Tauri 控制窗口 |
| macOS | Rust libVLC 3 C API；NSView 视频宿主；透明 WKWebView 控制窗口 |
| Linux | Rust libVLC 3 C API；X11/XWayland 视频宿主；原生 Wayland 另设门禁 |
| Android | 复用 `AndroidVlcPlayerViewModel`、`PlayerActivity` 和 `libvlc-all:3.6.2`，包装为 Tauri Kotlin 插件 |
| iOS | 复用 SwiftUI 播放器和 MobileVLCKit，包装为 Tauri Swift 插件 |

桌面播放器协调器必须同步视频窗与控制窗的移动、缩放、DPI、最大化、全屏、焦点、最小化和关闭。libVLC 回调进入线程安全事件队列，再发布带会话 ID 和递增序号的完整快照。

### 3.6 远程访问

- 远程 Renderer 和现有 HTTP/RPC 契约仅保留在桌面 feature。
- Rust 远程网关替代 Node HTTP/TLS 服务，负责认证、限流、媒体会话和受控资源访问。
- 远程网页仍使用 ArtPlayer，不改为 libVLC。
- Android / iOS 构建不编译远程网关模块，不复制 `.remote-pwa`，不显示远程设置入口。

## 4. 分阶段实施与提交边界

### P0：基线、工具链与契约门禁

交付内容：

- 提交当前 Windows torrent-core UTF-8 与优先级告警修复，和迁移代码隔离。
- 安装并验证 Rust stable、Cargo、Windows MSVC target；记录 macOS、Linux、Android 和 iOS CI 前置条件。
- 固定 Tauri CLI/API、Rust edition、最低系统版本和依赖锁文件。
- 增加跨语言 contract fixture 目录与最小解码测试。
- 记录现有 Electron、Android、iOS、播放器、torrent-core 和数据库基线测试结果。

提交建议：

1. `fix: 修复 Windows torrent-core MSVC 编译`
2. `feat: 建立 Tauri 迁移契约与工具链基线`

门禁：旧桌面与现有 Android 构建不回归；fixture 测试通过；Rust/Cargo 可在本机和 CI 使用。

### P1：Tauri 2 共存宿主

交付内容：

- 新增 Rust workspace、`src-tauri`、Tauri 配置、图标、日志和启动错误页。
- 新增 `TauriClient`、invoke 封装、event 订阅和平台能力探测。
- 先实现窗口状态、最小化、最大化、关闭、打开外链和选择路径等最小平台命令。
- 保留 Electron、Capacitor 和 Tauri 三套脚本，默认入口暂不切换。
- 建立 Windows Tauri dev/build 冒烟；增加 macOS/Linux CI 骨架。

提交建议：

1. `feat: 建立 Tauri 2 共存宿主`
2. `feat: 接入 Tauri AppClient 与平台能力`
3. `feat: 添加 Tauri 桌面构建门禁`

门禁：Tauri 首屏可用且无白屏；React 主壳、主题和窗口控制工作；Electron 回归通过。

### P2：Rust 数据层与首页闭环

交付内容：

- 实现 Rust DTO、SQLite Repository、迁移、seed、备份和安全存储端口。
- 完成现有桌面数据库路径发现、备份、兼容迁移和失败回滚。
- 首批迁移设置、通知、首页聚合和追番只读接口。
- 建立 TypeScript/Node 与 Rust 对同一 fixture 和数据库样本的契约测试。

提交建议：

1. `feat: 建立 Rust SQLite 仓库与数据迁移`
2. `feat: 迁移设置通知与首页查询`
3. `feat: 接通 Tauri 首页业务闭环`

门禁：旧数据无损读取；首次启动、升级、损坏库和回滚测试通过；Tauri 首页与 Electron 数据一致。

### P3：核心业务与来源迁移

按以下垂直切片逐个迁移，每个切片独立提交：

1. 追番 CRUD、单集、偏好和观看进度。
2. 番剧目录、月份/季度发现、搜索和详情。
3. 来源配置、Native HTTP、缓存、限流、熔断和代理。
4. RSS、Torznab、站点来源、标题解析和资源匹配。
5. 来源同步、自动扫描和提醒。

提交命名示例：

- `feat: 迁移追番与单集业务到 Rust 核心`
- `feat: 迁移番剧发现与详情服务`
- `feat: 迁移来源网络与资源搜索`
- `feat: 迁移自动扫描与提醒服务`

门禁：每个切片的页面在 Tauri 可独立完成；固定 fixture 与 Electron 结果一致；部分来源失败不清空成功结果。

### P4：下载、torrent-core 与媒体闭环

交付内容：

- 建立 Rust 下载引擎接口和统一状态服务。
- 接入桌面 torrent-core sidecar、外部 qBittorrent 和托管 qBittorrent。
- 迁移添加、暂停、恢复、删除、文件优先级、恢复和下载完成关联。
- 桌面接入 FFprobe/FFmpeg；移动接入 libVLC 媒体解析。
- Android 复用前台下载服务；iOS 实现前台下载与有限后台刷盘语义。

提交建议：

1. `feat: 建立 Rust 下载引擎与任务状态服务`
2. `feat: 接入 Tauri 桌面 torrent-core 与 qBittorrent`
3. `feat: 接通下载媒体关联与扫描`
4. `feat: 接入 Tauri 移动 torrent-core 生命周期`

门禁：本地确定性种子完成添加、下载、文件选择、暂停、恢复、删除和重启恢复；关闭后无残留进程或损坏 resume data。

### P5：全平台 libVLC

按平台独立提交，任何平台失败不阻断其他平台回退到旧入口：

1. Windows Rust FFI、双窗口、D3D11VA、字幕/音轨和资源打包。
2. macOS NSView、VideoToolbox、窗口同步、签名和运行库布局。
3. Linux X11/XWayland、运行库探测和包依赖。
4. Android Tauri Kotlin 插件复用现有 PlayerActivity。
5. iOS Tauri Swift 插件复用 MobileVLCKit 播放器。

提交命名示例：

- `feat: 接入 Tauri Windows libVLC 播放器`
- `feat: 接入 Tauri macOS libVLC 播放器`
- `feat: 接入 Tauri Linux libVLC 播放器`
- `feat: 接入 Tauri Android 原生播放器`
- `feat: 接入 Tauri iOS 原生播放器`

门禁：播放、暂停、跳转、音量、静音、倍速、字幕、音轨、比例、全屏、续播、90% 已看、自动下一集、错误恢复和幂等释放通过。真机覆盖 H.264、HEVC 10bit、HDR、ASS 字幕和多音轨。

### P6：桌面完整能力与远程网关

交付内容：

- 迁移托盘、后台运行、窗口恢复、主题、通知和桌面文件操作。
- 迁移外部播放器检测、启动、播放监控和定位文件。
- 用 Rust HTTP/TLS 服务迁移远程网关、认证、配对、媒体会话和远程 RPC。
- 保留远程 Renderer、ArtPlayer、HLS、字幕和转码回退。
- 完成桌面资源打包、日志、崩溃恢复和安全能力审计。

提交建议：

1. `feat: 迁移 Tauri 桌面系统集成`
2. `feat: 迁移外部播放器与媒体服务`
3. `feat: 迁移桌面远程网关与配对`
4. `feat: 完成 Tauri 桌面功能对等`

门禁：桌面功能矩阵全部签收；远程 URL 和 RPC 兼容；应用关闭后 qBittorrent、torrent-core、VLC 和网关按策略退出。

### P7：Android 与 iOS 完整应用闭环

交付内容：

- 将已完成的 Capacitor Android 数据基础迁移到 Tauri 宿主，保留原生 torrent 与 VLC 组件。
- 将现有 iOS MobileVLCKit 播放器接入 Tauri iOS 宿主。
- Android APK/AAB 必须内置 JNI torrent-core 与 `libvlc-all` 对应 ABI 运行库，不得通过远程桌面代理下载或播放。
- iOS App/IPA 必须内置 AniTorrentCore XCFramework 与 MobileVLCKit，不得通过远程桌面代理下载或播放。
- 接通移动首页、发现、追番、来源、搜索、下载、提醒、设置和播放器。
- 完整迁移浅色、深色、跟随系统、用户主题选择与持久化，主题切换不得要求重启应用。
- Android 使用前台服务与 WorkManager；iOS 使用 BGTask 尽力调度并遵守系统挂起限制。
- 完成移动安全存储、文件导入导出、通知跳转、备份恢复和生命周期恢复。
- 对 APK/AAB/IPA 执行负向检查，确认不包含远程 Web、远程网关、FFmpeg 或 qBittorrent-nox。

提交建议：

1. `feat: 迁移 Android Tauri 应用宿主`
2. `feat: 完成 Android 本地业务闭环`
3. `feat: 迁移 iOS Tauri 应用宿主`
4. `feat: 完成 iOS 本地业务闭环`

门禁：Android/iOS 在桌面端离线状态下，使用应用内置 torrent-core 完成确定性种子的添加、下载、暂停、恢复、文件选择和重启恢复，再使用内置 libVLC 播放下载文件并回写进度；浅色、深色、跟随系统和用户主题持久化通过；横竖屏、网络切换、后台恢复、低存储和权限拒绝有确定状态。

### P8：默认切换、发布与旧宿主退役

交付内容：

- Tauri 成为默认桌面与移动构建入口。
- 建立 Windows、macOS、Linux、Android 和 iOS 发布工作流、签名、校验和产物清单。
- 验证安装升级、旧数据迁移、资源完整性、许可证和源码说明。
- 冻结 Electron/Capacitor，仅在完整回归签收后删除其依赖、构建脚本和专属适配器。
- 更新 README、启动、发布、进度和故障排查文档。

提交建议：

1. `feat: 切换 Tauri 为默认应用宿主`
2. `feat: 完成 Tauri 全平台发布工作流`
3. `feat: 退役 Electron 与 Capacitor 宿主`
4. `feat: 完成 Tauri 全平台迁移`

门禁：五个平台生成可安装产物；升级不丢数据；桌面与移动功能矩阵签收；旧宿主删除前保留最后一个可回退标签。

## 5. 每阶段统一验证

每个阶段至少执行：

1. `pnpm.cmd run typecheck`
2. TypeScript / Node 确定性测试
3. 对应 Rust workspace 测试与 Clippy
4. `cargo fmt --check`
5. Tauri 目标平台 build/check
6. 旧 Electron 或移动宿主回归，直到 P8 正式退役
7. `git diff --check`
8. 提交前检查 `git diff --cached --stat` 和 `git diff --cached`

原生功能增加对应门禁：

- torrent-core：CMake 构建、命令协议冒烟、恢复数据与退出检查。
- libVLC：运行库加载、实际播放、轨道/字幕、硬解、全屏和资源释放。
- SQLite：新建、逐版本迁移、事务回滚、备份恢复和旧数据库样本。
- 移动：Kotlin/Swift 编译、模拟器、真机、包内容、权限和生命周期。
- 远程：认证负向测试、来源限制、TLS、媒体 Range、RPC 兼容和令牌脱敏。

## 6. 提交策略

- 一个提交只解决一个可验证问题，不把全阶段压成超大提交。
- 阶段提交必须以 `feat:` 或 `fix:` 开头，并用中文说明新增功能或修复内容。
- 使用路径级 `git add`，不执行 `git add -A`，避免混入当前工作树的用户文件。
- 生成目录、临时截图、Rust `target/`、Tauri 构建产物和移动中间产物不得提交。
- 阶段门禁失败时继续在同阶段修复，不开始下一阶段。
- 不重写、压缩或强推已有历史；远端推送仅在用户明确要求后执行。

## 7. 当前基线与前置条件

当前分支：`master_android`

当前已确认基础：

- `AppClient`、平台能力和部分平台 Ports 已存在。
- Android Capacitor 宿主、SQLite 启动基础、Keystore 和缓存目录已经完成。
- Android `PlayerActivity` / libVLC 与 torrent JNI/Service 已存在。
- iOS SwiftUI / MobileVLCKit 播放器工程已存在。
- 桌面 Electron libVLC 双窗口、远程网关、SQLite 和下载服务可作为行为基线。
- Windows torrent-core 已在本机成功构建、打包并校验。

P0 执行记录：

- Windows 已安装 Rust `1.97.1`、Cargo `1.97.1` 和 `x86_64-pc-windows-msvc` target。
- 已固定 `@tauri-apps/api@2.11.1`、`@tauri-apps/cli@2.11.4` 和 Rust 工具链版本。
- Rust workspace 测试、Clippy、格式检查、TypeScript 类型检查及 346 项 Node 回归测试通过；其中 345 项通过、1 项跳过、0 项失败。
- Windows torrent-core 已成功构建、打包并校验，MSVC 编译修复已独立提交。
- macOS、Linux、Android 和 iOS 仍须在对应系统或 CI 验证，不能用 Windows 本机结果替代。
- 当前工作树含用户未提交内容；迁移提交必须逐文件暂存并保持这些修改不变。
- Linux 原生 Wayland 的 libVLC 3 嵌入不作为首个切换门禁，首期正式支持 X11/XWayland；原生 Wayland 单独立项验证。

## 8. 工作量与停止条件

预计工作量：

| 范围 | 预计人日 |
| --- | ---: |
| P0-P1 工具链与共存宿主 | 8-12 |
| P2-P3 Rust 数据和核心业务 | 30-45 |
| P4 下载与媒体 | 18-28 |
| P5 全平台 libVLC | 20-30 |
| P6 桌面与远程完整能力 | 18-28 |
| P7 移动完整闭环 | 25-40 |
| P8 发布与退役 | 10-16 |
| 合计 | 129-199 |

外部等待、真机采购、签名、商店审核和来源站点变化不计入开发人日。

出现以下任一情况时停止切换、保留旧入口并重新审核：

1. 旧 SQLite 数据无法可靠迁移或回滚。
2. Windows/macOS libVLC 双窗口无法稳定同步或释放。
3. Android/iOS torrent-core 无法在平台生命周期下保存恢复数据。
4. Tauri 移动构建无法复用现有原生 VLC 界面且需要重写全部播放器 UI。
5. 远程网关兼容迁移导致现有客户端协议破坏。
6. 包体积、许可证、签名或商店政策出现不可接受风险。

## 9. 已确认决策

以下决策已经确认：

1. 同意 Rust 核心承载后台业务，而不是保留 Node sidecar 作为正式架构。
2. 同意迁移期保留 Electron / Capacitor，P8 后再退役。
3. 同意移动端仅排除远程 Web/网关、FFmpeg/FFprobe/转码及无移动语义的桌面系统能力，其余跨平台业务和主题功能全部保留。
   完整本地闭环强制包含内置 torrent-core、平台原生 libVLC 和主题系统，不接受远程代理降级。
4. 同意 Linux 首期支持 X11/XWayland，原生 Wayland 后续单独验收。
5. 同意按 P0-P8 顺序实施并按上述边界提交。
6. 同意 P0 安装 Rust 工具链并增加 Tauri/Cargo 依赖。

P0 已按上述决策执行；后续阶段继续逐阶段实现、验证并提交。
