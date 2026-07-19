# Ani Tracker 番剧详情功能交接文档

交接日期：2026-07-20

当前分支：`master-stich-ui`

功能提交：`43a81f9 feat: 完善番剧详情页面与元数据聚合`

专项计划：[anime-detail-redesign-plan.md](./anime-detail-redesign-plan.md)

验收记录：[anime-detail-acceptance.md](./anime-detail-acceptance.md)

## 1. 当前结论

番剧详情主体功能已经实现并提交。工程检查全部通过，Electron 桌面端已完成核心链路手工验收。

尚需补齐四档固定视口截图、未追番添加闭环和主题回归，详见第 7 节。

## 2. 已完成功能

- 新番发现图鉴、时间表和我的追番均可进入番剧详情。
- 未追番与已追番共用 `AnimeDetailPage`，不维护两套页面。
- 详情首屏只读取本地 SQLite，主动刷新时才访问外部元数据来源。
- AniList、Bangumi、Mikan 可补全横幅、格式、集数、放送、制作、职员等详情字段。
- SQLite schema 已升级至 13，`anime_catalog` 使用 `detail_json` 保存详情。
- 旧数据库可迁移；详情 JSON 损坏时回退为空并记录日志。
- 已接通 IPC、preload、renderer API 和远程只读详情接口。
- 已追番状态展示进度、字幕组、自动下载、清晰度、编码和字幕偏好。
- 规则、资源和任务动作复用“我的追番”现有业务入口。
- 未追番可添加追番或带入资源搜索；移除追番使用确认对话框。
- 返回时保留来源页面状态，并支持浏览器历史和桌面端 `Esc` 返回。
- 加载、空、错误、离线、缓存陈旧和部分来源失败均有页面状态。

## 3. 关键实现边界

### 3.1 共享契约

- `src/shared/domain.ts`：`AnimeDetailMetadata` 与 `Anime.detail`。
- `src/shared/contracts.ts`：`AnimeDetailResult` 和详情 API 契约。
- `src/shared/anime-detail.ts`：详情字段规范化、安全解析和合并。

详情字段均为可选；没有真实数据时隐藏对应行或分区，不写设计稿示例值。

### 3.2 主进程与存储

- `src/main/core/metadata/anime-detail-service.ts`：本地聚合与主动刷新。
- `src/main/core/metadata/*-metadata-provider.ts`：三来源详情解析。
- `src/main/core/repositories/sqlite-app-repository.ts`：详情读写与迁移。
- `src/main/core/storage/sqlite-schema.ts`：schema 版本 13。
- `src/main/ipc.ts`、`src/preload/index.ts`：详情 IPC 和 bridge。

刷新策略按已有 external id 增量请求。单来源失败不能清空本地已有详情。

### 3.3 渲染进程

- `src/renderer/src/features/anime-detail/AnimeDetailPage.tsx`：详情长页与交互。
- `src/renderer/src/features/anime-detail/anime-detail-view-model.ts`：纯视图模型。
- `src/renderer/src/App.tsx`：二级视图、历史和返回恢复。
- `src/renderer/src/components/app-shell.tsx`：桌面与移动二级头部。
- `DiscoveryPage.tsx`、`MyAnimePage.tsx`、远程页面：详情入口。

页面正文采用无外框分区；追番概览使用完整 `Card` 组合。UI 继续复用现有 shadcn/ui 组件和 Lucide 图标。

## 4. 已执行验证

```powershell
pnpm.cmd run typecheck
pnpm.cmd run test:parsers
pnpm.cmd build
git diff --check
```

结果：

- TypeScript 检查通过。
- 218 项测试全部通过，0 失败。
- main、preload、renderer 构建通过。
- qBittorrent 资源准备通过。
- 本功能提交路径无空白字符错误。
- 构建仍有项目已知 ESM warning，不影响产物。

## 5. 已完成手工验收

在 Windows Electron 开发模式、约 `1228x813` 实际窗口中确认：

- 首页和新番发现无白屏。
- 2026 夏季目录可加载 38 部番剧。
- 图鉴卡片可进入应用壳内的详情二级页面。
- 已追番详情可显示海报、标题、原名、评分、简介和追番概览。
- 返回、刷新、编辑规则、查看资源和更多操作均有可访问名称。
- 当前窗口未发现横向溢出、遮挡、双顶栏或双滚动条。

## 6. 下次会话建议入口

优先阅读：

1. `docs/anime-detail-acceptance.md`
2. `docs/anime-detail-redesign-plan.md`
3. `src/renderer/src/features/anime-detail/AnimeDetailPage.tsx`
4. `src/main/core/metadata/anime-detail-service.ts`

建议启动命令：

```powershell
pnpm.cmd dev
```

若只做工程回归，依次执行第 4 节的四条命令。

## 7. 待完成验收

- 保存 `1440x900`、`1024x768`、`768x1024`、`390x844` 四档截图。
- 分别留档未追番和已追番详情状态。
- 手工完成一次“添加追番 -> 原地切换已追番”。
- 分别打开规则、资源和任务，再检查返回上下文。
- 验证移动端无双顶栏、无横向溢出，简介展开和收起可用。
- 验证浅色、深色、跟随系统和一个自定义主题。
- 验证远程只读详情不暴露桌面路径、下载源配置和未授权动作。

完成后更新 `docs/anime-detail-acceptance.md`，将结论由“有条件通过”改为“通过”。

## 8. 当前工作区注意事项

番剧详情提交之外仍存在用户已有改动，后续不得回退或混入无关提交：

- `.gitignore`
- `AGENTS.md`
- `docs/stitch-ui-manual-acceptance-checklist.md`
- `docs/ui-refactor-progress.md` 的暂存删除
- `src/renderer/public/sw.js` 的删除
- `docs/assets/`
- `skills-lock.json`

提交时继续使用路径限定或 `git commit --only`，避免覆盖这些改动。

## 9. 日志与排障

详情主流程日志前缀为 `[anime-detail]`。

若出现白屏，优先检查：

- `window.aniBridge` 是否存在。
- preload 是否加载 `out/preload/index.mjs`。
- renderer 控制台是否有图标导出或运行时错误。
- SQLite schema 是否已迁移到 13。
- `detail_json` 是否包含损坏数据。

若外部刷新失败，应先确认页面仍保留本地内容，再查看各 provider 和网络策略日志。
