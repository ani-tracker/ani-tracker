# Ani Tracker 架构与设计

最近核对：2026-07-21

本文描述当前实现，不记录阶段计划。功能完成度以 [实现状态](progress.md) 为准。

## 产品边界

Ani Tracker 是本地优先的桌面追番工具。桌面主机负责元数据采集、资源匹配、下载、媒体探测、播放器调用和自动化；局域网设备通过受限的 HTTPS PWA 查看数据、控制任务和播放媒体。

当前不提供云同步、公开互联网服务或真实内置 BT 核心。

## 技术栈

- Electron、React 18、TypeScript、electron-vite。
- Tailwind CSS、shadcn/ui 风格组件、Radix UI、lucide-react。
- better-sqlite3、qBittorrent Web API、ffprobe、FFmpeg。
- ArtPlayer、hls.js、Node.js `node:test`、pnpm。

## 运行架构

```text
Desktop Renderer              Remote HTTPS PWA
       | preload IPC                 | allowlisted RPC
       +---------------+-------------+
                       v
                Electron Main Process
                       |
       +---------------+----------------+
       |               |                |
  SQLite Repository  Domain Services  Platform Adapters
                       |                |
              Metadata / Sources   qBittorrent / FFmpeg
              Automation / Media   Player / Tray / OS
```

### 进程职责

- Renderer：页面状态、表单、交互反馈和响应式展示，不直接访问 Node.js 或本地文件。
- Preload：通过 `window.aniBridge` 暴露显式 IPC 方法，不透传任意频道。
- Main：组装 Repository、业务服务、调度器、远程网关和平台能力。
- Shared：保存领域模型、IPC 输入输出、主题协议和持久化版本。

新增主进程能力时，先在 `src/shared/contracts.ts` 定义契约，再连接 IPC、preload 和客户端。

## 持久化

当前只使用 SQLite：

- `createRepositoryRuntime` 延迟创建 `SqliteAppRepository`，初始化失败时直接报错，不回退 JSON。
- 数据库启用 WAL、外键、busy timeout、事务和索引。
- 空库在单个事务中写入平台默认设置和生产 seed。
- 当前应用数据版本为 `20`，SQLite schema 版本为 `13`。
- 设置、番剧目录、追番、单集、来源绑定、资源缓存、下载、媒体和通知均由同一 Repository 接口管理。

旧 JSON Repository 和自动迁移回退路径已移除。后续 schema 变化应继续使用幂等兼容逻辑或显式分版本迁移，不能依赖重建用户数据库。

## 核心服务

| 边界 | 当前实现 |
| --- | --- |
| 元数据 | Bangumi、AniList、Mikan 月度采集；详情按来源合并并缓存 |
| 资源来源 | RSS、Torznab、DMHY、Mikan、AniBT、ACGNX 适配器 |
| 网络保护 | 按来源代理、同域串行、最小间隔、请求合并、403/429 熔断 |
| 来源同步 | 每日增量同步、启动补跑、条件请求、跨重启缓存 |
| 资源匹配 | 标题/别名、集数、字幕组、分辨率、编码、位深、字幕和热度评分 |
| 下载 | 外部或托管 qBittorrent；任务确认、控制、文件优先级和状态合并 |
| 媒体 | 文件扫描、ffprobe 探测、完成任务后台入库 |
| 播放器 | 平台探测与适配；IINA 支持进度回写，其他适配器仅负责启动 |
| 自动化 | 手动/定时扫描、候选选择、自动下载、每日提醒和通知 |
| 远程 | 本地 CA、HTTPS 配对、方法白名单、媒体 Range/HLS 和外部播放器票据 |
| 图片 | 桌面协议与远程 HTTP 共用的磁盘缓存、签名 URL 和容量淘汰 |
| 桌面集成 | 托盘、关闭后后台运行、开机启动、系统通知和主题同步 |

## 关键业务流

### 新番与追番

1. 元数据 Provider 采集指定月份。
2. 合并服务优先用 external id，标题和别名作为辅助匹配。
3. Repository 更新本地番剧目录。
4. 用户加入追番后保存全局偏好、单集覆盖和来源绑定。

### 搜索与下载

1. 根据标题、原名和别名生成查询词。
2. `ReleaseSourceService` 调用启用来源，并保留部分成功结果。
3. 标题解析器补全集数、字幕组和媒体属性。
4. 匹配器评分排序；用户操作或自动化选择候选。
5. qBittorrent 返回真实任务后再持久化关联，避免长期保存伪任务。

### 媒体与播放

1. 下载刷新发现 completed 或 seeding 任务。
2. 后台扫描器读取文件并调用 ffprobe，失败时回退文件名信息。
3. MediaFile 与番剧、单集和下载任务关联。
4. 本地播放器由 Adapter Factory 选择；IINA 播放超过 90% 时回写已观看。

### 远程访问

1. 用户显式开启局域网 HTTPS，并安装本地 CA。
2. 远程设备使用一次性配对码换取独立令牌。
3. 网关只暴露注册表中的低风险方法，拒绝任意文件路径、凭据和本地危险操作。
4. 媒体使用短期会话读取原文件或 FFmpeg HLS；外部播放器使用独立内存票据。

## 客户端边界

桌面端包含：首页、我的追番、新番发现、资源搜索、下载队列、提醒中心、下载源和设置。

远程端只开放：首页、我的追番、新番发现、下载队列和提醒中心。远程追番与发现使用受限页面，不暴露下载源配置、完整设置、本地路径和删除文件能力。

所有页面必须提供加载、空数据、局部错误或整页错误状态，运行时异常不能表现为纯白屏。

## 安全与日志

- 元数据和资源请求统一经过受控 HTTP 客户端，不记录凭据和令牌。
- 远程网关校验 Host、Origin、请求体大小、频率和设备权限。
- 本地 CA 私钥和远程设备凭据使用 Electron `safeStorage` 保护。
- 关键启动、同步、下载、扫描、播放器和回退路径记录结构化日志。
- 用户可恢复错误应转为页面错误、Toast 或通知；不可恢复初始化错误由主进程记录并阻止错误状态继续运行。

## 扩展原则

- 新元数据来源实现 Provider 接口，新资源站点实现 Source Adapter。
- 新下载内核实现 `TorrentEngine`，不得把协议差异扩散到页面。
- 新播放器实现 `PlayerAdapter`，进度监控作为可选能力。
- 新平台差异收敛到 Provider、Service 或 Adapter，不在页面散布平台判断。
- 仅在确有替换需求或重复业务规则时抽象，避免为未确定需求预建层级。

## 当前限制

- `EmbeddedTorrentEngine` 仍是占位实现。
- 托管 qBittorrent 资源暂不覆盖 macOS arm64 和 Linux x64。
- PotPlayer、独立 mpv 和通用播放器没有播放进度回写。
- madVR 或外部渲染器链路尚未实现。
- 元数据冲突解释、更多站点适配器和跨平台真机验收仍需继续完善。
