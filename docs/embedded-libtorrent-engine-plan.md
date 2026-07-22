# 内置 libtorrent 下载引擎实施计划

最近更新：2026-07-22
状态：待实施。本文仅定义目标、边界与验收标准，不代表功能已经完成。

## 目标

以 `libtorrent-rasterbar` 实现真实的 `EmbeddedTorrentEngine`，让 Ani Tracker 不再依赖 qBittorrent 即可完成 BT 下载与做种。

- 下载内核随应用分发、由应用管理，不要求用户安装 qBittorrent 或打开 qB WebUI。
- 桌面端与 Android 端共用下载内核语义、任务模型和持久化格式。
- 维持 `TorrentEngine` 作为上层唯一下载接口，页面、自动化、媒体扫描和远程网关不感知底层协议差异。
- qBittorrent 适配器在迁移期间继续保留，用户可在设置中选择下载引擎。

## 平台范围

| 端 | 交付方式 | 支持级别 |
| --- | --- | --- |
| Windows | 随 Electron 打包的本地核心进程 | 完整下载与做种 |
| macOS | 随 Electron 打包的本地核心进程 | 完整下载与做种 |
| Linux | 随 Electron 打包的本地核心进程 | 完整下载与做种 |
| Android | `libtorrent` `.so` + 前台下载服务 | 完整下载与做种，受系统省电策略约束 |
| Web/PWA | 调用桌面或移动宿主的受限远程接口 | 仅控制与查看，不在浏览器内运行 BT 内核 |
| iOS/iPadOS | 后续独立验证 | 可评估编译集成；系统不允许长期后台做种，不能承诺与桌面端同等常驻行为 |

首批发布目标为 Windows x64、macOS arm64/x64、Linux x64 和 Android arm64-v8a。Android `armeabi-v7a`、`x86_64` 在构建与真机验证通过后纳入发布矩阵。

## 总体架构

```text
Renderer / Remote PWA
          |
  Shared TorrentEngine contract
          |
     Platform bridge
      /             \
Electron Main     Android ForegroundService
      |                    |
  Local torrent-core IPC   JNI
      \                    /
       libtorrent-rasterbar core
```

### 原生核心

新增 C++ `torrent-core`，负责：

- Session 生命周期、DHT、LSD、Tracker、连接与监听端口。
- 磁链和 `.torrent` 文件添加、元数据获取、文件优先级、暂停、恢复、移除、校验与目录迁移。
- 单任务和全局上下行限速、并发队列、分享率、做种时长及停止策略。
- libtorrent alert 转换为稳定的任务状态与事件流。
- Session 状态和 resume data 的原子保存与恢复。

桌面端采用随包分发的本地核心进程，经受限本地 IPC 通信。该进程属于应用内部组件，不暴露 WebUI 或局域网服务；它将原生崩溃与 Electron 主进程隔离。Android 使用同一核心代码编译为动态库，由前台服务通过 JNI 调用。

## 应用层改造

1. 将当前内存占位的 `EmbeddedTorrentEngine` 替换为核心桥接实现。
2. 保持现有 `TorrentEngine` 基础契约；新增能力先在 `src/shared/contracts.ts` 定义，再接入 IPC、preload 与界面。
3. 扩展 `EmbeddedTorrentSettings`：监听端口、DHT/UPnP、全局限速、活动任务数、分享率和做种时长策略。
4. 以 info hash 作为内核任务稳定标识；应用数据库保存番剧、资源、规则与下载任务的关联。
5. 下载核心为任务状态的事实来源；现有 Repository 仅保存业务关联、用户配置和可恢复的展示数据。
6. 自动扫描、下载恢复、文件选择、媒体扫描与通知均继续通过 `TorrentEngine` 调用，禁止页面直接调用原生核心。

## 设置中的引擎选择

下载设置保留 `defaultTorrentEngine`，并明确提供以下可选项：

| 选项 | 用途 | 可配置项 |
| --- | --- | --- |
| 内置 BT 引擎（libtorrent） | 应用随包提供的默认本地下载能力 | 监听端口、DHT/UPnP、全局与单任务限速、队列、分享率、做种时长、存储目录 |
| qBittorrent | 已安装、外部或应用托管的 qB Web API | 保留现有地址、账号、限速、做种和托管配置 |

- 默认引擎仅影响新建下载任务；每个任务保留创建时的 `engine`，后续暂停、恢复、移除和状态刷新始终路由到原引擎。
- 切换默认引擎不自动迁移未完成任务，也不得删除既有数据。需要迁移时，后续提供显式的“重新添加到目标引擎”操作并要求用户确认。
- 选择内置引擎时，设置页显示当前平台、架构、核心版本、启动状态、数据目录和最近错误；产物缺失或不兼容时禁止创建占位任务，并给出修复提示。
- 两类引擎的配置分别保存；切换选择器不覆盖另一引擎的账号、路径、限速或做种规则。

## 打包与交付

### 桌面资源布局

在源码资源目录中按平台和架构保存经过验证的原生核心产物，建议布局如下：

