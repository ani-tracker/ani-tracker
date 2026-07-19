# Ani-tracker 番剧详情专项实施计划

更新时间：2026-07-19
计划状态：实施完成，待验收文档归档

## 1. 目标

- 补齐「新番发现 -> 番剧卡片 -> 番剧详情」完整链路。
- 落地 Stitch 中「番剧详情 - Ani-tracker」「番剧详情 (已追番) - Ani-tracker」「番剧详情 (移动端) - Ani-tracker」三张有效设计。
- 让未追番和已追番共享同一详情能力，通过真实追番状态切换操作区和追番概览。
- 扩展当前番剧元数据契约和 SQLite 持久化，所有详情字段来自真实数据，不写静态占位值。
- 保留 Electron、远程 PWA、明暗主题、自定义主题、图片缓存和现有追番业务能力。

## 2. 与总计划的关系

- 本计划是 [stitch-ui-redesign-plan.md](./stitch-ui-redesign-plan.md) 的独立专项计划。
- 总计划 P4 继续负责新番季度图鉴和时间表；本计划负责从发现页进入后的二级详情流程。
- 总计划 D1-D4、全局导航、主题令牌、圆角和 shadcn/ui 约束继续生效。
- 当设计稿局部导航与 D1 冲突时，以现有统一 `AppShell` 为准，不复制设计稿中的另一套侧栏或顶栏。

## 3. 设计源与实现映射

| Stitch 界面 | 业务状态 | 实现口径 |
| --- | --- | --- |
| 番剧详情 - Ani-tracker | 未追番、桌面 | 海报、标题、状态、评分、简介、基础信息、放送、制作、别名、外链、添加追番和资源搜索 |
| 番剧详情 (已追番) - Ani-tracker | 已追番、桌面 | 在公共详情上增加追番状态、进度、字幕组、自动下载、编辑规则、资源和任务入口 |
| 番剧详情 (移动端) - Ani-tracker | 未追番/已追番、移动 | 单列长页、局部返回栏、紧凑海报信息、全宽主操作、简介展开和制作信息列表 |

设计稿仅决定信息层级、视觉关系和响应式行为。设计稿中的示例作品、评分、集数、职员、制作公司和放送时间不得进入生产数据。

## 4. 已固定实施决策

| 编号 | 决策 | 实施口径 |
| --- | --- | --- |
| AD1 | 页面形态 | 详情是应用壳内二级页面，不使用 Dialog、Sheet 或独立主导航入口 |
| AD2 | 统一页面 | 未追番和已追番共用 `AnimeDetailPage` 与纯视图模型，不维护两套页面 |
| AD3 | 入口 | 新番海报/标题、时间表条目、我的追番条目均可进入详情 |
| AD4 | 状态恢复 | 返回后恢复来源页筛选条件、滚动位置和键盘焦点 |
| AD5 | 数据真实性 | 不显示 `24 集`、`TV`、`暂无工作室`等推测或占位值；字段缺失时隐藏对应行或整个分区 |
| AD6 | 添加追番 | 沿用当前默认规则，成功后原地切换为已追番状态，并使用 Sonner Toast 反馈 |
| AD7 | 全局导航 | 桌面继续使用 224/72px 统一侧栏；移动端详情用返回栏替换普通页面标题栏，不出现双顶栏 |
| AD8 | 元数据刷新 | 首屏先读本地 SQLite；用户主动刷新时按 external id 增量补全，不用整月采集阻塞详情页 |

## 5. 页面入口与导航模型

### 5.1 入口

- 新番图鉴：海报和标题区域提供明确的「查看详情」可访问名称；卡片内的添加追番、外链按钮保持独立，避免按钮嵌套。
- 新番时间表：标题信息区进入详情，右侧添加按钮继续只执行添加追番。
- 我的追番：条目主信息区进入详情；资源、规则、任务快捷操作继续执行原动作。
- 远程端：从远程发现和远程追番页进入同一只读详情骨架，再按远程权限显示操作。

