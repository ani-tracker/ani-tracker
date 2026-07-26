# iOS 原生完整应用计划

最近更新：2026-07-24

状态：待审核，暂不执行

## 1. 目标

构建独立、本地优先的 Ani Tracker iOS/iPadOS 原生应用，使核心用户流程与桌面端保持一致，并让移动端下载与播放能力不低于 Android 当前原生能力。

应用使用 SwiftUI，不嵌入桌面 Renderer，不加载远程网页，不依赖 Electron 主进程，也不通过 WebView 复用现有 React 页面。

完整用户闭环为：

1. 发现新番并查看详情。
2. 加入或维护我的追番、单集状态和下载偏好。
3. 搜索资源并解释匹配结果。
4. 使用内置 torrent-core 管理下载和文件选择。
5. 使用 MobileVLCKit 播放本地或直接网络媒体。
6. 保存续播位置、已看状态并切换下一集。
7. 执行手动或系统允许的后台检查，并展示本地通知。

## 2. 产品边界

### 2.1 纳入范围

| 能力 | iOS 目标 |
| --- | --- |
| 首页 | 今日更新、下载摘要、最近观看、错误与提醒 |
| 新番发现 | 月份/季度采集、搜索、详情刷新、来源合并状态 |
| 我的追番 | CRUD、状态、标题别名、下载偏好、RSS 订阅、单集覆盖 |
| 资源搜索 | 标题/原名/别名搜索、来源部分成功、筛选、评分原因 |
| 下载源 | RSS、Torznab 与已验证的站点适配器；凭据存入 Keychain |
| 下载队列 | 添加磁链或 torrent、暂停、恢复、删除、文件优先级、速度与 ETA |
| 媒体 | 沙盒文件关联、文件导入、下载完成映射、直接媒体信息展示 |
| 内置播放 | MobileVLCKit、字幕/音轨、倍速、比例、续播、已看、自动下一集 |
| 自动化 | 手动扫描、前台定时、BGAppRefreshTask 尽力执行、结果通知 |
| 设置 | 来源、下载、网络、通知、存储、播放器、主题、日志与数据导入导出 |
| 设备 | iPhone 与 iPad，iOS 16.0 及以上，横竖屏适配 |

### 2.2 明确排除

- 不包含 `.remote-pwa`、远程 Renderer、局域网配对页面或任何 WebView。
- 不启动远程 HTTPS 网关，不生成本地 CA，不保存远程设备令牌。
- 不携带 FFmpeg、FFprobe、HLS 转码、实时转码或媒体代理服务。
- 不携带 qBittorrent-nox，不提供 WebUI 或托管 qBittorrent 模式。
- 不提供托盘、开机启动、任意外部播放器路径或桌面文件管理器能力。
- 不承诺进入后台后持续下载、做种或精确定时扫描。
- 首期不提供云同步；数据保存在当前设备，可通过版本化备份导入导出。

直接由 MobileVLCKit 播放 HTTP/HTTPS 媒体地址不属于远程网页功能，但不得通过内嵌网页承载播放 UI。

## 3. 与现状的差距

当前 `ios` 工程是可构建的原生播放器应用，只包含深链/本地文件入口、MobileVLCKit 播放状态和续播记录。

当前 Android APK 的主界面仍是 torrent-core 安装与宿主验证页，另有独立 VLC 播放器；它尚未实现完整移动追番界面。因此本计划以桌面端核心业务为功能基线，以 Android 的原生下载和播放器能力为最低平台基线，不复制 Android 的验证页形态。

主要缺口：

- iOS 没有应用级导航、领域模型、业务用例和依赖容器。
- iOS 没有 SQLite Repository、版本迁移和生产 seed。
- 元数据、来源适配、匹配、自动化当前只存在于 TypeScript 主进程。
- torrent-core 只有桌面 sidecar 与 Android JNI 桥接，没有 iOS C ABI。
- 现有 iOS 工作流只测试播放器并打包未签名 `.app`。
- 缺少完整应用的单元、契约、UI、原生核心和发布验收。

