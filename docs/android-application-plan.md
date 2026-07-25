# Android 完整应用适配计划

最近更新：2026-07-25

状态：已批准，P0-P1 已完成，P2 待实施

## 1. 目标

在不破坏 Windows、macOS 和 Linux 桌面端的前提下，先交付独立、本地优先的 Android 应用。Android 复用现有 React 页面和纯 TypeScript 业务规则，通过明确的平台接口连接 SQLite、网络、下载、文件、通知、后台任务和原生 VLC 播放器。

完整业务闭环为：

1. 发现新番并查看详情。
2. 添加和维护追番、单集状态与下载偏好。
3. 配置下载源，搜索并解释资源匹配结果。
4. 使用内置 torrent-core 添加和管理下载。
5. 扫描已下载媒体并使用 Android libVLC 播放。
6. 保存续播、已看状态并自动切换下一集。
7. 执行手动或系统允许的后台检查，并显示本地通知。

## 2. 已确定边界

- Android 页面采用 React、Tailwind CSS 和现有 shadcn/ui 风格组件，通过 Capacitor WebView 承载。
- Android WebView 使用系统 Chromium WebView；不把远程 PWA 当作 Android 应用。
- Android、Electron 和远程网页使用同一上层 `AppClient` 契约，但分别实现平台适配器。
- Android 继续使用现有 `TorrentDownloadService`、JNI torrent-core 和原生 libVLC 播放器。
- Android 数据默认保存在本机，不依赖桌面端在线，不实现桌面同步或云同步。
- 首个正式 ABI 为 `arm64-v8a`；调试阶段可增加 `x86_64` 模拟器 ABI，但不扩大首发 ABI 承诺。

Android 包明确不包含：

- `.remote-pwa`、远程 Renderer、局域网配对和远程播放器页面。
- 远程 HTTPS 网关、本地 CA、远程设备令牌和媒体代理。
- FFmpeg、FFprobe、HLS 转码或实时转码服务。
- qBittorrent-nox 托管进程、托盘、开机启动和桌面窗口控制。
- 任意外部播放器可执行文件路径。

Android 可保留外部 qBittorrent Web API 模式，但不提供托管 qBittorrent 模式。系统外部播放器通过 Android Intent 打开，不使用桌面播放器配置。

## 3. 当前基础与缺口

### 3.1 可直接利用

- `src/renderer/src` 已包含首页、追番、发现、搜索、下载、提醒、来源、设置和响应式应用壳。
- `src/shared` 已包含领域模型、状态定义、播放器契约和大部分纯业务规则。
- `android/torrent-host` 已包含 arm64 JNI、前台服务、NDJSON 命令和恢复目录。
- `android/app` 已包含 Compose/libVLC 原生播放器、续播和自动下一集能力。
- Android APK/AAB、AAR、签名和原生许可证已有 CI 基线。

### 3.2 必须补齐

- 当前 Renderer 只识别 Electron 和远程网页，缺少 Android runtime。
- 当前业务服务主要由 Electron Main 装配，部分模块依赖 Node.js、Electron 或 `better-sqlite3`。
- Android 主 Activity 仍是 torrent-core 验证页，不是完整应用宿主。
- Android 缺少应用 SQLite Repository、迁移、生产 seed 和安全凭据存储。
- Android 缺少受控 Native HTTP、来源代理、图片缓存和文件导入导出。
- Torrent Binder 尚未接入页面使用的下载契约和状态事件。
- 原生播放器尚未与下载任务、媒体记录和应用导航形成闭环。
- WorkManager、业务通知、日志导出和完整应用发布验收尚未建立。

## 4. 目标架构

```text
React Pages
    |
AppClient / Application Services
    |
+-------------------- Platform Ports --------------------+
| Repository | HTTP | Torrent | File | Player | Scheduler |
| Notification | SecureStore | ImageCache | Diagnostics   |
+---------------------------------------------------------+
    |                         |
Electron Adapters        Android Adapters
IPC / Node.js            Capacitor Plugins / Kotlin
    |                         |
better-sqlite3           Android SQLite / Keystore
desktop sidecar          Binder / JNI / libVLC
```

远程客户端保留在桌面产品中，但不进入 Android 构建入口和产物。

### 4.1 抽象规则

1. 页面只调用 `AppClient`，不能直接调用 Electron IPC、Capacitor Plugin 或 Android API。
2. 应用服务只依赖平台接口，不能读取 `process.platform`、`window.aniBridge` 或 Android runtime。
3. 平台差异通过能力描述 `PlatformCapabilities` 表达，不在页面散布 `isElectron` 或 `isAndroid` 分支。
4. 纯算法和用例优先提取为 TypeScript 公共模块；Node 专属部分留在 Electron Adapter。
5. Android 原生插件提供窄接口，不暴露任意 SQL、任意文件路径或任意 Binder 请求给页面。
6. 跨端模型和命令使用版本化 JSON fixture 做契约测试。