### 5.2 视图状态

在 `App.tsx` 建立轻量二级视图状态，不引入完整路由库：

```ts
type AppView =
  | { kind: "page"; pageId: PageId }
  | {
      kind: "animeDetail";
      animeId: string;
      origin: {
        pageId: "discovery" | "myAnime";
        state: DiscoveryReturnState | MyAnimeReturnState;
        scrollTop: number;
      };
    };
```

- 进入详情时保存来源页状态和主滚动容器位置。
- 返回时先恢复页面筛选，再恢复滚动和触发元素焦点。
- 通过 `history.pushState` / `popstate` 接管二级视图，支持页面返回按钮、`Esc`（桌面）和浏览器/系统后退；三个入口共享同一关闭逻辑。
- `Esc` 仅在没有打开浮层且焦点不在可编辑控件时返回，避免误关闭表单。
- 本专项不增加外部深链接由，应用重启仍从主页面进入。

### 5.3 应用壳适配

- `AppShell` 增加可选的二级页面标题、返回动作和移动端头部模式。
- 桌面侧栏始终保留，详情正文内部显示面包屑和返回动作。
- 移动端二级模式隐藏菜单/提醒组合头部，改为 56px 返回栏；返回栏仍保留安全区。
- 详情切换期间不重建 `SidebarProvider`，避免侧栏宽度和页面内容跳动。

## 6. 共享数据契约

### 6.1 番剧详情元数据

在 `src/shared/domain.ts` 增加独立的可选详情对象，避免把大量低频字段平铺到 `Anime`：

```ts
export interface AnimeDetailMetadata {
  bannerUrl?: string;
  format?: AnimeFormat;
  episodeCount?: number;
  airingStatus?: AnimeAiringStatus;
  endDate?: string;
  nextAiringAt?: string;
  broadcast?: AnimeBroadcastSchedule;
  genres?: string[];
  studios?: string[];
  staff?: AnimeStaffCredit[];
  sourceMaterial?: string;
  durationMinutes?: number;
  contentRating?: string;
  demographic?: string;
  ranking?: AnimeRanking;
  metadataSources?: string[];
  refreshedAt?: string;
}
```

`Anime` 新增 `detail?: AnimeDetailMetadata`。所有子字段可选，旧数据库记录读取后保持有效。

### 6.2 枚举与结构

- `AnimeFormat`：`tv`、`movie`、`ova`、`ona`、`special`、`music`、`unknown`。
- `AnimeAiringStatus`：`upcoming`、`airing`、`finished`、`hiatus`、`cancelled`、`unknown`。
- `AnimeBroadcastSchedule`：星期、时间、时区；允许只有 `nextAiringAt`。
- `AnimeStaffCredit`：姓名、职责、来源标识；按“规范化姓名 + 职责”去重。
- `AnimeRanking`：名次、来源和可选榜单类别；不同来源的排名不直接比较。
- 未知枚举在解析层收敛为 `unknown`，页面不直接消费上游字符串。

### 6.3 详情聚合契约

在 `src/shared/contracts.ts` 增加：

```ts
export interface AnimeDetailResult {
  anime: Anime;
  myAnime?: MyAnime;
  episodes: Episode[];
  fansubGroups: FansubGroup[];
  stale: boolean;
  partialErrors: Array<{ source: string; message: string }>;
}
```

新增 renderer API：

- `getAnimeDetail(animeId)`：只读本地聚合结果，供首屏和操作后刷新。
- `refreshAnimeDetail(animeId)`：按已知 external id 主动补全，单来源失败不清空已有字段。

详情页不直接并发拼装多个仓库调用；主进程 `AnimeDetailService` 统一组合目录、追番、集数和字幕组数据。

## 7. 元数据采集与合并

### 7.1 来源扩展