## 4. 总体架构

```text
SwiftUI Views
     |
Feature ViewModels
     |
Use Cases / Coordinators
     |
Domain Protocols
     |
+----+----------------+----------------+----------------+
|                     |                |                |
SQLite Repositories   Source Adapters  TorrentCoreActor MobileVLC Controller
|                     |                |                |
GRDB / Migrations     URLSession       C ABI/XCFramework MobileVLCKit
```

### 4.1 分层职责

- `App`：应用入口、场景生命周期、依赖装配、深链和后台任务注册。
- `Features`：首页、发现、追番、搜索、下载、提醒、设置和播放器页面。
- `Domain`：Swift 值类型、用例协议、状态机和业务错误，不依赖 UI 或平台 SDK。
- `Data`：SQLite Repository、迁移、缓存、备份和 Keychain 凭据。
- `Sources`：元数据 Provider、资源站点 Adapter、请求节流和结果归一化。
- `TorrentCore`：iOS C ABI、命令序列化、生命周期、任务恢复和文件访问协调。
- `Player`：保留现有 MobileVLCKit 控制器，并通过领域协议接入媒体和观看进度。
- `Platform`：通知、后台刷新、网络状态、文件导入、系统日志和受保护数据。

View 只依赖 ViewModel；ViewModel 只调用用例协议。网络、SQLite、torrent-core 与 VLC 通过构造注入，测试使用内存实现或固定 fixture。

### 4.2 导航结构

iPhone 使用底部 `TabView`：

- 首页
- 我的追番
- 新番发现
- 下载
- 更多

资源搜索从首页、番剧详情和追番详情进入；提醒中心、下载源和设置归入“更多”。iPad 使用 `NavigationSplitView` 保留同一功能层级，不创建第二套业务页面。

### 4.3 错误与日志

- 应用初始化失败显示可恢复的启动错误页，不出现空白界面。
- 页面分别提供加载、空数据、局部失败和整页失败状态。
- 使用 `OSLog` 分类记录启动、迁移、同步、搜索、下载、播放和后台任务。
- 日志禁止写入来源密码、代理凭据、完整磁链参数、用户文件内容或 Keychain 数据。

## 5. 领域契约与跨端一致性

TypeScript 类型不能直接作为 Swift 运行时代码复用。iOS 建立与 `src/shared/domain.ts`、`src/shared/contracts.ts` 对齐的 Swift `Codable` 模型，但不逐文件复制 Electron IPC。

一致性策略：

1. 为跨端模型定义版本号、字段默认值和兼容解码规则。
2. 在 `fixtures/contracts` 保存不含隐私数据的 JSON 金样。
3. Node 与 XCTest 同时读取相同 fixture，验证解码、匹配、状态映射和迁移结果。
4. 标题解析、集数识别、字幕组识别和资源评分使用同一输入输出 fixture。
5. 跨端规则修改必须同时更新 fixture 和两端测试，禁止只改 UI 文案掩盖语义差异。

首期允许 Swift 独立实现业务算法，但必须以共享 fixture 约束行为。后续只有在重复维护成本被证实后，再评估把纯算法下沉到跨平台核心库。

## 6. 数据与安全

### 6.1 SQLite

- 使用固定版本的 GRDB，通过 Swift Package Manager 锁定精确版本。
- 启用 WAL、外键、busy timeout、事务和必要索引。
- 建立独立的 iOS schema 版本，不直接打开 Electron 的 SQLite 文件。
- 保存设置、番剧目录、追番、单集、来源绑定、资源缓存、下载、媒体、观看进度和通知。
- 所有 schema 变化提供前向迁移测试，不以删除数据库作为升级方案。

### 6.2 凭据与文件

- Torznab API Key、代理认证和其他来源凭据存入 Keychain。
- SQLite 只保存 Keychain 引用或非敏感配置。
- 下载文件位于应用沙盒的 Application Support/Downloads，可由用户选择导出。
- 外部文件通过系统文件选择器和 security-scoped URL 访问，不保存失效的绝对路径。
- 备份包包含版本化业务数据，不默认包含下载媒体或敏感凭据。

