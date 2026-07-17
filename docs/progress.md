# Ani Tracker 进度表

最近更新：2026-07-17

## 已完成

### 基础框架

- 已完成 Electron、React、TypeScript、Vite、Tailwind CSS 桌面应用脚手架。
- 已接通主进程、preload、renderer 的 IPC bridge。
- 已定义共享 domain model 和 IPC/service contracts。
- 已完成 SQLite Repository 全量切换。
  - SQLite 使用 WAL、外键、busy timeout、事务和查询索引。
  - 首次启动直接创建数据库，并在单事务中写入初始数据；生产 seed 不再包含演示追番、字幕组、剧集、下载、媒体和通知。
  - 二次启动通过应用数据版本标记跳过 seed，保留 SQLite 增量数据。
  - JSON Repository、旧数据迁移和失败回退路径已移除。
- 已新增平台默认配置模板：
  - 通过 `DefaultSettingsProvider` 抽象类生成默认配置，由 macOS、Windows 和通用子类提供平台差异。
  - macOS 默认下载目录为系统 Downloads 下的 `Ani Tracker`，用户数据使用 Electron `userData`，缓存使用 `~/Library/Caches/<app>`，日志使用 Electron `logs`。
  - Windows 默认下载目录为系统 Downloads 下的 `Ani Tracker`，用户数据使用 Electron `userData`，缓存优先使用 `%LOCALAPPDATA%\<app>\Cache`，日志使用 Electron `logs`。
  - 已新增 provider 单元测试，覆盖 macOS、Windows、通用模板和工厂分发。
  - 设置页已支持一键恢复当前平台默认配置模板，恢复后会重新应用桌面集成设置并重启自动化调度。
  - 新建 SQLite 数据库直接使用当前平台默认设置模板。
- 已启用 SQLite schema：`src/main/core/storage/schema.sql`。
- 已完成 Home、我的追番、新番发现、资源搜索、下载、来源、设置、通知中心等页面。

### 新番发现和元数据

- 新番发现页使用独立的本地 anime catalog，不直接污染“我的追番”。
- 支持按首播年月读取本地目录、搜索中文名/日文名/别名、添加到我的追番。
- 支持在新番卡片展示 Bangumi、AniList、Mikan、MAL 等 external id，方便排查多来源合并结果。
- 支持点击已知 external id 打开外部站点页面。
- 已接入 AniList 月度采集，按季度查询后过滤到目标月份。
- 已新增 Bangumi 元数据来源：
  - 使用 Bangumi v0 subjects API 按动画类型、年份、月份采集。
  - 映射中文名、原名、简介、封面、首播日期和 Bangumi external id。
- 已新增 Mikan / 蜜柑计划元数据来源：
  - 解析季度番组页中的 `/Home/Bangumi/{id}` 条目。
  - 尝试读取详情页中的标题、原名、简介、封面、首播日期和 Bangumi 外链。
  - 对请求设置超时，避免站点不可达时长期阻塞。
- 新番采集已改为多来源合并流程：
  - Bangumi 作为主记录来源。
  - AniList 补充别名、封面、简介、AniList/MAL external id。
  - Mikan 补充 Mikan external id 和可解析到的 Bangumi external id。
  - 优先使用 external id 匹配，同步使用规范化标题、原名、别名辅助去重。
  - 合并时优先使用中文标题展示，日文原名、罗马音、英文名等会保留到原名或别名中继续参与资源搜索。
  - 合并时保留主来源日期，补齐缺失的原名、简介、封面、别名和 external id。
  - Mikan 详情页使用限并发抓取，避免批量采集线性阻塞。
  - 每个来源的开始、完成、失败都会打印关键日志。
  - 单个来源失败不会导致已有缓存丢失。
- 新番发现页已使用共享标题 resolver 展示番剧名：
  - 主标题中文优先。
  - 副标题优先展示日文原名。
  - 别名徽章展示剩余罗马音、英文名或其他别名。

### 我的追番和单集规则

- 支持我的追番 CRUD：
  - 标题、原名、别名。
  - 首播年月。
  - 追番状态。
  - 默认字幕组。
  - 自动下载开关。
  - 分辨率、编码、字幕偏好。
  - 单番下载目录。