| 来源 | 优先补全字段 |
| --- | --- |
| Bangumi | 中文标题、简介、首播/结束日期、制作信息、职员、别名、分级和 external id |
| AniList | 横幅图、格式、集数、放送状态、下一次放送、题材、工作室、时长、原作、评分和排名 |
| Mikan | Mikan/Bangumi 关联、标题、封面、简介和可解析的放送信息 |

不新增第四个元数据站点；MAL 只保留现有 external id 和外链能力。

### 7.2 按需刷新

- 抽取 `AnimeDetailMetadataProvider` 接口，各来源按 external id 查询单个条目。
- 没有 external id 的来源不发起猜测请求，继续使用本地月度采集结果。
- 使用现有 `MetadataHttpClient` 的代理、超时、限流、退避和日志能力。
- 同一番剧并发刷新请求合并；默认缓存有效期 24 小时，用户强制刷新可绕过详情缓存。
- 页面先显示本地快照，刷新失败仅显示局部错误和重试，不退回整页错误。

### 7.3 合并规则

- 继续以当前多来源合并顺序为基础，不覆盖已存在的高优先级有效字段。
- 字符串数组规范化后取并集；保留稳定顺序和来源优先级。
- `staff` 按姓名和职责去重；同名不同职责分别保留。
- `nextAiringAt` 仅接受有效未来时间；过期时间不展示为下一次放送。
- `episodeCount`、`durationMinutes` 和排名值只接受有限正整数。
- `bannerUrl`、`coverUrl` 继续经过现有图片缓存和 URL 安全校验。
- 合并完成后记录来源和 `refreshedAt`，便于显示数据新鲜度和排查问题。

## 8. SQLite 持久化与迁移

- 在 `anime_catalog` 增加 `detail_json TEXT NOT NULL DEFAULT '{}'`。
- 通过结构化 `AnimeDetailMetadata` 序列化/解析，不在业务代码中手工拼接 JSON 字符串。
- `SQLITE_SCHEMA_VERSION` 在实施时基于当时当前版本递增 1；不得写死依赖本计划编写时的版本号。
- `migrateSchema` 使用 `ensureColumn` 幂等补列，支持已有 SQLite 数据库升级。
- 旧记录不需要业务数据迁移，`detail_json = '{}'` 即为合法缺失详情。
- repository 写入、读取、导出和导入路径同步保留 `detail`；损坏 JSON 回退为空对象并打印警告日志。
- 增加从上一 schema 版本升级、重复初始化、字段往返和损坏 JSON 回退测试。

## 9. 详情视图模型

新增纯函数 `buildAnimeDetailViewModel(result)`，负责：

- 标题、原名和别名解析。
- 未追番/已追番状态判定。
- 季度、首播区间、格式、放送状态和下一次放送格式化。
- 已看集数、总集数和进度推导；没有总集数时只显示已看集数。
- 默认字幕组、自动下载、分辨率和编码偏好摘要。
- 外链白名单、可见分区和可执行动作推导。
- 缺失字段裁剪，确保页面组件不包含业务判定和来源优先级逻辑。

进度计算只使用真实 `Episode`：`watched` 数量作为已看集数，`detail.episodeCount` 作为总集数；两者都不存在时隐藏进度。

## 10. UI 结构

### 10.1 公共桌面结构

1. 局部头部：返回、来源面包屑、当前标题、刷新、更多操作。
2. 核心信息：2:3 海报、标题/原名、追番状态、季度、评分、简介摘要。
3. 主操作：添加追番或已追番状态、搜索资源、编辑规则。
4. 吸顶分区导航：概览、放送、制作、来源、资源；使用锚点长页，不复制五份状态。
5. 主列：简介、基础信息、题材、制作公司和职员。
6. 辅列：放送信息、别名、外部链接；已追番时优先显示追番配置。

### 10.2 未追番状态