### 6.3 网络

- 统一使用受控 `URLSession` 客户端，设置超时、响应大小上限和 MIME 校验。
- 按来源执行同域串行、最小间隔、条件请求、请求合并和 403/429 熔断。
- 图片进入受容量限制的磁盘缓存，不允许页面直接无限下载原图。
- 来源失败采用部分成功结果；证书或响应校验失败不得静默降级到不安全连接。

## 7. iOS torrent-core

### 7.1 桥接

在共享 C++ 核心上新增稳定 C ABI，而不是从 Swift 直接调用 C++：

- `ani_torrent_core_start(data_directory, callback)`
- `ani_torrent_core_execute(handle, request_json)`
- `ani_torrent_core_stop(handle)`
- `ani_torrent_core_free_string(value)`

C ABI 沿用当前版本化 JSON 命令协议。Swift 侧使用 `actor` 串行化调用，将回调映射为 `AsyncStream`，保证停止后不再投递迟到事件。

### 7.2 构建产物

- device：`arm64-apple-ios`
- simulator：`arm64-apple-ios-simulator` 与 `x86_64-apple-ios-simulator`
- 汇总为 `AniTorrentCore.xcframework`
- Boost、OpenSSL、libtorrent 使用固定版本和 SHA-256 源码
- 许可证、源码获取说明和构建清单随应用打包

### 7.3 生命周期

- 前台可添加、下载、做种、暂停、恢复、删除和调整文件优先级。
- 应用转入后台时立即保存 resume data，并申请有限后台时间完成刷盘。
- 被系统挂起后不承诺继续传输；再次激活时恢复任务和监听端口。
- 网络变化、磁盘不足、权限拒绝和损坏状态均转为可恢复任务错误。
- 达到分享率或做种时长目标后由应用层停止任务。

## 8. 功能阶段

### P0：契约与工程基线

- 确认功能矩阵、目录结构、依赖版本和 iOS schema v1。
- 建立 `AppContainer`、领域协议、共享 JSON fixture 与测试目标。
- 保留现有播放器可构建状态，禁止阶段性改造导致播放器回归。

验收：应用可从内存 Repository 启动全部导航；无实现的功能显示明确占位状态；契约 fixture 在 Node 与 XCTest 同时通过。

### P1：应用壳与持久化

- 实现 iPhone TabView、iPad NavigationSplitView、主题、错误页和通知中心壳。
- 接入 GRDB、迁移、seed、Keychain、图片缓存和数据备份。
- 建立首页聚合用例和统一刷新状态。

验收：首次启动、升级、损坏数据库和恢复备份均有确定结果；杀进程重启后设置与业务数据不丢失。

### P2：新番发现与我的追番

- 移植 Bangumi、AniList、Mikan 元数据采集与详情合并。
- 实现月份/季度发现、搜索、详情、加入追番和刷新。
- 实现追番 CRUD、标题别名、全局偏好、RSS 订阅、单集覆盖和观看进度。

验收：发现到加入追番闭环可用；离线时读取缓存；单来源失败不清空已有数据。

### P3：资源来源、解析与匹配

- 实现 RSS、Torznab 和经移动网络验证的站点 Adapter。
- 移植标题解析、集数/季度/字幕组/媒体属性识别与评分原因。
- 实现来源配置、连接测试、部分成功和缓存失效。

验收：同一 fixture 的解析与匹配结果和桌面端一致；搜索页显示每个来源的成功或错误状态；凭据不进入日志或 SQLite。

### P4：内置下载

- 构建 iOS torrent-core XCFramework 与 Swift actor 适配器。
- 实现磁链/torrent 添加、任务列表、速度、ETA、暂停、恢复、删除和文件选择。
- 实现任务持久化、文件关联、网络变化和沙盒存储管理。

