# Ani Tracker

Ani Tracker 是一个本地桌面追番工具，围绕新番发现、追番规则、资源搜索、BT 下载、媒体扫描、播放器调用、远程播放和自动提醒构建完整追番闭环。

项目优先面向本地使用场景：业务数据保存在本机 SQLite，下载可连接外部 qBittorrent，也可使用随应用托管的 qBittorrent-nox。局域网设备通过 HTTPS PWA 配对访问，不开放裸 HTTP 或公网接口。

## 核心能力

- 新番发现：按年份、季度和月份采集番剧，合并 Bangumi、AniList、Mikan 等元数据。
- 我的追番：管理状态、集数、字幕组、自动下载、分辨率、编码、位深、字幕语言和目录偏好。
- 资源搜索：搜索 RSS、Torznab、DMHY、Mikan、AniBT、ACGNX，自动补全集数并关联我的追番。
- 来源保护：每个下载源可独立选择代理和采集间隔，同域名串行请求并对 403/429 自动熔断。
- 增量同步：默认每天 09:00 同步启用来源，错过后在当天首次启动时补跑，结果跨重启复用。
- 候选评分：综合番剧、集数、字幕组、分辨率、编码、位深、字幕语言和 seeders 选择资源。
- 下载管理：支持 qBittorrent Web API、Enhanced JSON、真实 hash 确认、托管 qBittorrent-nox、进度和文件优先级。
- 媒体扫描：通过标题、文件名和 ffprobe 提取容器、分辨率、编码、位深、音轨和字幕轨。
- 播放器集成：Windows 支持 Pure Codec PotPlayer、PotPlayer、mpv 和自动探测；其他系统按平台提供可用播放器。
- 远程 PWA：通过局域网 HTTPS 配对访问追番和下载，支持浏览器原文件播放、实时转码、字幕和播放列表。
- 外部远程播放：Windows 可调用 PotPlayer，macOS 可调用 IINA，从桌面主机安全拉取媒体。
- 图片缓存：桌面端与远程端共用磁盘缓存，默认上限 5GB，应用重启后继续命中。
- 主题系统：支持浅色、深色和跟随系统，主题变量与窗口外观保持同步。
- 自动化提醒：定时扫描新集、自动下载、桌面通知、通知中心、托盘和开机启动。

## 架构

```text
Desktop Renderer / Remote PWA
  -> Preload IPC / Remote HTTPS RPC
  -> Main Process Services
  -> Metadata / Source / Download / Media / Platform Adapters
  -> SQLite / qBittorrent / ffprobe / Local Player
```

主要服务边界：

- `MetadataProvider`：Bangumi、AniList、Mikan 等番剧元数据来源。
- `ReleaseSource`：RSS、Torznab 和站点资源适配器。
- `SourceRequestScheduler`：下载源代理选择、域名限速、请求合并、退避和熔断。
- `SourceSyncScheduler`：每日增量采集、启动补跑和持久化资源缓存。
- `TorrentEngine`：qBittorrent 兼容引擎和 libtorrent 内置引擎。
- `RemoteHttpGateway`：配对、RPC、远程静态页面、媒体和图片缓存路由。
- `ImageCacheService`：桌面协议与远程 HTTP 共用的持久图片缓存。
- `MediaProbeService`：文件名和 ffprobe 媒体探测。
- `PlayerService`：播放器探测、启动和播放进度回写。
- `AppearanceService`：主题、窗口背景和系统外观同步。
- `PlatformService`：托盘、开机启动、通知和平台路径。

## 技术栈

- Electron、React、TypeScript、Vite / electron-vite
- Tailwind CSS、shadcn/ui、lucide-react
- SQLite、better-sqlite3
- qBittorrent Web API、qBittorrent-nox
- ffprobe、FFmpeg、ArtPlayer、hls.js
- pnpm、Node.js `node:test`

## 关键目录

```text
src/main/core/automation       自动扫描、自动下载和候选评分
src/main/core/cache            统一图片缓存
src/main/core/downloads        qBittorrent 和下载任务管理
src/main/core/media            媒体扫描、播放器和转码
src/main/core/metadata         番剧元数据采集
src/main/core/remote           HTTPS 网关、配对、RPC 和远程媒体
src/main/core/sources          RSS、Torznab 和站点资源适配器
src/main/core/storage          SQLite repository、schema 和 seed
src/preload                    Electron preload bridge
src/renderer/src               桌面与远程 React UI
src/shared                     共享领域模型和契约
resources/qbittorrent          内置 qBittorrent-nox 资源
resources/ffmpeg               三平台 FFmpeg 预构建资源
native/torrent-core            桌面 sidecar 与 Android JNI 共用的 C++ 运行时
android                        Android 前台服务、AAR 与宿主 APK 工程
docs                           设计、进度、启动和专项计划
```