- 主按钮为「添加追番」，提交时禁用并显示 Spinner。
- 次按钮为「搜索资源」，带入标题、原名、别名和 anime id。
- 展示 external id 对应的有效外链；没有链接时隐藏整个外链区。
- 添加成功后重新读取 `AnimeDetailResult`，原地切换已追番视图，不重新进入页面。

### 10.3 已追番状态

- 显示追番状态、进度、默认字幕组、自动下载、分辨率和下一次放送。
- 主状态按钮显示「已在追番」，不作为无意义的禁用 CTA。
- 「编辑规则」「查看资源」「下载任务」复用我的追番现有 Sheet 和业务方法。
- 将规则、资源和任务浮层的协调逻辑抽到可复用 host/hook，不在详情页复制请求、选择和下载代码。
- 移除追番仍走现有 `AlertDialog`；成功后详情原地切回未追番状态。

### 10.4 移动端结构

- 使用设计稿的 390px 单列顺序：返回栏、海报与核心信息、主操作、简介、题材、制作数据、追番配置和外链。
- 海报固定 2:3，标题区域允许多行，不使用视口宽度缩放字体。
- 简介默认显示 6 行；仅在真实溢出时显示展开/收起。
- 主操作在窄屏全宽，图标按钮触控区至少 44x44px。
- 桌面吸顶分区导航在移动端隐藏，所有可见分区按文档顺序连续展示。
- 页面外层不得横向滚动，长别名、工作室和职员名称允许换行。

## 11. shadcn/ui 与样式约束

- 优先复用已安装的 `Button`、`Badge`、`Card`、`Separator`、`Skeleton`、`Alert`、`Empty`、`Tooltip`、`DropdownMenu`、`Sheet` 和 `AlertDialog`。
- 详情正文使用无外框分区；`Card` 只用于追番配置等真正独立的信息面板，不嵌套 Card。
- 使用 `Card` 时保留完整 `CardHeader`、`CardTitle`、`CardDescription`、`CardContent` / `CardFooter` 组合。
- 加载、空和错误分别使用 `Skeleton`、`Empty` 和 `Alert`；成功与普通失败反馈使用 Sonner Toast。
- 所有颜色使用语义令牌，不复制 Stitch HTML 中的固定色、`dark:` 色或阴影。
- 所有图标使用 `lucide-react`；按钮图标使用 `data-icon`，陌生图标提供 Tooltip 和可访问名称。
- 使用 `gap-*` 组织间距，不使用 `space-x-*` / `space-y-*`；等宽高元素使用 `size-*`。
- 如实施中需要新增 shadcn 组件，先执行 `docs`、`--dry-run` 和 `--diff`，不得使用 `--overwrite`。

## 12. 状态与反馈

| 状态 | 页面行为 |
| --- | --- |
| 初次加载 | 保持海报、标题、操作区和双列布局尺寸稳定的 Skeleton |
| 本地详情成功 | 立即展示 SQLite 快照，不等待网络刷新 |
| 番剧不存在 | 使用 Empty，提供返回来源页操作 |
| 整页读取失败 | 使用 Alert，提供重试和返回 |
| 主动刷新 | 保留当前内容，刷新按钮显示 Spinner；不覆盖为 Skeleton |
| 部分来源失败 | 保留成功字段，Alert 摘要展示首个错误，其余写日志 |
| 添加追番中 | 仅锁定添加动作，其他只读信息和返回仍可用 |
| 添加成功 | Toast + 原地切换已追番视图 |
| 离线 | 展示本地快照和陈旧标识，禁用强制刷新；不显示空白页 |
| 图片失败 | 使用稳定比例占位，正文布局不位移 |

## 13. 代码边界与预计文件

