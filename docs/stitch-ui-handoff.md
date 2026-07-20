# Ani Tracker Stitch UI 全量改版交接文档

交接日期：2026-07-20

当前分支：`master-stich-ui`

设计项目：[Stitch 12075319551332625536](https://stitch.withgoogle.com/projects/12075319551332625536)

实施计划：[stitch-ui-redesign-plan.md](./stitch-ui-redesign-plan.md)

人工验收：[stitch-ui-manual-acceptance-checklist.md](./stitch-ui-manual-acceptance-checklist.md)

## 1. 当前结论

Stitch UI 全量改版、暗黑模式、自定义主题、主题导入导出、远程端适配和 AniBT 网络保护均已落地。用户验收文档中标注的页面问题已经按设计调整，代码修复已分阶段提交并推送到远端 `master-stich-ui`。

本轮最后一个 UI 修复提交为：

```text
cf0a0ea fix: 移除资源搜索多余工作区外框
```

自动回归全部通过。正式构建的 main、preload、renderer 均通过；仅最后的 qBittorrent 资源重拷贝被当前运行中的 `qbittorrent-nox` 锁定，详见第 7 节。

## 2. 已批准并执行的设计口径

| 项目 | 最终口径 |
| --- | --- |
| 全局导航 | 桌面宽屏 224px 完整侧栏；中等桌面 72px 收缩侧栏；移动端 320px 左侧 Sheet |
| 页面滚动 | 导航固定，主内容独立滚动；长 Sheet 固定标题与底部操作，仅正文滚动 |
| 视觉语言 | Anime Editorial，小圆角、细边界、紧凑信息密度、语义色，不使用营销页结构 |
| 新番时间表 | 作为“新番发现”的第二视图，不增加一级导航 |
| 默认主题 | 保留 `default` ID，直接全量切换到新令牌，不考虑旧默认主题迁移 |
| 主题能力 | 保留浅色、深色、跟随系统、自定义调色、复制、编辑、删除、导入和导出 |
| UI 组件 | 优先复用 shadcn/ui；Toast 用 Sonner；重要结果进入提醒中心；破坏性操作用 AlertDialog |
| 响应式 | 以 `1440x900`、`1024x768`、`768x1024`、`390x844` 为验收矩阵 |

设计令牌和页面实现继续以 [DESIGN.md](./DESIGN.md) 为准。业务组件只消费语义令牌，不应添加页面专属固定颜色或手写暗黑覆盖。

## 3. 已完成范围

| 模块 | 主要实现 |
| --- | --- |
| 应用壳 | 统一桌面完整/收缩侧栏、移动导航 Sheet、未读数、二级页面返回和远程入口过滤 |
| 公共 UI | 页面标题、面包屑、摘要带、筛选工具栏、固定操作栏、加载/空/错误状态和确认弹窗 |
| 首页 | 今日更新、待处理、活动下载、最近完成和来源健康摘要 |
| 新番发现 | 季度图鉴、时间表、年份/季度/月/关键词/排序筛选和采集入口 |
| 我的追番 | 状态筛选、紧凑列表、规则 Sheet、资源 Sheet、任务 Sheet 和危险操作确认 |
| 资源搜索 | 追番联想、集数识别、来源摘要、部分失败保留、结果列表、排序、分页和下载操作 |
| 下载队列 | 地址添加、番剧/字幕组分组、进度、速度、文件选择、播放、定位和任务控制 |
| 提醒中心 | 四项紧凑统计、类型筛选、时间分组、全部已读和清空确认 |
| 下载源 | 面包屑、代理、每日同步、来源启停、凭据、间隔、编辑 Sheet 和状态反馈 |
| 设置 | 七个分区、页内导航、修改后浮动保存、主题管理和远程桌面配置 |
| 番剧详情 | 本地详情、主动刷新、追番状态、规则/资源/任务入口和响应式长页 |
| 远程端 | 统一移动工作台；隐藏本地路径、下载源配置和未授权桌面危险操作 |

## 4. 主题与图片取色交接

- 主题模式：`light`、`dark`、`system`。
- 内置与自定义主题共用声明式 Theme Pack v1。
- 每套明暗主题精确包含 38 个令牌。
- 导入限制：最大 128KB、字段白名单、HSL 通道值、圆角 0-12px、拒绝 CSS/JavaScript/未知字段。
- 设置页支持预览、导入、导出、复制、编辑、应用和删除自定义主题。

图片取色提示词位于 [image-to-ani-theme-prompt.md](./image-to-ani-theme-prompt.md)，可导入示例位于 [image-palette-example.ani-theme.json](./image-palette-example.ani-theme.json)。后续不需要在应用中接入图片识别服务；将图片和提示词交给视觉模型，得到 JSON 后从设置页导入即可。

## 5. AniBT 网络策略

- 使用单一稳定出口，不使用代理池、IP 轮换或模拟 Cloudflare Cookie。
- 请求携带正常 `User-Agent`、`Accept`、`Accept-Language`。
- AniBT 同域请求串行，最小间隔 3 秒，约每分钟不超过 20 次。
- 相同查询并发合并，避免重复访问源站。
- 完结作品搜索结果缓存 7 天，并持久化到 SQLite；重启后仍可命中。
- `forceRefresh` 只在用户明确刷新时绕过查询缓存，仍受同域限流约束。
- 403 第 1/2/3 次分别熔断 10/20/30 分钟；到期只放行一个半开探测。
- 429 遵循 `Retry-After`，并按 1/5/15/30 分钟逐级保护。
- 熔断状态跨重启保存，成功探测后清零。

人工验收不得通过高频请求主动诱发 Cloudflare 403，只检查自然异常时的可见提示。时间序列、半开探测和跨重启状态由自动测试覆盖。

## 6. 关键提交索引

```text
9d9a5f0 feat: UI 改造计划、图片取色主题生成提示词
a329275 feat: 重建 Anime Editorial 明暗主题
2a37090 feat: 统一全平台应用导航壳层
6a72c74 feat: 统一页面组合与危险操作确认
1927b9c feat: 重构首页发现与提醒工作台
9cab855 feat: 重构我的追番工作台
7c53c52 feat: 重构资源与下载工作台
02aec6d feat: 重构设置与主题管理工作台
1031c2b feat: 完成远程端统一工作台改造
ff9841d fix: 补齐自定义主题对比度验收
8b963b3 fix: 修复应用壳双滚动
29a66b8 fix: 完善 AniBT 限流熔断与完结缓存
43a81f9 feat: 完善番剧详情页面与元数据聚合
f81b00e feat: 对齐操作页与设置页 Stitch 视觉
890a2b3 fix: 完善番剧详情交互与首页摘要
710cd0a fix: 对齐番剧详情分区导航样式
120ea37 feat: 对齐首页发现与追番工作台视觉
d3a4451 fix: 收紧资源搜索与提醒页层级
cf0a0ea fix: 移除资源搜索多余工作区外框
```

## 7. 验收记录

交接前执行结果：

| 检查 | 结果 |
| --- | --- |
| `pnpm.cmd run typecheck` | 通过 |
| `pnpm.cmd run test:theme` | 通过；浅色、深色各 38 个令牌，对比度通过 |
| `pnpm.cmd run test:parsers` | 通过；219/219，包含 AniBT 限流、缓存、403/429 熔断 |
| `git diff --check` | 通过 |
| main / preload / renderer 生产构建 | 通过 |
| qBittorrent 资源隔离复制 | 通过；darwin-x64 与 win32-x64 均完整 |
| 完整 `pnpm.cmd build` | 最后一步未完成；运行中的 `qbittorrent-nox` 锁定 `out/qbittorrent/win32-x64` |

此前已在 `1440x900` 对三张标注图完成复验：

- 我的追番：移除重复标题，添加按钮右上对齐，筛选上移，无横向溢出。
- 资源搜索：移除重复标题/说明，搜索区上移；最后进一步移除搜索工作区多余外框。
- 提醒中心：四个统计项统一为紧凑尺寸，移除大外框，无横向溢出。

本次会话无法重复采集其余固定视口截图：本机 IPv4/IPv6 本地监听均返回 `listen UNKNOWN`，桌面自动化服务也未运行。不要将此环境限制误记为页面缺陷；后续人工复验仍以现有验收清单为准。

## 8. 人工复验重点

1. 在 `1024x768` 检查 72px 收缩侧栏、Tooltip、未读数和主内容横向溢出。
2. 在 `768x1024`、`390x844` 检查顶部菜单、320px Sheet、焦点恢复、44px 触控区和长标题换行。
3. 在浅色、深色、跟随系统及 `berry-mint`/导入主题下检查正文、次要文字、焦点环、Toast、Dialog、Sheet。
4. 检查设置页仅在内容改变后显示底部居中保存区，并可滚动到最后一个配置项。
5. 检查资源搜索输入只有 InputGroup 自身边框，外层不再出现卡片边框或底色。
6. 检查首页、发现、追番、搜索、下载、提醒、来源、设置切换后无双滚动、遮挡和内容跳位。
7. 不主动高频访问 AniBT；仅在自然 403/429 时检查熔断提示与保护期内禁止重试。

详细步骤与业务回归项见 [stitch-ui-manual-acceptance-checklist.md](./stitch-ui-manual-acceptance-checklist.md)。

## 9. 当前工作树保护

交接文档提交之外，工作树仍有用户或并行任务改动。后续任务必须保留，不得重置、还原或混入无关提交：

```text
.gitignore
AGENTS.md
docs/anime-detail-acceptance.md
docs/stitch-ui-manual-acceptance-checklist.md
docs/ui-refactor-progress.md（已暂存删除）
src/renderer/public/sw.js（删除）
src/renderer/src/features/anime-detail/AnimeDetailPage.tsx
docs/assets/
skills-lock.json
```

提交时继续使用路径限定或 `git commit --only`。开始新任务前先执行 `git status --short --branch`，不要使用 `git reset --hard` 或 `git checkout --` 清理工作树。

## 10. 下次任务启动

优先阅读：

1. 本文档。
2. [stitch-ui-redesign-plan.md](./stitch-ui-redesign-plan.md)。
3. [stitch-ui-manual-acceptance-checklist.md](./stitch-ui-manual-acceptance-checklist.md)。
4. [DESIGN.md](./DESIGN.md)。

常用回归命令：

```powershell
pnpm.cmd run typecheck
pnpm.cmd run test:theme
pnpm.cmd run test:parsers
pnpm.cmd build
git diff --check
```

若 `pnpm.cmd build` 再次在 qBittorrent 资源复制阶段报 `EBUSY`，先确认没有下载任务，再正常退出正在运行的 Ani Tracker/qBittorrent，之后重新执行构建。不要为了构建强制终止正在下载的任务。
