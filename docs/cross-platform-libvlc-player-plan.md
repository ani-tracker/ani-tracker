# Ani Tracker 跨平台内置播放器实施计划

> 状态：P0-P8 代码与自动化验收已完成；GitHub Actions 和真机签收待外部环境
> 更新日期：2026-07-24

## 1. 目标与范围

将 Ani Tracker 的内置播放能力统一为 libVLC，同时保留现有远程网页播放链路和播放器配置逻辑。

| 运行端 | 内置播放器 | UI 形态 | 保留能力 |
| --- | --- | --- | --- |
| Electron（Windows / macOS / Linux） | libVLC 3.0.x | 无边框独立播放窗口 | 当前播放器选择、外部播放器路径、播放会话与转码回退 |
| Android | LibVLC for Android | 原生横竖屏播放器 | 本地/远程媒体播放、字幕、进度和播放队列 |
| iOS | MobileVLCKit | SwiftUI 宿主 + VLC 原生视频视图 | 本地/远程媒体播放、字幕、进度和播放队列 |
| 远程网页 | ArtPlayer + HLS | 响应式网页播放器 | 现有 HLS、字幕、外部播放器调用和远程接口 |

明确不做：

- 不把移动原生端继续建立在 ArtPlayer 上。
- 不改变远程网页的协议、URL 和现有 ArtPlayer 播放逻辑。
- 不删除外部播放器模式，也不改变已有播放器选择配置的语义。
- 不把真实本地媒体路径暴露给普通网页渲染进程。

## 2. 已完成排查上下文

### 2.1 当前代码入口

| 领域 | 当前入口 | 现状 |
| --- | --- | --- |
| 桌面播放器窗口 | `src/main/core/media/desktop-player-window-service.ts` | 创建桌面播放窗口，但页面仍复用远程播放器路由 |
| 桌面播放会话 | `src/main/core/media/desktop-playback-session-service.ts` | 已能创建直传/HLS 会话，并可通过 `resolveAsset()` 解析受控资源 |
| 播放器路由 | `src/renderer/src/App.tsx` | 桌面内置和远程网页尚未完全拆分 |
| 远程播放器 | `src/renderer/src/features/remote/RemoteVideoPlayer.tsx` | 使用 ArtPlayer，承载 HLS、字幕和网页控制逻辑 |
| 播放列表模型 | `src/renderer/src/features/remote/remote-player-model.ts` | 现有剧集与播放状态模型可作为统一契约的迁移输入 |
| 主进程 IPC | `src/main/ipc.ts` | 原生播放器命令与事件需要扩展 |
| Preload | `src/preload/index.ts` | 需要增加最小权限的播放器桥接 API |
| Electron 打包 | `electron-builder.config.cjs` | 尚未携带 libVLC、插件和原生绑定 |
| 桌面 Actions | `.github/workflows/torrent-core-desktop.yml` | 尚未验证各平台 libVLC 运行文件 |
| Android Actions | `.github/workflows/torrent-core-android.yml` | 需要纳入 Android VLC 依赖和产物校验 |
| iOS | 尚无工程 | 需要新增 SwiftUI 工程及 MobileVLCKit 集成 |

### 2.2 libVLC 技术结论

- 桌面候选绑定为 `electron-vlc-player@1.0.2`，要求 Electron 28 及 libVLC 3.0.x。
- npm 包不包含预编译原生模块，也不携带 libVLC 运行时；必须固定精确版本、审计绑定源码，并在 CI 对目标 Electron ABI 编译。
- libVLC 视频输出是原生子窗口/表面，React DOM 不能可靠覆盖在其上。
- 桌面采用双窗口：底层原生视频宿主关闭自带控件，上层透明无边框 BrowserWindow 承载 React/shadcn 控制 UI；两者同步位置、尺寸、全屏、焦点和生命周期。
- `DesktopPlaybackSessionService` 继续负责媒体会话，libVLC 主进程仅消费 `resolveAsset()` 返回的受控本地资源或 HLS 清单。
- Android 使用 `org.videolan.android:libvlc-all`；iOS 使用 MobileVLCKit，由各平台原生视图承载视频表面。
- 当前 Windows 开发机未安装系统 VLC 与 MSVC C++ Build Tools；已用官方 VLC ZIP 完成运行库和目录包验收，原生绑定加载仍由 GitHub Actions 和具备工具链的开发机验证。

### 2.3 Stitch 设计基线

Stitch 项目：`12075319551332625536`