### 4.2 建议模块边界

| 模块 | 职责 |
| --- | --- |
| `application` | 首页、发现、追番、搜索、下载、自动化等用例编排 |
| `platform/contracts` | Repository、HTTP、Torrent、File、Player 等平台接口 |
| `platform/electron` | 现有 IPC、Node、better-sqlite3 和桌面原生服务适配 |
| `platform/android` | Capacitor Client、能力描述和 Kotlin Plugin 调用 |
| `renderer` | 桌面与 Android 共用页面、组件和响应式布局 |
| `android/app` | Capacitor 宿主、插件、权限、WorkManager 和原生播放器 |
| `android/torrent-host` | Binder、JNI、前台下载服务和原生运行时 |

目录在 P0 通过依赖图确认后再迁移，禁止一次性移动全部文件造成不可审查的大改动。

## 5. 功能处理方式

| 桌面能力 | Android 处理方式 |
| --- | --- |
| 首页与提醒 | 复用 React 页面，数据来自 Android Repository |
| 新番与详情 | 复用页面和 Provider 规则，网络改用 Native HTTP |
| 我的追番 | 复用 CRUD、偏好和单集规则，目录字段使用移动语义 |
| 资源搜索 | 复用解析与评分，来源请求通过 OkHttp 适配器 |
| 下载源 | 保留 RSS、Torznab 和验证通过的站点 Adapter |
| 内置下载 | Capacitor Torrent Plugin 连接现有 Binder/JNI 服务 |
| 外部 qBittorrent | 保留 Web API 模式；不提供托管 qBittorrent-nox |
| 文件选择 | 保留 torrent 文件优先级；本地文件使用 Android 存储接口 |
| 媒体扫描 | 使用 libVLC 媒体解析和文件元数据，不携带 FFprobe |
| 内置播放 | 启动现有 `PlayerActivity`，回传续播与已看结果 |
| 外部播放 | 使用 `ACTION_VIEW` 或分享 Intent，不配置可执行文件路径 |
| 自动扫描 | 前台立即执行，后台交给 WorkManager 尽力调度 |
| 下载后台运行 | 使用前台服务和常驻通知，并验证系统限制下的恢复 |
| 设置 | 复用通用设置，替换桌面专属分组和路径语义 |
| 数据备份 | 版本化导出业务数据，不默认导出媒体和凭据 |
| 远程访问 | Android 包完全排除；桌面端现有能力不变 |

## 6. 关键平台实现

### 6.1 Android 客户端入口

- 增加独立移动构建入口和 `mobile` runtime，不再把非 Electron 环境默认解释为远程网页。
- Android `MainActivity` 改为 Capacitor 宿主；当前核心验证操作迁移到开发诊断页。
- 移动构建只注册 Android Client，不编译远程配对、远程播放和远程 HTTP Client。
- 页面根据 `PlatformCapabilities` 显示真实可用操作，桌面专属入口不产生死按钮。

### 6.2 数据与安全

- 为 SQLite 建立异步 Driver 接口，桌面实现映射到 `better-sqlite3`，Android 实现映射到原生 SQLite。
- 共享 schema 语义、迁移版本、SQL 语句和行映射，禁止维护两套不受约束的数据模型。
- 启用事务、外键、WAL、busy timeout 和逐版本迁移测试。
- Torznab API Key、代理密码和 qBittorrent 密码存入 Android Keystore 保护的存储。
- SQLite 只保存非敏感配置或安全存储引用。
- 备份文件带格式版本；恢复前验证并以事务导入，失败不覆盖现有数据库。

### 6.3 网络、来源与图片

- 建立 `HttpPort`，桌面继续使用现有 Electron/Node 请求实现，Android 使用受控 OkHttp 插件。
- Android Native HTTP 负责超时、响应大小、重定向、压缩、代理和证书错误归一化，避免 WebView CORS 限制。
- 来源层继续执行同域串行、请求合并、条件请求、403/429 熔断和部分成功策略。
- 图片缓存存入 Android cache directory，按容量淘汰，并返回 WebView 可读取的受控地址。
- 网络日志不记录 API Key、Cookie、完整磁链查询参数或代理密码。

### 6.4 下载与文件