## 环境准备

推荐 Node.js 20 或 22，并使用 pnpm。

```powershell
pnpm.cmd install
```

## 运行模式

| 命令 | 桌面端 | 远程 PWA | 说明 |
| --- | --- | --- | --- |
| `pnpm.cmd dev` | Vite HMR | `.remote-pwa/renderer` | 推荐开发方式，启动前自动生成远程静态页面 |
| `pnpm.cmd dev:desktop` | Vite HMR | 不保证可用 | 仅调试桌面端，启动更快 |
| `pnpm.cmd preview` | 生产构建 | `out/renderer` | 自动重新构建后启动 Electron |
| `pnpm.cmd build` | 生成产物 | `out/renderer` | 同时准备目标平台 qBittorrent 与 FFmpeg 资源，不启动应用 |
| `pnpm.cmd package:desktop` | 安装包 | `release/` | 生成当前平台 Electron 安装包并内置 torrent-core |

### 日常开发

```powershell
pnpm.cmd dev
```

该命令先执行 `prepare:remote-renderer`，生成：

```text
.remote-pwa/renderer/index.html
.remote-pwa/renderer/assets/*
```

随后启动 Electron、主进程和桌面 renderer 的 Vite dev server。桌面端继续使用 `http://localhost:5173` 热更新；远程设备读取独立静态快照，避免 `electron-vite dev` 清理 `out/renderer` 后出现 `PWA_NOT_BUILT`。

修改远程界面后，可重新生成快照并刷新远程浏览器：

```powershell
pnpm.cmd run prepare:remote-renderer
```

### 生产预览

```powershell
pnpm.cmd preview
```

`electron-vite preview` 会先重新构建主进程、preload 和 `out/renderer`，再启动 Electron。修改主进程代码后必须重启应用，运行中的 Electron 不会热加载新 HTTP 路由。

### 类型检查、测试和构建

```powershell
pnpm.cmd run typecheck
pnpm.cmd run test:parsers
pnpm.cmd build
```

完整构建会更新 `out/qbittorrent`，并从仓库内的 `resources/ffmpeg` 校验、复制当前平台 FFmpeg/FFprobe 到 `out/ffmpeg`，构建过程不访问网络。交叉构建可向 `prepare:ffmpeg` 传入 `--platform` 和 `--arch`。若 qBittorrent-nox 正在从输出目录运行，应先正常退出 Ani Tracker，否则 Windows 可能返回 `EBUSY` 文件占用错误。

FFmpeg/FFprobe 版本升级属于显式资源维护：执行 `pnpm run download:ffmpeg` 可更新三平台预构建文件，执行 `pnpm run verify:ffmpeg` 可离线校验全部资源。维护下载命令支持标准 HTTP(S) 代理环境变量，以及 `FFMPEG_BINARIES_URL`、`FFPROBE_PACKAGES_URL` 镜像地址。

## 下载源网络与同步

- “下载源”页面为每个来源提供“使用全局代理”和最小采集间隔设置，范围为 250ms 到 60 秒；AniBT 固定不低于 3000ms。
- Mikan、DMHY、ACGNX 默认开启来源代理、间隔 1500ms；AniBT 默认开启来源代理、间隔 3000ms；Prowlarr 默认直连、间隔 250ms；自定义来源默认直连、间隔 1500ms。
- 来源代理依赖页面顶部的全局代理配置；全局模式为“关闭”时，即使来源开关已开启也会直连。
- 同一域名最多执行一个请求，实际间隔会增加最多 20% 随机抖动；相同并发请求只访问源站一次。AniBT 适配器与追番 RSS 共用队列，每分钟最多约 20 次。
- 403 按 10、20、30 分钟逐级熔断；429 按 1、5、15、30 分钟保护并遵守服务端 `Retry-After`。连续失败 3 次后至少暂停 30 分钟，状态保存在 SQLite，重启不会清空。
- 每日增量同步默认在本地时间 09:00 执行，可修改时间或关闭；当天尚未成功的来源会在应用启动后立即补跑。
- RSS 使用 `ETag`、`Last-Modified` 条件请求；其他来源按资源稳定 ID 增量写入。已完结追番的资源搜索结果在 SQLite 缓存 7 天，重启后仍可直接命中；资源明细保留 90 天，并作为来源临时不可用时的搜索兜底。