| 层级 | 预计位置 | 职责 |
| --- | --- | --- |
| 共享领域 | `src/shared/domain.ts` | 详情元数据类型 |
| 共享契约 | `src/shared/contracts.ts` | 详情读取与刷新结果 |
| SQLite | `src/main/core/storage/sqlite-schema.ts`、`repositories/sqlite-app-repository.ts` | 持久化与迁移 |
| 元数据 | `src/main/core/metadata/` | 单条详情来源适配与合并 |
| 服务 | `src/main/core/metadata/anime-detail-service.ts` | 本地聚合、刷新与日志 |
| Bridge | `src/main/ipc.ts`、`src/preload/index.ts`、`vite-env.d.ts`、`lib/api.ts`、`core/remote/remote-method-registry.ts` | IPC 与远程只读调用边界 |
| 导航 | `src/renderer/src/App.tsx`、`components/app-shell.tsx` | 二级视图和返回恢复 |
| 详情 UI | `src/renderer/src/features/anime-detail/` | 页面、视图模型、分区与状态 |
| 发现入口 | `features/discovery/DiscoveryPage.tsx` | 图鉴和时间表打开详情 |
| 追番入口 | `features/my-anime/` | 追番条目打开详情及浮层复用 |
| 远程入口 | `features/remote/` | 权限裁剪后的响应式详情 |

页面组件只负责渲染和事件转发；合并、进度推导、字段显隐和来源优先级必须位于 service 或纯视图模型中。

## 14. 实施阶段

| 阶段 | 状态 | 目标 | 主要任务 | 交付物 | 阶段验收 |
| --- | --- | --- | --- | --- | --- |
| AD-P0 基线与契约冻结 | 已完成 | 固定三稿映射和字段范围 | 建立字段矩阵、视图状态、缺失字段规则和远程权限表 | 最终契约草案 | 无示例数据进入生产；所有字段有来源或隐藏策略 |
| AD-P1 元数据与持久化 | 已完成 | 让详情字段可真实保存 | 扩展 domain、provider、合并、SQLite schema/migration、repository | `AnimeDetailMetadata` 与数据测试 | 旧库升级无损；三来源部分失败仍保留已有详情 |
| AD-P2 详情服务与 Bridge | 已完成 | 提供一次性聚合结果 | 新增详情 service、IPC/preload/renderer API、缓存与关键日志 | `get/refreshAnimeDetail` | 本地首屏不触发网络；强刷可增量更新且请求合并 |
| AD-P3 二级导航与公共详情 | 已完成 | 完成入口、返回和公共 UI | AppView、AppShell 二级头部、详情骨架、视图模型、状态页 | 未追番桌面/移动详情 | 三入口可达；返回恢复筛选、滚动与焦点 |
| AD-P4 已追番联动 | 已完成 | 完成追番控制台状态 | 原地状态切换、进度、偏好摘要、规则/资源/任务复用、移除确认 | 已追番详情 | 添加/移除、规则、资源和任务动作形成闭环 |
| AD-P5 远程、主题与回归 | 已完成 | 确保跨端稳定 | 权限裁剪、四视口、明暗/自定义主题、性能和无障碍回归 | QA 记录与截图 | 验收矩阵、类型、测试和构建全部通过 |

## 15. 审核门

| 审核门 | 提交内容 | 通过条件 |
| --- | --- | --- |
| AD-G1 数据审核 | 类型、来源字段、SQLite 迁移、合并测试 | 无假数据；旧库无损；字段缺失可安全降级 |
| AD-G2 未追番审核 | 发现入口、桌面详情、移动详情、返回恢复 | 与两张未追番设计稿层级一致，添加追番和资源搜索可用 |
| AD-G3 已追番审核 | 追番配置、进度、规则/资源/任务入口 | 所有动作复用现有业务逻辑且可返回详情 |
| AD-G4 最终审核 | 远程、主题、四视口、自动检查 | 状态矩阵无白屏、溢出、遮挡和权限泄漏 |

每个审核门通过后再进入下一阶段；AD-G1 未通过前不得开始批量详情 UI 实现。

## 16. 验收矩阵

### 16.1 视口与主题