- 新增 Torrent Plugin，负责启动、绑定和重连 `TorrentDownloadService`。
- Plugin 将类型化下载命令映射到现有 NDJSON 协议，并发布状态变更事件。
- 前台通知显示活动任务摘要，并提供暂停或返回应用等受控操作。
- 默认下载目录使用应用专属外部存储，确保 libtorrent 获得稳定文件路径。
- SAF 目录不能直接作为 libtorrent 普通路径；首期提供完成后导出或分享，不申请高风险的全盘文件权限。
- 磁链、`.torrent` 文件、剪贴板和 Android 分享入口统一进入同一添加用例。
- 系统停止服务、应用升级、网络切换和设备重启后，从 resume data 恢复且不重复创建任务。

### 6.5 媒体与播放

- 下载完成后由应用服务关联任务、文件和单集，不依赖 FFprobe。
- Android 通过 libVLC 媒体解析读取时长、轨道和基础编码信息；无法识别的字段允许明确为空。
- React 页面通过 Player Port 启动 `PlayerActivity`，不直接构造 Android Intent。
- Player Activity 接收播放列表、活动集、字幕和续播位置，并回传检查点与已看状态。
- 每 10 秒以及暂停、切集、关闭和生命周期挂起时保存续播；首次达到 90% 标记已看。

### 6.6 后台、通知与生命周期

- Torrent 下载由前台服务承担，WorkManager 不直接托管长时间 BT Session。
- 来源同步和自动扫描使用唯一 Work 请求，防止并发和重复调度。
- 后台调度属于系统尽力执行，不承诺严格分钟级触发。
- 通知按下载、新集、自动化和系统错误分渠道；点击后定位到对应页面或任务。
- 对省电模式、通知权限拒绝、后台限制和存储不足提供可恢复提示。

## 7. 实施阶段

### P0：契约与工程基线，3-4 人日

- 固定 Capacitor、Android Gradle Plugin、Kotlin、SDK、NDK 和原生依赖版本。
- 定义 `RuntimeKind`、`PlatformCapabilities` 和平台 Ports。
- 建立依赖图和迁移清单，确认哪些 TypeScript 模块可直接提取。
- 建立跨端 JSON fixture 和 Android 契约测试入口。

验收：桌面仍使用 Electron Client；Android 空壳使用 Android Client；远程客户端行为不变；三者不能相互隐式回退。

### P1：Android 宿主与数据基础，5-7 人日

- 接入 Capacitor，生成独立 Android Web 产物。
- 将主 Activity 改为应用宿主，保留原生播放器 Activity。
- 实现 SQLite Driver、迁移、seed、Keystore、图片缓存和数据备份基础。
- 实现启动错误、加载、空数据和数据库恢复状态。

验收：Android 可显示完整导航；首次启动和升级后数据库正确；杀进程重启数据不丢失；移动包不含远程网页资源。

实施结果（2026-07-25）：已接入独立 Capacitor WebView 构建、共享 SQLite schema/版本引导、Android Keystore 安全存储、应用与图片缓存目录、数据库 JSON 导出基础及启动错误状态。`MainActivity` 已切换为 Capacitor 宿主并保留原生 `PlayerActivity`；移动依赖图已排除远程 RPC 和桌面托管进程代码。数据库首次启动、重启和高版本拒绝测试通过，JDK 21 下 `:app:compileDebugKotlin` 通过。

### P2：业务服务与网络来源，10-14 人日

- 提取元数据、来源、同步、标题解析、匹配和追番用例到平台无关模块。
- 实现 Native HTTP、代理、限流、熔断和来源缓存。
- 接通首页、发现、详情、追番、资源搜索、下载源和提醒页面。

验收：从发现到添加追番、配置来源和搜索资源的闭环可用；固定 fixture 与桌面结果一致；部分来源失败不清空成功结果。

### P3：下载与存储闭环，7-10 人日

- 实现 Torrent Plugin、Binder 重连、状态事件和服务通知。
- 接通磁链、torrent 文件、任务控制、文件优先级、速度、ETA 和删除策略。
- 完成任务与番剧、单集、字幕组和资源元数据的持久关联。

验收：真机完成确定性种子的添加、下载、暂停、恢复、文件选择、删除和重启恢复；系统杀进程后数据不损坏。

### P4：媒体与播放器闭环，5-8 人日

- 使用 libVLC 完成媒体解析和文件记录。
- 从首页、追番和下载页启动原生播放器。
- 回写续播、已看和自动下一集状态。

验收：下载完成后可直接播放；横竖屏和前后台切换不丢失会话；关闭播放器后资源释放；进度写回幂等。

### P5：自动化、设置与通知，5-8 人日

- 实现 WorkManager 来源同步和自动扫描。
- 完成移动下载、网络、来源、自动化、通知、存储、主题和日志设置。
- 完成通知跳转、日志导出和版本化备份恢复。