验收：本地确定性种子可完成一次端到端下载；重启后恢复任务；后台挂起后数据不损坏；磁盘不足时显示可操作错误。

### P5：媒体与 VLC 播放

- 将现有 MobileVLCKit 播放器接入下载结果、追番详情和观看进度。
- 支持本地/直接网络媒体、外部字幕、音轨、倍速、比例、剧集切换和重试。
- 统一每 10 秒、暂停、切集、关闭和挂起时的续播保存。
- 首次达到 90% 标记已看，片尾提供可取消的自动下一集。

验收：横竖屏切换不断播；音频中断和前后台切换可恢复；播放错误有明确重试路径；关闭后无 VLC 句柄残留。

### P6：自动化、通知与设置

- 实现手动扫描和应用前台定时扫描。
- 使用 `BGAppRefreshTask` 尽力执行轻量来源检查，不在后台启动长时 BT 传输。
- 实现新集、自动添加、下载完成和扫描失败的本地通知。
- 完成来源、下载、网络、通知、存储、播放、主题、日志和数据设置。

验收：手动扫描结果可追溯；后台任务超时能安全取消；通知点击定位到正确番剧、任务或播放器页面。

### P7：专用构建与发布工作流

- 新建 `.github/workflows/ios-app.yml`，完成后移除或重定向 `ios-player.yml`，避免重复构建。
- 使用 macOS 15、Xcode 16.4、固定 CocoaPods/XcodeGen/依赖版本。
- 缓存 CocoaPods、SwiftPM 和固定摘要的原生源码，不缓存签名材料。
- 分别构建设备和模拟器 torrent-core，再生成 XCFramework。
- 执行 XCTest、UI 测试、模拟器 Debug 和 arm64 Device Release 构建。
- 无签名 Secret 时上传模拟器与未签名设备 `.app.zip`。
- 配置证书和描述文件时执行 Archive、签名校验与 IPA 导出。
- `v*` 标签仅在签名成功后创建草稿 Release，并生成 SHA-256 清单。

计划使用的 Secrets：

| Secret | 用途 |
| --- | --- |
| `IOS_DISTRIBUTION_CERT_BASE64` | iOS 分发证书 P12 |
| `IOS_DISTRIBUTION_CERT_PASSWORD` | P12 密码 |
| `IOS_PROVISIONING_PROFILE_BASE64` | App Store/TestFlight 或 Ad Hoc 描述文件 |
| `IOS_SIGNING_IDENTITY` | 签名身份 |
| `APPLE_TEAM_ID` | Apple Developer Team |
| `APP_STORE_CONNECT_API_KEY_ID` | App Store Connect API Key ID |
| `APP_STORE_CONNECT_ISSUER_ID` | App Store Connect Issuer ID |
| `APP_STORE_CONNECT_API_KEY_BASE64` | App Store Connect 私钥 |

验收：模拟器、未签名设备包和可选签名 IPA 的产出条件明确；证书只存在于临时 Keychain；工作结束后无条件清理签名材料。

### P8：安全、合规与真机签收

- 扫描 `.app`/IPA 文件清单、Mach-O 架构、动态依赖、签名和隐私清单。
- 负向检查 `.remote-pwa`、WebView 资源、FFmpeg、FFprobe、HLS 转码和远程网关证书。
- 检查 MobileVLCKit、AniTorrentCore、许可证和源码说明完整。
- 在 iPhone/iPad、横竖屏、蜂窝/Wi-Fi 切换、低存储和系统挂起场景真机回归。
- 发布前复核 libVLC、libtorrent、OpenSSL、Boost 与来源适配器的许可和商店政策。

验收：自动检查和真机清单全部签收后，才能把草稿 Release 或 TestFlight 构建标记为候选版本。

## 9. 测试策略