- 我的追番列表已使用共享标题 resolver 展示番剧名：
  - 主标题中文优先。
  - 副标题优先保留日文原名或其他原语言标题。
  - 编辑表单仍保留标题、原名、搜索别名等原始数据入口。
- 支持 Episode 和 EpisodePreference SQLite 持久化。
- 支持单集规则：
  - 添加下一集。
  - 编辑单集状态。
  - 默认继承追番字幕组。
  - 单集覆盖字幕组。
- 支持单集资源预览：
  - 按标题、原名、别名搜索。
  - 对候选资源评分排序。
  - 可将候选资源加入下载队列。
- 已实现番剧级字幕组自动发现：
  - 新追番保存后使用一个低请求成本来源在后台扫描，不阻塞追番保存。
  - 资源搜索、RSS、单集预览和自动扫描会复用已有结果增量补全，不额外发起字幕组专用请求。
  - 字幕组使用稳定动态 ID，并通过番剧—字幕组关联持久化；默认字幕组和单集覆盖只展示该番实际出现过的组。
  - 技术标签和占位文字不会被误存为字幕组，下载任务始终保存资源真实字幕组，不再回退写入默认组。
- 已优化我的追番交互：
  - 资源抽屉移除与追番卡片重复的下载统计，标题与资源方式合并为紧凑工具区。
  - 已绑定来源默认折叠为摘要，筛选和刷新工具支持小屏换行，资源列表自适应占用剩余高度。
  - 资源列表顶部和底部均提供同步的全选与批量下载操作。
  - 卡片操作菜单改为受控状态，离开后延迟 1 秒关闭，计时期间返回会取消关闭。

### 资源来源和匹配

- 已实现 RSS 和 Torznab release source adapter。
- 已实现 DMHY / 动漫花园 site adapter：
  - 搜索 `share.dmhy.org/topics/list`。
  - 解析标题、magnet、torrent、发布时间和体积。
  - 复用 release title enrichment。
- 已实现 Mikan / 蜜柑计划 site adapter：
  - 搜索 `mikanani.me/Home/Search`。
  - 解析 Episode 链接、Download torrent 地址、magnet、发布时间和体积。
  - 没有直接 torrent 链接时按 Episode id 兜底生成下载地址。
  - 对请求设置超时，避免站点不可达时长期阻塞。
  - 新增默认禁用来源 `mikan-site`，初始化与来源查询会自动补齐该来源。
- 已实现 AniBT site adapter：
  - 使用 `anibt.net/api/bgm/search` 将关键词匹配到番剧条目。
  - 优先读取 `anibt.net/rss/anime.xml` 的番剧 RSS，必要时回退到 `anibt.net/rss/magnets.xml` 最新资源 RSS。
  - 解析 AniBT RSS 扩展字段、内嵌 torrent 元数据、magnet、torrent、infoHash、发布时间、体积、集数、分辨率、字幕语言和编码标签。
  - 对请求设置超时并打印关键搜索日志。
- 已实现 ACGNX / 末日动漫资源库 site adapter：
  - 优先尝试公开 API 风格响应，兼容 `data/items/results/list/torrents/resources` 等常见返回结构。
  - API 返回 HTML 或不可用时使用站点搜索 HTML 解析兜底。
  - 解析标题、magnet、torrent、infoHash、发布时间、体积和 seeders。
  - 默认来源地址可配置，便于 ACGNX 域名或 API 路径变化后直接调整。
- 已新增默认禁用来源 `anibt` 和 `acgnx`，初始化与来源查询会自动补齐这两个来源。
- 已新增 Mikan/DMHY/AniBT/ACGNX 解析样例测试：
  - 覆盖 DMHY 资源行中的标题、magnet、torrent、发布时间、体积和媒体字段解析。
  - 覆盖 Mikan 搜索结果中的 Episode、Download torrent、magnet、体积和兜底 torrent 地址生成。
  - 覆盖 AniBT RSS 扩展字段、内嵌 torrent 元数据、magnet、torrent、infoHash 和媒体字段解析。
  - 覆盖 ACGNX JSON/API 风格响应和 HTML 搜索行兜底解析。
  - 覆盖 RSS item/enclosure 中的下载地址、发布时间、体积和标题媒体字段解析。
  - 覆盖 Torznab 查询参数、enclosure、seeders/size attr 和标题媒体字段解析。
  - 覆盖 XML helper 对文本节点、数组节点和空值的基础归一化。
  - 使用 Node 内置 `node:test`，不引入额外测试依赖。