验收：手动扫描结果可追溯；后台超时可安全取消；通知定位正确；敏感信息不进入日志或备份。

### P6：质量、构建与发布，6-9 人日

- 扩展 Android CI，执行 TypeScript、Kotlin、数据库、契约、UI 和原生核心测试。
- 构建 Debug APK、签名 Release APK/AAB 和 SHA-256 清单。
- 检查 ABI、JNI、VLC、许可证、签名、权限和禁止内容。
- 在 Android 8、主流稳定版本和目标 SDK 对应版本进行真机回归。
- 推送阶段提交并确认 GitHub Actions 的 Android 工作流实际成功，不以本地构建代替远程结果。

验收：自动测试、真机清单和 GitHub Actions 全部通过后才标记候选版本；APK/AAB 不包含远程网页、FFmpeg、FFprobe、转码或 qBittorrent-nox。

预计总工作量为 41-60 人日；真机采购、商店审核和外部来源可用性等待不计入开发人日。

## 8. 测试门禁

| 层级 | 覆盖内容 |
| --- | --- |
| TypeScript 单元测试 | 解析、匹配、自动化、状态机和设置归一化 |
| 契约测试 | Desktop/Android JSON 编解码、错误码和默认值一致性 |
| Repository 测试 | schema、逐版本迁移、事务回滚、备份和恢复 |
| Source 测试 | fixture、代理、限流、缓存、403/429、超时和部分成功 |
| Torrent 集成测试 | Binder/JNI 生命周期、任务恢复、文件优先级和本地种子 |
| Player 测试 | 播放列表、续播、已看、自动下一集和生命周期 |
| Web UI 测试 | 390x844、844x390、平板视口、错误态和触控尺寸 |
| Android 真机测试 | 网络切换、锁屏、省电、权限拒绝、低存储和进程恢复 |
| Package 测试 | ABI、签名、权限、许可证、隐私和禁止内容 |

真实站点冒烟测试与确定性 fixture 测试分离，站点临时不可用不能污染稳定测试结果。

## 9. 最终验收

1. 首页、追番、发现、搜索、下载、提醒、来源和设置页面在 Android 可独立使用。
2. 发现番剧、加入追番、搜索资源、完成下载、播放和标记已看的完整闭环在真机通过。
3. Android 与桌面端对相同 fixture 的标题解析、资源匹配和状态映射结果一致。
4. 前台下载服务可恢复，不丢失任务关联、文件选择或 resume data。
5. 所有页面具备加载、空数据、局部错误或整页错误状态，不出现纯白屏。
6. 390x844 和 844x390 无非预期横向滚动、文字遮挡或小于 44px 的主要触控目标。
7. 数据库升级和备份恢复不要求清空用户数据，凭据不进入 SQLite、日志或普通备份。
8. GitHub Actions 成功生成 Release APK/AAB，ABI、签名、权限、许可证和 SHA-256 校验通过。
9. Android 包不含远程网页、远程网关、FFmpeg、FFprobe、转码资源或 qBittorrent-nox。
10. 桌面 typecheck、测试、构建和 Electron IPC 行为保持通过。

## 10. 风险与控制

| 风险 | 控制 |
| --- | --- |
| 抽取业务层影响桌面端 | 小步迁移、接口契约、每阶段执行桌面回归 |
| WebView 与原生状态不同步 | 单一 AppClient、事件序列号、生命周期重连测试 |
| Android 后台限制下载服务 | 前台服务、resume data、系统版本真机验证和明确状态 |
| SAF 无稳定普通路径 | 应用专属下载目录，完成后通过 SAF 导出 |
| Native HTTP 与桌面行为漂移 | 共享 fixture、错误归一化和代理测试 |
| SQLite 双实现漂移 | 共享 schema、迁移和行映射，双 Driver 契约测试 |
| 原生崩溃导致 WebView 白屏 | 服务隔离、错误页、崩溃恢复和诊断日志 |
| Play 分发与 BT 政策风险 | 发布前复核政策，保留 APK 自分发渠道和功能开关 |

## 11. 已采用实施决策

1. 是否确认使用 Capacitor WebView，而不是重写 Compose 业务页面。
2. 下载文件是否接受“应用专属目录 + 完成后导出”；默认不申请全盘文件权限。
3. 是否保留外部 qBittorrent Web API 模式；计划默认保留。
4. 首发是否只支持 `arm64-v8a`；计划默认 Release 仅 arm64。
5. 首个分发渠道是自签 APK、Google Play 内测，还是两者同时。
6. 平板是否与手机同期验收；计划默认适配但不建立第二套页面。

按 P0-P6 顺序实施，每一阶段完成验证后单独提交。P6 必须以 GitHub Actions Android 工作流成功作为最终验收条件。
