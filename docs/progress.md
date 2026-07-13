# Ani Tracker 进度表

最近更新：2026-07-13

## 已完成

### 基础框架

- 已完成 Electron、React、TypeScript、Vite、Tailwind CSS 桌面应用脚手架。
- 已接通主进程、preload、renderer 的 IPC bridge。
- 已定义共享 domain model 和 IPC/service contracts。
- 已实现 JSON 本地持久化和数据迁移框架。
- 已预留未来 SQLite schema：`src/main/core/storage/schema.sql`。
- 已完成 Home、我的追番、新番发现、资源搜索、下载、来源、设置、通知中心等页面。

### 新番发现和元数据

- 新番发现页使用独立的本地 anime catalog，不直接污染“我的追番”。
- 支持按首播年月读取本地目录、搜索中文名/日文名/别名、添加到我的追番。
- 已接入 AniList 月度采集，按季度查询后过滤到目标月份。
- 已新增 Bangumi 元数据来源：
  - 使用 Bangumi v0 subjects API 按动画类型、年份、月份采集。
  - 映射中文名、原名、简介、封面、首播日期和 Bangumi external id。
- 已新增 Mikan / 蜜柑计划元数据来源：
  - 解析季度番组页中的 `/Home/Bangumi/{id}` 条目。
  - 尝试读取详情页中的标题、原名、简介、封面、首播日期和 Bangumi 外链。
  - 对请求设置超时，避免站点不可达时长期阻塞。
- 新番采集已改为多来源兜底流程：
  - 优先 Bangumi。
  - Bangumi 无结果或失败时回退 AniList。
  - AniList 无结果或失败时回退 Mikan。
  - 每个来源的开始、完成、失败都会打印关键日志。
  - 单个来源失败不会导致已有缓存丢失。

### 我的追番和单集规则

- 支持我的追番 CRUD：
  - 标题、原名、别名。
  - 首播年月。
  - 追番状态。
  - 默认字幕组。
  - 自动下载开关。
  - 分辨率、编码、字幕偏好。
  - 单番下载目录。
- 支持 Episode 和 EpisodePreference JSON 持久化。
- 支持单集规则：
  - 添加下一集。
  - 编辑单集状态。
  - 默认继承追番字幕组。
  - 单集覆盖字幕组。
- 支持单集资源预览：
  - 按标题、原名、别名搜索。
  - 对候选资源评分排序。
  - 可将候选资源加入下载队列。

### 资源来源和匹配

- 已实现 RSS 和 Torznab release source adapter。
- 已实现 DMHY / 动漫花园 site adapter：
  - 搜索 `share.dmhy.org/topics/list`。
  - 解析标题、magnet、torrent、发布时间和体积。
  - 复用 release title enrichment。
- 已实现资源标题解析：
  - 字幕组。
  - 集数。
  - 分辨率。
  - 字幕语言。
  - 视频编码。
- 已实现资源评分：
  - 番剧标题和别名命中。
  - 集数命中。
  - 默认字幕组。
  - 单集字幕组覆盖。
  - 分辨率、编码、字幕偏好。
  - seeders。

### 下载和媒体

- 已实现 qBittorrent Web API 兼容引擎：
  - 添加 URL/torrent。
  - 列出任务。
  - 下载进度、速度、ETA。
  - 文件列表。
  - 暂停、恢复、删除。
  - 单文件优先级选择。
- 已实现下载队列自动刷新和文件选择 UI。
- 已保留 EmbeddedTorrentEngine 占位实现。
- 已实现播放器调用和 reveal file IPC。
- 已实现媒体信息提取链：
  - release title。
  - 文件名。
  - ffprobe。
- 已实现 ffprobe 媒体探测，失败时回退标题/文件名解析。
- 已实现下载任务媒体扫描和 MediaFile upsert。
- 已实现完成下载后的后台媒体自动扫描：
  - 下载状态刷新后触发。
  - 扫描 completed/seeding 任务。
  - 跳过已入库媒体。
  - 记录扫描结果和失败日志。
  - 不阻塞下载进度刷新。

### 自动化和提醒

- 已实现手动自动化扫描：
  - 扫描开启自动下载的追番。
  - 遵守手动/托盘触发冷却时间。
  - 遵守全局自动下载设置。
  - 遵守单番自动下载设置。
  - 遵守单集字幕组覆盖。
  - 跳过已下载、下载中、已观看的集数。
  - 选择评分最高的候选资源加入下载队列。
  - 将集数状态更新为 downloading。
  - 在顶部“扫描更新”区域显示结果计数。
- 已实现定时自动化扫描：
  - 随主进程启动。
  - 使用设置中的扫描间隔。
  - 可在设置页启停。
  - 保存设置后自动重启 scheduler。
  - 防止并发扫描。
  - 在设置页暴露运行状态、下次运行时间、上次运行时间和上次结果。
- 已实现桌面通知：
  - 定时/手动扫描添加下载或发生错误后发送通知。
  - 遵守“新集通知”设置。
- 已实现 Home 今日提醒：
  - 根据我的追番和单集 air time 计算今日更新。
  - 汇总总数、未播、可处理、下载中、已完成数量。
  - 展示每集时间、默认字幕组、状态和关联下载任务。
- 已实现每日提醒通知：
  - 每个本地日期只生成一次提醒。
  - 有今日更新时发送提醒。
  - 遵守现有桌面通知偏好。

### 通知中心和桌面集成

- 已实现应用内通知中心：
  - 存储 automation、download、system、reminder 通知历史。
  - 支持未读状态。
  - 支持标记单条/全部已读。
  - 支持清空通知。
- 已实现托盘集成：
  - 显示主窗口。
  - 扫描更新。
  - 退出应用。
- 支持关闭主窗口后最小化到托盘，并保持后台扫描。
- 支持 Windows/macOS 开机启动设置。
- 设置保存后立即应用桌面集成策略。

## 本次验证

本次通过以下检查：

```powershell
./node_modules/.bin/tsc -p tsconfig.typecheck.node.json --pretty false
./node_modules/.bin/tsc -p tsconfig.typecheck.web.json --pretty false
```

说明：

- `pnpm run typecheck` 在当前环境下先触发了 pnpm 11 的依赖状态检查，并尝试重建 `node_modules`；恢复依赖后，本次改用本地 `tsc` 直接验证。
- 本次没有重新执行生产 build。

## 尚未完成

- 更多站点专用 source adapter，例如 Mikan 资源页的专用下载源适配。
- 真实内置 BT 核心；当前 `EmbeddedTorrentEngine` 仍是占位实现。
- qBittorrent/qBittorrent-nox 随应用托管启动。
- SQLite repository 替换 JSON repository。
- 更完整的新番元数据聚合策略，例如多来源合并详情、冲突消解、增量刷新。
- madVR 播放链路或外部 renderer 集成。

## 下一步建议

1. 完善新番元数据多来源合并策略，让 Bangumi、AniList、Mikan 可以互相补字段，而不是只做顺序兜底。
2. 为 Mikan 资源页实现专用 release source adapter，补齐 RSS 之外的搜索能力。
3. 在领域行为继续稳定后，开始 SQLite repository 替换 JSON repository。