```text
resources/torrent-core/
  win32-x64/torrent-core.exe
  win32-arm64/torrent-core.exe
  darwin-x64/torrent-core
  darwin-arm64/torrent-core
  linux-x64/torrent-core
  linux-arm64/torrent-core
  manifest.json
```

- 每个目录包含运行所需的动态库、许可证与校验信息；启动时仅加载当前平台和架构的目录。
- 新增 `prepare-libtorrent-resources` 与 `verify-libtorrent-resources` 脚本，沿用现有 qBittorrent/FFmpeg 资源准备模式；构建前复制有效产物到输出目录，校验时不访问网络。
- Electron 打包配置须将当前目标的核心、动态依赖和许可证作为额外资源带入应用；macOS 进行签名与公证前校验可执行位和依赖路径，Windows 纳入代码签名，Linux 验证动态链接兼容性。
- `out/` 与其他生成产物不提交源码库；资源清单、构建脚本、源码和许可证说明可提交。

### Android 交付

- 将每个 ABI 的 `libtorrent` 与 JNI 桥接库置于 Android 包的 `jniLibs` 或等效构建产物中，首批仅安装匹配设备 ABI 的库。
- 前台服务、通知渠道、存储权限和下载数据目录随移动宿主一起打包；不得依赖 Termux、外部 qB 或可执行文件路径。
- APK/AAB 构建在产物校验阶段验证 ABI、符号依赖、许可证文件和最小设备版本。

## 持久化与生命周期

- 将 session state、每任务 resume data 和应用数据库放在用户数据目录的独立下载核心目录中。
- 添加、暂停、修改文件优先级、完成和退出前均触发可恢复状态落盘；写入失败记录结构化日志且不伪报成功。
- 桌面端启动时恢复 session，退出时请求优雅停止并在超时后记录明确错误。
- Android 使用前台服务、常驻通知、存储权限与电池优化提示；应用被系统终止后必须能从 resume data 恢复。
- 不将私有 Tracker 凭据、磁链中的敏感参数或本地路径写入可公开日志。

## 实施阶段

### 阶段 0：原生可行性与构建基线

- 建立 CMake 工程、依赖锁定和许可证清单。
- 为目标三类桌面平台及 Android arm64-v8a 构建最小 Session 示例。
- 验证磁链、`.torrent`、DHT、resume data、限速与状态查询。

### 阶段 1：桌面内置引擎

- 定义本地 IPC 协议与错误模型，完成 Electron 主进程桥接。
- 实现 `EmbeddedTorrentEngine` 的全部现有契约，接入任务监控和应用日志。
- 完成设置页的默认引擎选择、状态展示、任务路由和切换保护，保留 qBittorrent 回退选项。
- 完成各桌面目标的核心资源准备、签名和打包校验。

### 阶段 2：策略与业务联动

- 实现单任务分享率、做种时长、队列和完成后行为。
- 接入文件优先级、下载完成扫描、自动下载、重启恢复与通知。
- 为内核事件补充幂等处理，避免重复入库、重复扫描或重复通知。

### 阶段 3：Android 宿主

- 新建 Android 宿主与前台下载服务，接入 JNI 桥接和 scoped storage。
- 实现任务恢复、网络变化处理、通知和电池优化引导。
- 以远程接口或移动界面调用同一业务契约，避免复制下载规则。

### 阶段 4：兼容性与发布验证

- 覆盖 Windows、macOS、Linux、Android 的真实设备或 CI 集成验证。
- 验证升级、异常退出、网络切换、磁盘满、权限拒绝和损坏 resume data。
- 根据平台支持情况决定 Android 次要 ABI 与 iOS/iPadOS 的后续范围。

## 验收标准

- 不安装 qBittorrent 时，内置引擎可添加磁链和 `.torrent`，并完成下载、做种、暂停、恢复、删除和文件优先级调整。
- 下载列表每秒可获得可靠的进度、ETA、上下行速度和完成状态；核心异常不会造成渲染进程白屏。
- 单任务分享率和做种时长达到阈值后按设置停止或暂停，重启后策略继续生效。
- 应用重启或 Android 服务重建后，未完成任务可恢复且不丢失文件选择、保存路径和业务关联。
- 各发布目标仅加载对应平台与架构的原生产物；缺失产物时给出可操作错误，不静默回退到占位任务。
- 现有 qBittorrent 引擎回归测试继续通过，下载页面不出现引擎特定分支。
- 在设置中切换默认引擎后，新任务使用所选引擎，既有任务仍由原引擎管理，且不丢失下载文件或关联数据。
- 桌面安装包与 Android 安装包均包含对应原生依赖、许可证和完整性校验；离线安装后无需额外下载或配置 qBittorrent。

## 非目标与风险

- 不在浏览器/PWA 内直接运行 BT 内核；PWA 始终只作为受限控制端。
- 不承诺 iOS/iPadOS 在应用后台持续下载或做种，该能力受系统策略限制。
- libtorrent 不提供 qBittorrent 的 WebUI、RSS、分类标签或自动化产品层能力；这些由 Ani Tracker 现有服务或后续应用层实现。
- 原生依赖、平台签名、ABI 兼容性和 Android 后台限制是主要交付风险，必须以目标平台真实构建和真机验证为准。
