# Ani Tracker 实现状态

最近核对：2026-07-21

状态只描述当前代码。已结束的阶段计划见 [历史归档](archive/README.md)。

## 当前基线

| 项目 | 状态 |
| --- | --- |
| 持久化 | SQLite-only；应用数据版本 21，Schema 版本 14 |
| 桌面页面 | 8 个一级页面及番剧详情二级页面 |
| 远程页面 | 首页、我的追番、新番发现、下载队列、提醒中心 |
| 下载内核 | qBittorrent 可用；内置 BT 占位 |
| 托管资源 | macOS x64、Windows x64 qBittorrent-nox |
| 媒体资源 | macOS x64/arm64、Windows x64 FFmpeg/ffprobe |
| 主题 | 跟随系统、浅色、深色、3 套内置主题、自定义导入导出 |

## 已实现

### 基础与数据

- Electron 主进程、preload 白名单桥接、React Renderer 和共享契约已接通。
- SQLite Repository 覆盖设置、番剧、追番、单集、来源、下载、媒体和通知。
- 平台默认目录、数据库初始化、schema 兼容修复、WAL 和事务已启用。
- 页面错误边界、加载态、空状态和局部错误反馈已建立。

### 新番、详情与追番

- Bangumi、AniList、Mikan 月度采集和多来源合并。
- 中文优先标题、原名和别名搜索，以及 external id 展示与跳转。
- 番剧详情聚合、刷新、来源绑定、追番状态和关联操作。
- 我的追番 CRUD、自动下载偏好、字幕组、分辨率、编码、位深、字幕语言和目录覆盖。
- 单集状态、单集字幕组覆盖、RSS 订阅和候选资源预览。

### 资源来源与匹配

- RSS、Torznab、DMHY、Mikan、AniBT、ACGNX、Nyaa、ACG.RIP 资源适配。
- 按来源代理与采集间隔，同域串行、请求合并、抖动和跨重启熔断。
- 每日增量同步、启动补跑、RSS 条件请求、90 天资源缓存和完结作品查询缓存。
- 字幕组、集数/季度、分辨率、编码、位深、字幕语言和 seeders 解析与评分。
- 部分来源失败时保留可用结果，并将同步异常写入通知。

### 下载与媒体

- qBittorrent Web API、Enhanced 添加结果、真实 hash 确认和 Ani Tracker 标签关联。
- 添加、刷新、暂停、继续、移除、进度、速度、ETA 和文件优先级管理。
- qBittorrent-nox 托管启动、自动连接、动态高位端口、限速和做种停止目标。
- 下载任务与番剧、单集、字幕组和资源技术属性持久关联。
- 完成任务后台扫描、文件名回退、ffprobe 探测和 MediaFile 入库。
- 播放器探测、启动、文件定位；IINA 通过 mpv JSON IPC 回写观看进度。

### 自动化与桌面能力

- 手动、托盘和定时自动扫描，防并发、冷却、候选策略和自动下载。
- 每日追番提醒、系统通知、应用内通知、未读管理和清空。
- 托盘、关闭后后台运行、Windows/macOS 开机启动和设置即时应用。
- 浅色、深色、跟随系统、声明式主题包、严格校验、自定义编辑和导入导出。
- 桌面与远程共用图片磁盘缓存，包含容量淘汰、签名地址和 SSRF 防护。

### 远程访问与播放

- 默认本机访问，用户显式开启后提供局域网 HTTPS。
- 本地 CA、一次性配对码、独立设备令牌、吊销和重启恢复。
- 显式远程方法注册表，不转发完整 IPC 或本地危险操作。
- 浏览器原文件 Range 播放、FFmpeg HLS 回退、字幕和同番播放列表。
- Windows PotPlayer 与 macOS IINA 外部播放器拉流票据。

## 未完成或受限

- `EmbeddedTorrentEngine` 不执行真实 BT 下载。
- qBittorrent-nox 尚缺 macOS arm64、Linux x64 内置资源。
- 更多站点镜像和站点专有筛选项尚未实现。
- 元数据字段冲突解释、来源可见性和更细的增量刷新仍可完善。
- PotPlayer、独立 mpv 和自定义播放器没有观看进度回写。
- madVR 或其他外部渲染器链路未实现。
- macOS、Android、iOS、iPadOS 的完整真机回归尚未形成最终签收记录。
- 远程 PWA 离线缓存不作为当前已完成承诺。

## 维护优先级

1. 先补齐真实内置下载能力或明确长期只托管 qBittorrent。
2. 完成缺失平台资源、播放器进度和真机回归。
3. 再扩展站点适配器与元数据冲突解释。

## 验证入口

```powershell
pnpm.cmd run typecheck
pnpm.cmd run test:theme
pnpm.cmd run test:parsers
pnpm.cmd build
git diff --check
```

完整构建会复制目标平台 qBittorrent 和 FFmpeg 资源；若托管 qBittorrent 正占用输出目录，应正常退出应用后重试。

### 2026-07-21 文档归档验证

| 检查 | 结果 |
| --- | --- |
| `pnpm run typecheck` | 通过 |
| `pnpm run test:theme` | 通过；浅色、深色各 38 个令牌及对比度合格 |
| `pnpm run test:parsers` | 246/246 通过 |
| Markdown 本地链接 | 全部可解析 |
| `git diff --check` | 通过 |