- 已实现资源标题解析：
  - 字幕组。
  - 集数。
  - 分辨率。
  - 字幕语言。
  - 视频编码。
  - 已修正中文字幕标签识别，支持 `简体`、`简日`、`繁体`、`繁日` 等无英文单词边界的标签。
  - 已支持 `S02E03` 等多季集数格式。
  - 已修正续作编号误判：明确的 `- 01` 集数分隔符优先于标题中的裸数字，例如 `desu 2 - 01` 会解析为第 1 集。
  - 已新增边界样例测试，覆盖多季标题、小数集数、合集范围、总集篇、续作编号和 `10bit` 误判。
- 已新增元数据合并边界样例测试：
  - 覆盖标题归一化对全角括号、空白和标点的处理。
  - 覆盖同番标题/别名去重、external id 合并和别名重写。
  - 覆盖多来源合并时用更具体首播日期补全，同时保留主来源已有简介和封面。
- 已实现资源评分：
  - 番剧标题和别名命中。
  - 集数命中。
  - 默认字幕组。
  - 单集字幕组覆盖。
  - 分辨率、编码、字幕偏好。
  - seeders。
- 资源搜索页的追番选择器已使用共享标题 resolver 展示中文优先标题，同时搜索词仍保留标题、原名和全部别名。

### 下载和媒体

- 已实现下载任务与追番、单集、字幕组的持久关联：
  - 从番剧资源弹窗下载时自动复用或创建对应单集，并同步单集下载状态。
  - 下载任务保存番剧标题、集数和字幕组快照，qBittorrent 状态刷新后继续保留关联。
  - qBittorrent 任务使用 Ani Tracker 唯一标签和真实 torrent hash 回填关联。
  - 添加请求会等待 qBittorrent 返回真实任务后再持久化，不再创建 `pending-*` 占位任务。
  - 兼容 qBittorrent Enhanced 的 JSON 添加结果，使用 `added_torrent_ids` 直接确认已接收任务，避免“队列已添加但应用报错”导致关联丢失。
  - 刷新时可按标签合并历史占位任务和真实任务，删除重复记录并保留番剧、单集和字幕组关联。
  - 已规范化 Enhanced multipart 异常附带的标签边界文本，兼容既有污染标签数据。
  - 资源弹窗按字幕组分组、组内按集数展示，并阻止重复添加同一关联资源。
  - 下载队列按番剧和字幕组归并，展示已关联、下载中、已完成集数。
  - 我的追番列表展示每部番的下载集数概览。
- 已应用番剧目录模板，支持 `{year}`、`{month}`、`{title}`、`{originalTitle}`，单番目录覆盖优先。

- 已实现 qBittorrent Web API 兼容引擎：
  - 添加 URL/torrent。
  - HTTP torrent 地址先通过应用网络层下载并校验 bencode，再使用临时文件上传到 qBittorrent，完成后清理临时目录。
  - 同时兼容经典空响应/`Ok.` 与 Enhanced JSON 添加结果；`Fails.`、零成功 JSON 和请求超时会作为真实错误返回。
  - 添加成功后按返回 hash 或 Ani Tracker 标签轮询确认任务，magnet 元数据未就绪时允许文件列表暂时为空。
  - 列出任务。
  - 下载进度、速度、ETA。
  - 文件列表。
  - 暂停、恢复、删除。
  - 单文件优先级选择。