## 远程 PWA

1. 使用 `pnpm.cmd dev` 或 `pnpm.cmd preview` 启动完整应用。
2. 打开“设置 -> 远程设备”，启用“局域网 HTTPS”并保存。
3. 复制设置页显示的局域网地址，例如 `https://192.168.1.20:18083`。
4. 首次连接先下载并信任 `https://<主机IP>:<端口>/ani-tracker-ca.crt`。
5. 在桌面端生成六位一次性配对码，在远程页面完成配对。

远程设备令牌保存在浏览器本地存储；桌面端仅持久化令牌摘要，并使用 Electron `safeStorage` 加密。正常重启后无需重新配对，清除浏览器数据或在桌面端吊销设备后需要重新配对。

远程播放支持：

- 浏览器直接播放原文件，失败时可切换 FFmpeg HLS 实时转码。
- 读取内嵌或外置字幕，并按同番剧生成播放列表。
- Windows 远程设备可通过 `potplayer:` 调用 PotPlayer。
- macOS 远程设备可通过 `iina://weblink` 调用 IINA。

## 图片缓存

- 首次加载下载到设置中的 `storage.cacheDir/images`。
- 桌面 `ani-image://` 与远程 `/api/images/*` 共用同一份磁盘缓存。
- 默认上限 5GB，单图上限 20MB，超限按最近访问时间淘汰。
- 支持 JPEG、PNG、WebP、GIF、AVIF。
- 拒绝 localhost、私网目标、异常端口、非法 MIME 和篡改签名。
- 远程图片响应支持 `ETag`、`304` 和浏览器私有缓存。

`/api/images/resolve` 是需要配对令牌的签名解析接口，只接受 `POST`，不能直接在浏览器地址栏打开：

```powershell
curl.exe -k -X POST "https://<主机IP>:18083/api/images/resolve" `
  -H "Content-Type: application/json" `
  -H "Authorization: Bearer <设备令牌>" `
  --data '{"url":"https://example.com/poster.png"}'
```

接口返回 `/api/images/<签名令牌>`，该地址才是图片的 `GET` 路径。

## 常见问题

### `PWA_NOT_BUILT`

- 开发模式确认 `.remote-pwa/renderer/index.html` 存在。
- 执行 `pnpm.cmd run prepare:remote-renderer` 后刷新远程页面。
- 生产预览执行 `pnpm.cmd preview`，不要只运行旧的 Electron 进程。

### `/api/images/resolve` 返回 404

- 地址栏访问是 `GET`，该接口只接受 `POST`。
- 若 `POST` 仍返回 404，说明 Electron 主进程仍是旧版本，应完全退出并重新启动。

### HTTPS 证书警告

- 确认移动设备已安装并信任设置页提供的本地 CA。
- 使用设置页列出的 IP 地址访问，不要使用未写入证书的其他主机名。

### 端口占用

- 远程 HTTPS 默认端口为 `18083`，可在设置页修改。
- 托管 qBittorrent 默认使用 `18080`，被占用时会选择其他高位端口。
- 切换开发和预览进程前应正常退出已有 Ani Tracker 实例。

### 下载源返回 403 或 429

- 先在“下载源”顶部配置系统代理或手动代理，再为对应公网来源开启“使用全局代理”。
- 查看来源是否显示熔断状态；保护期内不要反复强制刷新，应用会在到期后以单个请求探测恢复。
- AniBT、DMHY 等公网来源可能启用 Cloudflare，频繁多关键词搜索会触发临时风控；应用会合并请求并持久化熔断状态，但不能绕过站点访问规则。
- AniBT 应保持单一稳定出口；应用不会使用代理池、轮换 IP 或模拟 Cloudflare Cookie。

## 项目文档

- `docs/design-plan.md`：总体设计。
- `docs/progress.md`：当前实现进度与验证结果。
- `docs/startup.md`：启动链路和环境说明。
- `docs/theme-system-progress.md`：主题系统专项计划。
- `AGENTS.md`：协作和编码约束。

## 尚未完成

- 真正的内置 BT 核心；`EmbeddedTorrentEngine` 仍是占位实现。
- 更多站点专用适配器和更完整的元数据冲突消解。
- qBittorrent-nox 的 macOS arm64 和 Linux x64 内置资源。
- madVR 播放链路和 Windows 播放进度监控。