| 层级 | 覆盖内容 |
| --- | --- |
| Domain 单元测试 | 状态机、匹配、自动化选择、观看进度和错误归一化 |
| Contract 测试 | Swift/TypeScript Codable、字段默认值、状态映射和 fixture 一致性 |
| Repository 测试 | schema 创建、逐版本迁移、事务回滚、备份恢复和并发读取 |
| Source 测试 | 固定 HTTP fixture、限流、缓存、部分成功、403/429 和超时 |
| Torrent 集成测试 | C ABI 生命周期、状态/配置命令、恢复、文件选择和本地种子下载 |
| Player 测试 | 深链、续播、已看、自动下一集、音频中断和迟到事件 |
| UI 测试 | 核心导航、加载/空/错状态、下载闭环和播放入口 |
| Package 测试 | 架构、签名、依赖、许可证、隐私清单和禁止内容 |

所有测试必须可在无真实用户凭据时运行。网络来源测试默认读取 fixture；真实站点冒烟测试单独运行，失败不得污染确定性测试结果。

## 10. 最终验收指标

1. 首页、发现、追番、搜索、下载、提醒、设置和播放器均为原生 SwiftUI 页面。
2. 从发现番剧到加入追番、搜索资源、完成下载并播放的核心闭环在真机通过。
3. 添加、暂停、恢复、删除、文件优先级、重启恢复和分享策略端到端可用。
4. iOS 16 及以上的 iPhone/iPad 目标布局无重叠或横向溢出，主要触控区不小于 44pt。
5. 所有页面具备加载、空数据、局部错误或整页错误状态；运行时错误不出现纯空白界面。
6. 应用转入后台后任务状态和 resume data 完整，回到前台可恢复；不把系统挂起描述为持续下载。
7. 模拟器测试、arm64 设备构建、可选签名 IPA、包完整性和 SHA-256 校验通过。
8. 最终 `.app`/IPA 不包含远程网页、远程网关、FFmpeg、FFprobe 或转码资源。
9. MobileVLCKit、AniTorrentCore、第三方许可证、隐私清单和源码获取说明完整可访问。
10. 关键日志可定位启动、迁移、同步、下载和播放失败，且不泄露凭据或用户隐私。

## 11. 风险与控制

| 风险 | 影响 | 控制 |
| --- | --- | --- |
| Swift 与 TypeScript 业务规则漂移 | 跨端结果不一致 | 共享 fixture、契约版本和双端测试门禁 |
| iOS 后台策略限制 BT | 挂起后停止传输 | 前台语义、有限后台刷盘、明确恢复状态 |
| libtorrent/Boost/OpenSSL 交叉编译复杂 | XCFramework 架构或链接失败 | 固定工具链、分架构构建、Mach-O 验证和缓存版本化 |
| 来源站点限制或结构变化 | 搜索部分失败 | Adapter 隔离、限流、熔断、fixture 和部分成功 UI |
| App Store 审核与 BT 分发风险 | IPA 无法公开发布 | 先确定 TestFlight/Ad Hoc 渠道，提交前政策和法务复核 |
| SQLite 迁移或沙盒路径失效 | 数据或文件关联丢失 | 迁移测试、文件标识、备份恢复和失败回滚 |
| MobileVLCKit 体积与编解码许可 | 包体积和合规风险 | 精确版本、依赖审计、许可证随包和发布前复核 |
| 大范围一次性交付 | 回归面过大 | P0-P8 阶段门禁，每阶段保持可构建与可回退 |

## 12. 实施前待审核决策

1. 首个正式分发渠道：TestFlight、Ad Hoc，还是直接准备 App Store。
2. iOS 内置 BT 是否在所有分发版本默认启用，或根据渠道使用编译开关。
3. 首期数据策略是否维持设备本地独立数据库；本计划默认不实现桌面同步或云同步。
4. iPad 是否与 iPhone 同期签收；本计划默认同期支持。
5. 首批必须上线的资源站点列表；未验证站点不得仅因桌面端存在就宣称 iOS 可用。
6. 后台自动检查的产品表述必须是“系统调度、尽力执行”，不能承诺固定间隔。

以上决策完成审核前，不进入 P0 实现。