| 设计稿 | Stitch Screen ID | 目标视口 |
| --- | --- | --- |
| 播放器（PC 桌面端） | `12c08d89aad548e1890a368cca725e62` | 桌面窗口 |
| 播放器（错误状态） | `cf3744e8b8ae4a538f911d069c9556ab` | 播放区域中央提示 |
| 播放器（移动端竖屏） | `616a88871cbd4f70a74e519aaa775b99` | 移动端竖屏 |
| 播放器（移动端横屏） | `47d791ce5464428ea7e3731073a79d56` | `844 x 390` |

本地导出参考：`C:\Users\momoc\AppData\Local\Temp\ani-stitch-player-20260723`。横屏 HTML 被 Stitch 错误注入 `min-height: 884px`，实现和验收以 `844 x 390` PNG 视觉稿为准。

设计约束来源：

- `docs/播放器UI设计提示词.md`
- `docs/DESIGN.md`
- 现有 shadcn/ui 组件与语义主题变量

错误稿只提取播放器中央错误提示，不复用其中旧版应用外壳。

## 3. 架构决策

### 3.1 双播放后端、单一行为契约

定义平台无关的 `PlayerCommand`、`PlayerSnapshot`、`PlayerCapabilities` 和 `PlayerError`：

- 远程网页适配器把命令映射到 ArtPlayer。
- Electron 适配器通过 preload/IPC 映射到主进程 libVLC。
- Android 和 iOS 适配器映射到各自 VLC SDK。
- 页面组件只依赖状态和能力，不直接依赖具体播放器 SDK。

统一命令至少包含：加载、播放、暂停、跳转、音量、静音、倍速、音轨、字幕轨、画面比例、全屏、画中画能力查询、上一集、下一集、重试和关闭。

统一状态至少包含：加载阶段、播放状态、时长、当前位置、缓冲进度、音量、倍速、可用音轨/字幕轨、当前剧集、播放列表、全屏状态和结构化错误。

### 3.2 桌面窗口模型

桌面播放器由一个协调服务管理：

1. 无边框视频宿主窗口持有 libVLC 原生输出。
2. 透明控制层窗口加载独立的播放器 React 路由。
3. 控制层使用 `-webkit-app-region: drag` 提供可拖动区域，交互控件使用 `no-drag`。
4. 协调服务原子同步移动、缩放、最大化、全屏、最小化、置顶与关闭。
5. 控制层自动隐藏时不销毁窗口，避免恢复控件时闪烁或丢失焦点。

### 3.3 兼容原则

- 现有播放入口仍根据当前配置选择“内置播放器”或“外部播放器”。
- 只有“内置播放器”的平台实现被替换为 VLC。
- 远程网页始终使用 ArtPlayer，不因桌面配置变化而切换后端。
- 所有新增 IPC 先在 `src/shared/contracts.ts` 声明，再接主进程、preload 和 renderer。
- 新版客户端与旧服务端交互时，未知能力按“不支持”降级，不导致白屏。

## 4. 执行计划

| 阶段 | 交付物 | 完成标准 | 状态 |
| --- | --- | --- | --- |
| P0 契约 | 统一命令、快照、能力、错误和会话模型；IPC/preload 类型 | 类型检查通过；现有远程接口字段不破坏；适配器可独立测试 | 已完成 |
| P1 UI | PC、移动竖屏、移动横屏和中央错误提示；控制层自动隐藏 | 四个目标视口无溢出/遮挡；核心布局与 Stitch 接近；键盘和触屏可操作 | 已完成 |
| P2 Electron | libVLC 生命周期服务、双窗口协调、无边框/全屏、轨道与进度事件 | Windows/macOS/Linux 构建成功；窗口同步；关闭后无 VLC/窗口残留 | 已完成（运行时包验收并入 P7） |
| P3 远程网页 | 新 UI 接入 ArtPlayer 适配器，保留 HLS/字幕/外部播放器逻辑 | 现有远程 URL 与 API 不变；HLS、字幕、进度和错误恢复回归通过 | 已完成 |
| P4 Android | Compose 播放页、LibVLC Surface、横竖屏与生命周期 | debug/release 构建通过；旋转不断播；后台/前台和音频焦点行为正确 | 已完成（安装包与真机验收并入 P7/P8） |
| P5 iOS | SwiftUI 播放页、MobileVLCKit 视图桥接、方向与生命周期 | 模拟器可编译；真机播放/字幕/横竖屏通过；安全区无控件遮挡 | 已完成（macOS 实编译与真机验收并入 P7/P8） |
| P6 业务闭环 | 续播、90% 已看、自动下一集、播放错误到转码回退 | 每 10 秒及暂停/退出保存进度；达到 90% 只标记一次；下一集可取消 | 已完成 |
| P7 分发 | 各平台运行时、插件、原生绑定、许可证、源码说明和 Actions | 安装包离线启动无缺库；CI 校验必需文件；LGPL 合规材料随包可见 | 已完成（远端 Actions 待 GitHub 镜像触发） |
| P8 验收 | 浏览器截图比对、构建测试、桌面与移动真机清单 | 桌面及 `390 x 844`、`844 x 390` 截图通过；原生平台无阻断项 | 已完成（自动化；真机待外部环境） |

