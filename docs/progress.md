# Ani Tracker 实现状态

最近核对：2026-07-23

状态只描述当前代码。已结束的阶段计划见 [历史归档](archive/README.md)。

## 当前基线

| 项目 | 状态 |
| --- | --- |
| 持久化 | SQLite-only；应用数据版本 21，Schema 版本 14 |
| 桌面页面 | 8 个一级页面及番剧详情二级页面 |
| 远程页面 | 首页、我的追番、新番发现、下载队列、提醒中心 |
| 下载内核 | libtorrent 内置核心与 qBittorrent 均可用 |
| 托管资源 | 本地已有 macOS x64、Windows x64；CI 源码构建四种桌面 qBittorrent-nox |
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

- libtorrent-rasterbar 2.1 内置核心、NDJSON sidecar、Session/fastresume 原子恢复和进程托管。
- 内置核心支持磁链、种子、任务状态、暂停、恢复、移除、文件优先级、限速及做种停止策略。
- 默认使用内置引擎；切换只影响新任务，旧任务继续按创建时引擎路由。
- 下载设置提供内置 libtorrent、内置 qBittorrent-nox、外部 qBittorrent WebUI 三种模式。
- 原生运行时由桌面 sidecar 与 Android JNI 共用，Android 前台服务应用移动端默认设置。
- Linux 与 Android 独立默认设置已加入；macOS、Windows 默认值保持兼容。
- GitHub Actions 已配置桌面安装包和 Android AAR/APK/AAB 构建，并以草稿 Release 交付标签产物。
- 桌面 Actions 固定源码、Qt 和 vcpkg 版本，构建并验证四个平台无头 qBittorrent-nox，同时发布独立 bundle。
- Android/iOS 移动端能力边界已确定：不打包远程 Renderer、FFmpeg/FFprobe 或媒体转码服务。
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

- Windows、Linux、macOS arm64 仍需在 GitHub runner 生成并签收最终资源。
- Android JNI 与前台服务已实现，AAR/APK/AAB 仍需 CI 构建及 arm64 真机恢复验收。
- 内置核心尚缺公网完整下载、网络切换、磁盘满和损坏 fastresume 的发布级回归。
- 四个平台 qBittorrent-nox 工作流尚待首次远端构建、最终应用注入与真实下载签收。
- 更多站点镜像和站点专有筛选项尚未实现。
- 元数据字段冲突解释、来源可见性和更细的增量刷新仍可完善。
- PotPlayer、独立 mpv 和自定义播放器没有观看进度回写。
- madVR 或其他外部渲染器链路未实现。
- macOS、Android、iOS、iPadOS 的完整真机回归尚未形成最终签收记录。
- 远程 PWA 离线缓存不作为当前已完成承诺。

## 维护优先级

1. 完成 torrent-core 与 qBittorrent-nox 缺失平台产物、签名和公网下载回归。
2. 实现 Android JNI/前台服务，再完成播放器进度和真机回归。
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

### 2026-07-23 内置 libtorrent 阶段验证

| 检查 | 结果 |
| --- | --- |
| `pnpm run typecheck` | 通过 |
| `pnpm run test:parsers` | 289/289 通过 |
| `pnpm run build:torrent-core` | 通过；libtorrent 2.1 |
| `pnpm run verify:torrent-core` | 通过；macOS x64 哈希、依赖、许可证、握手 |
| `status/configure/shutdown` | 退出码 0，优雅退出 |
| 设置页 1280/720px | 无横向溢出，只读字段与状态操作正常 |
