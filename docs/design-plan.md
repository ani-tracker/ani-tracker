# Ani Tracker 架构与设计

最近核对：2026-07-26

本文描述 Tauri 2 正式架构。功能完成度见 [实现状态](progress.md)，迁移过程见 [Tauri 2 迁移记录](tauri-2-migration-plan.md)。

## 产品边界

Ani Tracker 是覆盖桌面与移动端的本地优先追番应用。五个平台共享业务契约、Rust 核心和 React UI；平台插件只处理原生生命周期、下载、播放器、安全存储和系统 API。

桌面端承担媒体探测、转码、远程 HTTPS 网关和桌面系统集成。Android/iOS 是独立本地应用，不依赖桌面在线，不加载远程网页，也不打包 FFmpeg/FFprobe 或转码服务。

## 运行架构

```text
Local React Renderer                 Desktop Remote PWA
         | Tauri invoke/events              | HTTPS RPC
         +------------------+----------------+
                            v
                       Tauri Host
                            |
        +-------------------+-------------------+
        |                   |                   |
  Application services   Repository Ports   Platform Ports
        |                   |                   |
 sources/download/media   SQLite Adapter   torrent/libVLC/OS
```

### 层次职责

| 层 | 职责 |
| --- | --- |
| `src/renderer/src` | 页面、状态、交互和响应式布局，只依赖 `AppClient` |
| `src/shared` | TypeScript 领域模型、客户端接口和跨平台契约 |
| `ani-contracts` | Rust 序列化 DTO、版本与稳定错误 |
| `ani-domain` | 追番、单集、设置和领域规则 |
| `ani-repository` | 数据库无关 Repository Ports、UnitOfWork 和错误模型 |
| `ani-storage` | SQLite 连接、schema、迁移、备份和事务 Adapter |
| `ani-sources` | 元数据、RSS、Torznab、站点适配、网络策略和缓存 |
| `ani-downloads` | 下载引擎端口、状态编排、恢复和任务路由 |
| `ani-media` | 媒体关联、桌面探测和播放器会话 |
| `ani-automation` | 来源同步、自动扫描、提醒和平台调度入口 |
| `ani-remote` | 仅桌面启用的 HTTPS、配对、RPC、图片和媒体网关 |
| `src-tauri` | 服务装配、commands、events、窗口、托盘和生命周期 |
| `tauri-plugin-ani-*` | Android/iOS torrent、libVLC、安全存储和系统插件 |

业务 crate 不依赖 Tauri 类型。Tauri command 只暴露业务动作，不开放任意 SQL、任意路径、任意 shell 或通配网络能力。

## 数据架构

SQLite 是当前桌面与移动端默认 Adapter，应用数据版本为 22，Schema 版本为 18。

- 业务服务只依赖分域 Repository trait 和 UnitOfWork。
- SQL 方言、连接、迁移、备份、WAL、外键与 busy timeout 归 `ani-storage` 所有。
- 复合写入通过显式提交或回滚保证一致性。
- 桌面首次启动可发现旧数据库，先备份再只复制迁移，原数据不删除。
- Android/iOS 使用应用私有目录；敏感凭据由 Keystore、Keychain 或桌面凭据库保存，SQLite 只存引用。

未来 MySQL 通过独立 Adapter 实现现有 Repository Ports，不修改页面、`AppClient`、Tauri commands 或领域服务。面向公网时由受控服务连接 MySQL，客户端不持有数据库直连凭据。

## 下载与媒体

### 下载

- `ani-downloads` 统一任务 DTO、状态、错误和引擎路由。
- 桌面 torrent-core 使用受管 NDJSON sidecar；Android 通过 JNI/前台服务；iOS 通过稳定 C ABI/XCFramework。
- 外部 qBittorrent Web API 全平台可用；托管 qBittorrent-nox 仅桌面启用。
- 切换引擎只影响新任务，已有任务继续由原引擎管理。

### 播放

- 桌面使用 Rust 动态加载 libVLC 3，并由原生视频窗与透明 Tauri 控制窗协作。
- Android 使用 LibVLC `PlayerActivity`；iOS 使用 MobileVLCKit 与 SwiftUI 播放页。
- 播放器共享命令、能力、结构化错误、递增快照、续播和已看规则。
- 桌面远程 PWA 使用 ArtPlayer、Range 与 HLS；移动应用不包含此页面。

### 桌面媒体

FFprobe/FFmpeg、媒体扫描、转码、外部播放器和文件管理器仅编入桌面。移动端由 libVLC 直接解析和播放媒体，不提供伪装的 FFprobe/转码入口。

## 平台能力

页面通过 `PlatformCapabilities` 决定能力可见性：本地数据、来源管理、内置下载、托管进程、原生播放、媒体扫描、后台自动化、窗口控制、远程网关和文件导出均为显式字段。

未知浏览器只能识别为远程客户端；只有 Tauri bridge 可以进入桌面、Android 或 iOS 本地运行时。远程客户端使用固定 RPC 白名单，不能隐式回退到本地能力。

## 安全与可靠性

- 网络请求执行协议、主机、端口、响应大小、限流和熔断策略。
- 远程网关校验 Host、Origin、令牌 scope、频率和媒体会话。
- 本地文件命令只接受数据库登记路径或应用受控目录。
- 移动包执行负向内容检查，拒绝远程 PWA、FFmpeg/FFprobe、转码和 qBittorrent-nox。
- 关键启动、迁移、同步、下载、播放和退出路径记录结构化日志，不记录令牌或密码。
- Renderer 保留错误边界、加载态、空状态和可恢复错误反馈，运行时异常不得形成白屏。

## 扩展原则

- 新存储实现 Repository Ports；新数据库不得渗透到业务层。
- 新来源实现 Metadata/Release Source 端口并复用网络策略。
- 新下载核心实现统一 Engine/Transport，不改变页面任务模型。
- 新播放器实现 PlayerTransport，不绕过受控媒体会话。
- 平台差异放在 capability、service 或 adapter 中，不在页面散布宿主探测。
- 只有在存在真实替换或重复规则时增加抽象，保持高内聚和明确依赖方向。

## 当前限制

- Linux 首期内置视频窗支持 X11/XWayland；原生 Wayland 需单独验收。
- iOS 遵循系统后台限制，不承诺挂起后持续下载。
- 未声明进度协议的外部播放器不回写观看进度。
- madVR 或其他外部渲染器链路尚未实现。