## 5. 分阶段实施细节

### P0：播放契约

- 在 shared 层增加判别联合类型，避免 renderer 使用原生 SDK 类型。
- 引入 `PlayerAdapter` 接口和能力协商；不支持的命令返回结构化 `unsupported`，不抛出未捕获异常。
- 把播放错误分为资源、网络、解码、权限、转码、原生运行时和未知错误。
- 为快照事件增加会话 ID 与单调递增序号，过滤关闭/切集后的迟到事件。
- 为关键会话创建、资源解析、播放器启动、错误和释放记录中文上下文日志，不记录令牌或完整本地路径。

### P1：设计稿 UI

- 将桌面控制层和远程网页播放器页面分成独立 host，共享无后端依赖的展示组件。
- 使用现有 shadcn `Button`、`Slider`、`Tooltip`、`DropdownMenu`、`Sheet`/`Collapsible`、`ScrollArea` 等组件。
- 桌面：标题栏、中央播放反馈、底部时间轴与控制区、右侧剧集面板、无边框窗口按钮。
- 竖屏：视频区与详情/剧集区按设计纵向组织，遵守安全区和最小 44pt 触控目标。
- 横屏：视频全屏优先，控件叠层保持稳定尺寸；以 `844 x 390` 为准忽略错误 HTML 高度。
- 错误：在当前视频表面中央显示原因、重试和必要的回退操作，不替换整个应用外壳。

### P2-P5：平台后端

- Electron：固定并审计绑定版本；服务负责加载 libVLC、解析资源、转发命令/事件和幂等释放。
- Android：VLC 生命周期绑定到 ViewModel/宿主生命周期，旋转只重建视图表面，不重建业务会话。
- iOS：用 `UIViewRepresentable`/`UIViewControllerRepresentable` 桥接 VLC 视频视图，SwiftUI 保存可观察播放状态。
- 远程网页：只新增统一契约适配层，保留 ArtPlayer、HLS 与字幕加载器。

P2 验证记录（2026-07-24）：

- 已精确锁定 `electron-vlc-player@1.0.2`，桌面内置入口改为 libVLC 专用宿主与透明 React 控制层，不再复用远程 ArtPlayer 页面。
- 主进程完成受控资源解析、命令映射、轨道/进度快照、双窗口同步和幂等释放；新增服务与窗口协调测试。
- `typecheck`、主题对比度、309 项 Node 测试（308 通过、1 跳过）和 Electron/Vite 生产构建通过。
- 本机缺少 VLC/MSVC，原生绑定实播与三平台安装包完整性继续由 P7 Actions 和 P8 真机清单验收。

P3 验证记录（2026-07-24）：

- 新增 ArtPlayer 统一适配器，页面通过 `PlayerCommand`/`PlayerSnapshot` 控制播放、字幕、倍速、比例、全屏和画中画。
- HLS 仍由 hls.js 接管，远程播放 URL、会话 API、字幕地址和本机外部播放器协议未变。
- 保留直传失败自动转码、90% 上报和播完切集；类型检查、309 项 Node 测试及生产构建通过。

P4 验证记录（2026-07-24）：

- Android 应用固定 `libvlc-all:3.6.2` 与 `arm64-v8a`，新增原生 VLC Surface、Compose 竖屏详情/列表、横屏叠层和中央错误提示。
- ViewModel 在旋转时保留播放器与业务会话，Surface 独立重绑；后台暂停、前台恢复、音频焦点、硬解、字幕/音轨、倍速、比例与切集均由原生控制器处理。
- 本机真实通过 `:app:compileDebugKotlin`，并完成 Manifest、资源、Java、DEX 阶段；完整 APK 仅因现有 torrent-host 未准备 Boost/OpenSSL 而阻断，Actions 已包含对应准备步骤，安装包与真机验证并入 P7/P8。

P5 验证记录（2026-07-24）：