- 视口：`1440x900`、`1024x768`、`768x1024`、`390x844`。
- 主题：浅色、深色、跟随系统、至少 1 个导入的自定义主题。
- 390px 下无非预期横向滚动；移动触控目标至少 `44x44px`。
- 正文对比度至少 `4.5:1`，焦点和关键边界至少 `3:1`。

### 16.2 数据状态

- 完整元数据、只有当前 `Anime` 基础字段、无封面、无横幅、无简介、无评分。
- 未追番、已追番但无集数、已追番且有进度、自动下载关闭/开启。
- 本地快照新鲜、快照陈旧、离线、单来源失败、全部刷新来源失败。
- 番剧不存在、图片缓存失败、external id 无有效链接。

### 16.3 交互

- 图鉴和时间表打开的是同一 anime id 详情。
- 返回后恢复季度、月份、搜索词、排序、视图模式和滚动位置。
- 连续点击添加只产生一条追番记录；成功后无需刷新页面即可显示已追番信息。
- 资源搜索带入完整标题集合；编辑规则、资源、任务浮层均定位到当前番剧。
- 详情刷新不会清空现有内容；局部失败可重试。
- 键盘可进入、返回、操作、关闭浮层；焦点顺序与视觉顺序一致。
- 远程端不暴露本地路径、下载源配置和未授权桌面操作。

### 16.4 工程检查

- `pnpm.cmd run typecheck`
- 元数据 provider、合并、视图模型和 SQLite 迁移专项测试
- `pnpm.cmd run test:parsers`
- `pnpm.cmd build`
- `git diff --check`
- 使用 Playwright 对四档视口执行截图、溢出和关键交互回归

## 17. 关键日志

- `[anime-detail] load started/completed/failed`：anime id、是否已追番、耗时。
- `[anime-detail] refresh started/completed/partial/failed`：来源、补全字段数、错误数、缓存命中。
- `[anime-detail] tracker added/removed`：anime id、myAnime id；不打印用户路径和敏感配置。
- `[anime-detail] navigation restored`：来源页、滚动恢复结果，仅在开发日志中记录。
- provider 沿用现有 logger，不使用 renderer 的无结构 `console.log`；用户可操作错误仍通过页面状态或 Toast 呈现。

## 18. 风险与控制

| 风险 | 控制方式 |
| --- | --- |
| 三张稿件导航结构不一致 | 统一使用已批准 AppShell，设计稿局部导航只作信息层级参考 |
| 详情字段大量缺失 | 可选契约 + 分区级隐藏，不显示推测值和占位行 |
| 打开详情触发慢网络 | 首屏只读本地；网络补全仅由用户刷新或后台缓存策略触发 |
| 多来源互相覆盖有效数据 | 字段级优先级、数组去重和合并单测 |
| 详情复制我的追番业务逻辑 | 抽取共享 panel host/hook，详情页只发动作意图 |
| 返回丢失发现页上下文 | 二级视图保存筛选、滚动和焦点快照 |
| 移动详情出现双顶栏 | AppShell 提供明确 secondary 模式，详情不自行叠加全局头部 |
| 远程端暴露桌面能力 | 继续使用远程白名单和服务端授权，UI 隐藏不作为权限控制 |
| JSON 详情字段损坏 | 结构化解析、空对象回退、警告日志和 repository 测试 |

## 19. 本专项不包含

- 不新增评论、评分提交、收藏社交、相关推荐、角色百科或在线视频播放。
- 不引入新的元数据站点，不做网页抓取兜底搜索。
- 不将设计稿中的 `Dashboard / History / Stats` 新增为主导航或详情标签。
- 不重做追番规则、资源和任务 Sheet 的视觉；只抽取详情复用所需的协调边界。
- 不引入完整 React Router；外部深链接和重启恢复详情另行规划。
- 不修改 BT 引擎、播放器、自动化策略和下载目录语义。