- 已实现 qBittorrent-nox 托管启动框架：
  - 新增项目内置二进制目录约定：`resources/qbittorrent/<platform>-<arch>/`。
  - macOS 支持 `qbittorrent-nox`、`qbittorrent-nox.app`、`qBittorrent-nox.app` 内部无头可执行文件查找。
  - Windows 只支持 `qbittorrent-nox.exe`。
  - Linux 只支持 `qbittorrent-nox`。
  - 设置页可开启“托管内置 qBittorrent-nox”和“随应用启动”，并可手动启动/停止。
  - 托管模式不接受 GUI 版 `qBittorrent.app`、`qbittorrent.exe` 或 `qbittorrent` 作为内置服务。
  - 托管模式默认使用 `127.0.0.1:18080`，如果配置端口低于 `10000` 或已被占用，会动态选择 `10000` 以上的可用端口。
  - 下载刷新、手动添加下载和自动化扫描会优先连接托管进程的实际 WebUI 地址。
  - 数据版本已升到 11，旧设置会切到新的高位端口默认模板。
  - 已新增 `prepare:qbittorrent` 和 `verify:qbittorrent` 脚本，用于复制和校验项目内置 nox 二进制。
  - 已预构建并内置 macOS Intel x64 与 Windows x64 版 `qBittorrent Enhanced nox 5.2.1.10`。
  - 两个平台产物均使用 `libtorrent v2.0.13` 静态链接，并携带 Qt、OpenSSL、zlib 和最小 Qt 插件运行时。
  - 托管启动会在 macOS app bundle 场景下自动设置 `QT_PLUGIN_PATH` 和 `OPENSSL_MODULES`，避免依赖用户 shell 环境。
  - 已确认官方 qBittorrent 5.2.3 只提供 macOS GUI DMG，没有 macOS nox 预构建包；`userdocs/qbittorrent-nox-static` 的 `aarch64` 是 Linux/musl，不适用于 Apple Silicon macOS。
- 已实现下载队列自动刷新和文件选择 UI。
- 已保留 EmbeddedTorrentEngine 占位实现。
- 已实现播放器公共接口、抽象基类和 IINA、PotPlayer、mpv、通用播放器子类。
- 已实现播放器调用和 reveal file IPC。
- 已实现 IINA 播放进度回写：
  - 通过 IINA 的 mpv JSON IPC 监听 `percent-pos`。
  - 播放进度达到 90% 后将关联单集标记为 `watched`。
  - 优先使用 MediaFile 关联，缺失时回退下载任务关联。
  - 播放结束后清理本地 IPC Socket。
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
  - 遵守优先字幕组缺失 fallback 策略，`wait` 和 `notify_only` 不自动回退到非优先字幕组，`candidate` 允许使用候补候选。
  - 跳过已下载、下载中、已观看的集数。
  - 选择评分最高的候选资源加入下载队列。
  - 将集数状态更新为 downloading。
  - 在顶部“扫描更新”区域显示结果计数。
  - 已新增自动化匹配/下载决策单元测试，覆盖单集字幕组覆盖、已有下载跳过、全局自动下载关闭和 fallback 策略。
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
  - 已新增自动化调度通知测试，覆盖 `notify_only` 无下载摘要通知、自动下载失败错误通知和调度级异常通知。
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
- 设置页已补充只读语言与标题策略说明：
  - 界面语言固定简体中文。
  - 番剧标题展示中文优先，副标题显示原名。
  - 搜索仍覆盖标题、原名、罗马音、英文名和自定义别名。

## 本次验证

本次通过以下检查：

```powershell
pnpm.cmd run typecheck
pnpm.cmd run test:parsers
pnpm.cmd build
git diff --check
```

说明：

- `pnpm.cmd run test:parsers` 当前会编译测试到 `out/test-node`，该目录已在 `.gitignore` 中。
- Node 测试当前共 `114` 项，覆盖标题集数边界、远程 torrent 上传、经典/Enhanced 添加结果、真实 hash 确认、确认超时和 SQLite 历史任务合并。
- 主进程和渲染进程 TypeScript 类型检查通过。
- 生产构建通过，并成功准备 macOS x64 与 Windows x64 qBittorrent 资源。
- `git diff --check` 通过。

## 尚未完成

- 更多站点专用 source adapter，例如 Nyaa、ACG.RIP 等。
- 真实内置 BT 核心；当前 `EmbeddedTorrentEngine` 仍是占位实现。
- qBittorrent-nox 平台二进制还缺 macOS arm64 和 Linux x64；当前已内置 macOS x64 与 Windows x64。
- 更完整的新番元数据聚合策略，例如冲突消解、增量刷新、字段来源展示。
- madVR 播放链路或外部 renderer 集成。
- Windows 播放状态监控：PotPlayer 子类已预留监控器抽象，待评估 PotPlayer 控制接口或 mpv IPC 替代方案。

## 下一步建议
3. 为后续 SQLite schema 变更补充分版本 migration 脚本。