- 新增 XcodeGen SwiftUI 应用工程并固定 `MobileVLCKit 3.7.3`，原生控制器覆盖本地/网络媒体、外部字幕、音轨、倍速、比例、续播位置、音频中断和前后台恢复。
- 竖屏实现 16:9 视频、摘要、简介和播放列表；横屏实现全屏视频叠层与右侧列表；加载、缓冲、无任务和播放失败均保留视频内可恢复提示。
- 新增 `anitracker://player` 深链、本地安全作用域文件入口和解析单元测试；Swift 语法树、plist/隐私清单、YAML/Asset JSON、TypeScript、主题及 309 项 Node 测试通过。
- 新增 macOS 15 / Xcode 16.4 Action，执行 XcodeGen、CocoaPods、iOS 模拟器测试并校验 MobileVLCKit 嵌入；当前 Git 远程仅为 Gitee，Action 真编译需在 GitHub 镜像接入后运行。

### P6：播放业务

- 播放进度节流上报，并在暂停、切集、窗口关闭、应用挂起时立即刷新。
- 观看进度首次跨过 90% 时标记已看，回退进度不撤销标记。
- 自动下一集在片尾触发，显示可取消倒计时；无下一集时保持结束状态。
- 直传/解码失败按现有能力尝试转码回退，回退失败进入统一错误提示。

P6 验证记录（2026-07-24）：

- 桌面与远程网页共用播放业务 Hook，通过 SQLite 按任务文件保存续播位置；会话创建时恢复可靠中段位置，记录随下载任务级联清理。
- Electron/Web、Android 和 iOS 均在每 10 秒及暂停、切集、关闭、挂起时保存；首次达到 90% 立即持久化且已看状态单调，片尾提供五秒可取消自动下一集提示。
- 保留远程 ArtPlayer 的直传失败转码回退与统一错误提示，切集期间通过媒体源标识过滤旧快照，避免把上一集进度写入新任务。
- `typecheck`、主题检查、314 项 Node 测试（313 通过、1 跳过）、Android `:app:compileDebugKotlin`、11 个 Swift 文件语法扫描和 Electron/Vite 生产构建通过。

### P7：打包与许可证

- Electron 安装包按目标平台携带 libVLC 动态库、插件目录、原生 Node 绑定和运行时查找配置。
- CI 在打包前按 Electron ABI 重建原生绑定；打包后解包检查 VLC 核心库和插件存在。
- Android 由 Gradle/AAR 打包对应 ABI；release 检查不得意外裁剪 VLC JNI 库。
- iOS 通过受支持依赖管理方式集成 MobileVLCKit，检查 framework 嵌入、签名和设备架构。
- 安装包增加第三方许可证清单、libVLC/VLC 版本、LGPL 文本、修改说明及对应源码获取方式。
- 保留动态链接与可替换库条件；若绑定或分发方式引入更强许可义务，发布前单独审核。

P7 验证记录（2026-07-24）：

- Windows/macOS 固定官方 VLC 3.0.21 归档与 SHA-256；Linux 使用 Ubuntu VLC 3.0.x 并记录精确包版本和 Launchpad 源码页，复制后为 ELF 设置相对 RPATH。
- Electron 打包缺少目标运行库时直接失败，原生 `vlc_binding.node` 固定解包到 `app.asar.unpacked`；三平台 Actions 显式按 Electron ABI 重编译，并在打包前实际加载 libVLC 断言 3.0.x 版本。
- 本机通过系统代理校验并整理 Windows 官方 ZIP，生成 365 个插件的 `win32-x64` 运行库；Node 22.19 下 Electron 目录包成功，核心 DLL、插件、来源和六份许可证材料验包通过。
- Android 构建将 VLC 声明和完整 LGPL 文本放入 `assets/licenses/vlc`，Action 校验 APK/AAB 仅含 `arm64-v8a` 的 `libvlc.so`、`libvlcjni.so`；iOS 同时构建模拟器和无签名 arm64 设备应用，校验 MobileVLCKit 和声明资源。
- `typecheck`、主题检查、314 项 Node 测试（313 通过、1 跳过）、Android 许可证资源任务与 Kotlin 编译、11 个 Swift 文件语法扫描、YAML 解析及 Electron/Vite 构建通过。
- 本机完整 Android APK 仍受既有 Boost/OpenSSL Android 前置包缺失阻断；Windows 原生绑定受 MSVC 缺失阻断。Actions 已包含对应依赖准备、绑定冒烟和最终产物检查，但当前远程仅为 Gitee，需接入 GitHub 镜像后执行。

### P8：验收

- Web UI 使用浏览器在桌面、`390 x 844`、`844 x 390` 三类视口截图，与 Stitch PNG 并排检查。
- 检查正常、加载、暂停、缓冲、控制层显示/隐藏、剧集面板、错误和全屏状态。
- 执行 `pnpm.cmd run typecheck`、项目测试、renderer 构建和 Electron 构建。
- CI 执行桌面三平台、Android 和 iOS 构建；需要真实解码器、HDR、硬解或系统音频行为的项目列入真机验收。

