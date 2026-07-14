# Ani Tracker

Ani Tracker 是一个本地桌面追番工具，围绕“新番发现、追番管理、资源搜索、BT 下载、媒体扫描、播放器调用、自动提醒”构建完整追番闭环。

项目优先面向本地使用场景：数据保存在本机，下载引擎可连接外部 qBittorrent，也可使用随应用托管的 qBittorrent-nox。当前持久化使用 JSON 文件，SQLite schema 已预留。

## 核心能力

- 新番发现：按首播年月采集和搜索番剧，支持 Bangumi、AniList、Mikan 等元数据合并。
- 我的追番：管理追番状态、默认字幕组、自动下载、分辨率、编码、字幕偏好和单番下载目录。
- 单集规则：支持单集状态、字幕组覆盖、候选资源预览和手动加入下载队列。
- 资源搜索：统一搜索 RSS、Torznab 和站点适配器，自动解析字幕组、集数、分辨率、编码、字幕语言和种子信息。
- 自动化扫描：按规则搜索新集，选择评分最高的候选资源加入下载队列，并发送应用内或桌面通知。
- 下载管理：支持 qBittorrent Web API 兼容模式、托管 qBittorrent-nox、进度刷新、速度、ETA、暂停恢复、删除和文件优先级选择。
- 媒体扫描：通过 release title、文件名和 ffprobe 提取媒体编码、容器、分辨率、音轨和字幕轨信息。
- 播放器集成：支持调用本地播放器和定位已下载文件。

## SOA 架构

项目按可替换能力拆分为服务和适配器，UI 不直接绑定具体下载源、下载引擎或播放器实现。

```text
Renderer UI
  -> Preload Bridge
  -> IPC Contracts
  -> Main Process Services
  -> Source / Engine / Storage / Platform Adapters
```

主要服务边界：

- `MetadataProvider`：番剧元数据采集来源，例如 Bangumi、AniList、Mikan。
- `ReleaseSource`：资源搜索来源，例如 RSS、Torznab、DMHY、Mikan、AniBT、ACGNX。
- `TorrentEngine`：下载引擎抽象，当前包含 qBittorrent 兼容引擎和内置引擎占位。
- `MediaProbeService`：媒体文件扫描和 ffprobe 探测。
- `PlayerService`：本地播放器调用和文件定位。
- `PlatformService`：托盘、开机启动、通知、路径等平台能力。
- `NotificationService`：桌面通知和应用内通知历史。

这种拆分让新增站点、替换 BT 核心、切换播放器或迁移存储时，尽量只改对应适配层。

## 资源搜索链路

资源搜索是 Ani Tracker 的核心链路，手动搜索、单集候选预览和自动下载扫描都会复用同一套逻辑。

1. 根据番剧标题、原名、罗马音、英文名和自定义别名生成搜索词。
2. 读取已启用的下载源配置。
3. 并发调用各 `ReleaseSource` 适配器。
4. 将不同来源返回的 RSS、HTML、API、Torznab XML 结果归一化为统一 release model。
5. 解析标题中的字幕组、集数、分辨率、编码、字幕语言和体积。
6. 按番剧命中、集数命中、字幕组偏好、分辨率、编码、字幕语言和 seeders 评分。
7. 在资源搜索页、单集候选弹窗或自动化扫描中展示和下载最高匹配结果。

已支持的资源来源：

| 来源 | 类型 | 状态 |
| --- | --- | --- |
| RSS | 通用订阅源 | 已支持 |
| Torznab | 通用索引器 | 已支持 |
| DMHY / 动漫花园 | 站点适配器 | 已支持 |
| Mikan / 蜜柑计划 | 站点适配器 | 已支持 |
| AniBT | 站点适配器 | 已支持 |
| ACGNX / 末日动漫资源库 | 站点适配器 | 已支持 |

## 技术栈

- Electron
- React
- TypeScript
- Vite / electron-vite
- Tailwind CSS
- shadcn/ui 风格自定义基础组件
- pnpm
- JSON 本地持久化，后续迁移 SQLite
- qBittorrent Web API / qBittorrent-nox
- ffprobe

## 关键目录

```text
src/main                     Electron 主进程、IPC、平台能力和后台服务
src/main/core/sources         RSS、Torznab、站点资源搜索适配器
src/main/core/downloads       qBittorrent 兼容引擎和下载任务管理
src/main/core/automation      自动扫描、自动下载和候选资源匹配
src/main/core/media           媒体文件扫描和 ffprobe 探测
src/main/core/storage         JSON 持久化、seed data、SQLite schema
src/preload                   Electron preload bridge
src/renderer/src              React UI
src/shared                    主进程和渲染进程共享类型、契约和领域模型
docs                          设计文档、进度文档和启动记录
resources/qbittorrent         内置 qBittorrent-nox 资源目录
```

## 运行方式

推荐使用 pnpm。详细启动链路和验证记录见 `docs/startup.md`。

```powershell
pnpm.cmd install
pnpm.cmd dev
```

类型检查和构建：

```powershell
pnpm.cmd run typecheck
pnpm.cmd build
```

## 项目文档

- `docs/design-plan.md`：详细设计方案。
- `docs/progress.md`：当前实现进度。
- `docs/startup.md`：本地启动和验证记录。
- `AGENTS.md`：项目协作和编码约束。

## 当前状态

已完成可运行的第一版核心闭环：新番发现、我的追番、资源搜索、下载队列、下载源管理、媒体扫描、自动扫描、通知中心、播放器调用和托盘集成。

当前仍在完善：

1. 真正的内置 BT 核心。
2. qBittorrent 随应用托管启动体验。
3. SQLite 仓库替换 JSON 仓库。
4. 更多新番元数据源和站点专用适配器。
5. madVR 相关播放链路。
6. 托盘、开机启动和后台运行策略的跨平台细节。

## 备注

待评估：`https://github.com/equeim/tremotesf2` 作为单文件下载器。