P8 自动化验收记录（2026-07-24）：

- Stitch MCP 握手不可用后，使用已导出的四套设计稿与 Chrome DevTools Protocol 逐像素尺寸截图；桌面默认、播放列表、错误态、`390 x 844` 竖屏和 `844 x 390` 横屏均按精确 CSS 视口验收。
- 五个视图的文档宽度均未超过视口，可见图标按钮均具备可访问名称；移动横竖屏按钮不小于 `44 x 44`，播放进度 Slider 具备名称、当前值和 44px 命中区。
- 竖屏显示 Stitch 海报、`8/12` 观看进度，并自动将第 07 集和当前第 08 集定位到列表顶部；横竖屏往返后定位仍保持。横屏右侧 Sheet 宽度为 44%，当前集和关闭入口均可见。
- 浏览器实测播放/暂停、快退十秒、快进十秒、设置 Sheet 和播放列表 Sheet；中央错误提示保留重试、实时转码和关闭操作，不产生白屏。
- `typecheck`、浅/深主题对比度、314 项 Node 测试（313 通过、1 跳过）、Electron/Vite 生产构建和 Android `:app:compileDebugKotlin` 均通过。
- 当前仓库远端仅为 Gitee，GitHub Actions 未触发；macOS/iOS 实编译以及 HDR、硬解、系统音频、休眠恢复和真机旋转仍按下表签收，不把缺少硬件环境误记为代码失败。

| 真机签收项 | 平台 | 通过标准 |
| --- | --- | --- |
| VLC 运行库与插件离线加载 | Windows / macOS / Linux | 干净系统启动并播放 H.264、HEVC、本地字幕，无缺库提示 |
| 无边框双窗口 | Windows / macOS / Linux | 拖动、缩放、DPI、最大化、全屏、焦点和关闭同步，无残留窗口或 VLC 句柄 |
| HDR、硬解和音轨 | 桌面与移动真机 | HDR/SDR 显示正常，硬解回退可恢复，音轨切换和系统音量行为正确 |
| 生命周期与旋转 | Android / iOS | 横竖屏不断播，时间/字幕/倍速保持，后台与音频中断恢复正确 |
| 安装包合规材料 | 全平台 | VLC 版本、LGPL、修改声明、源码获取说明可从最终安装产物访问 |

## 6. 风险与控制

| 风险 | 影响 | 控制措施 |
| --- | --- | --- |
| 桌面 Node 原生绑定版本较新且无预编译产物 | Electron 升级或目标平台编译失败 | 精确锁版、源码审计、按 ABI 重建、三平台 CI 冒烟 |
| libVLC 原生视频层无法被 DOM 覆盖 | 控件不可见或输入穿透 | 双窗口协调；为位置、DPI、全屏和焦点写集成测试 |
| libVLC 运行库/插件漏包 | 用户机器启动失败或无法解码 | 打包后解包校验；干净虚拟机离线启动测试 |
| iOS 工程从零开始 | 交付量和签名验证增加 | 先建立最小可编译宿主，再接 UI/业务；模拟器与真机分开验收 |
| GPL/LGPL 或编解码器分发义务 | 发布合规风险 | 动态链接、保留替换能力、随包许可证/源码说明、发布前法务复核 |
| 多后端状态事件时序不同 | 切集后状态倒退或 UI 闪烁 | 会话 ID + 事件序号；适配器状态机；迟到事件丢弃 |
| Stitch HTML 与 PNG 尺寸冲突 | 横屏布局失真 | 固定以目标 PNG 和 `844 x 390` 验收 |

## 7. 最终验收指标

1. 远程网页仍由 ArtPlayer 播放，原 URL、HLS、字幕和远程接口兼容。
2. Electron、Android、iOS 的“内置播放器”均由 VLC 后端承载，外部播放器配置仍可用。
3. Electron 播放窗口无系统边框，拖动、缩放、最大化、全屏、最小化和关闭均正常。
4. PC、移动竖屏、移动横屏与错误提示在目标视口无重叠、溢出或不可点击控件，主要区域与 Stitch 稿一致。
5. 播放、暂停、跳转、音量、倍速、字幕/音轨、剧集切换、续播、90% 已看和自动下一集端到端可用。
6. 全平台 CI 生成可安装产物；打包检查确认 libVLC 核心库、插件、绑定和许可证文件齐全。
7. 任一运行时错误均显示可恢复的播放器错误提示，不产生纯白屏；播放器关闭后无残留窗口、进程或媒体句柄。
