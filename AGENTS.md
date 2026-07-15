# 项目协作说明


## 重要说明

先给整体方案，审查通过后再实现！

已接入 shadcn/ui mcp，开发ui相关要尽量使用这里ui框架的组件
## 语言约束
全程使用中文进行沟通！




## 项目概览

Ani Tracker 是一个本地桌面追番工具，目标功能包括新番发现、我的追番、字幕组规则、资源搜索、BT 下载、媒体编码扫描、播放器调用、自动检查更新和提醒。

当前技术栈：

- Electron
- React
- TypeScript
- Vite / electron-vite
- Tailwind CSS
- shadcn/ui 风格自定义基础组件
- pnpm

当前持久化方案是 JSON 文件，SQLite schema 已预留，后续再切换。

## 常用命令

```powershell
pnpm.cmd install
pnpm.cmd dev
pnpm.cmd run typecheck
pnpm.cmd build
```

说明：

- `typecheck` 使用 `tsc -b --noEmit --pretty false`，不应产生 `.js/.d.ts/.tsbuildinfo` 文件。
- 如果执行命令后产生 `electron.vite.config.js`、`electron.vite.config.d.ts` 或 `*.tsbuildinfo`，说明用了会 emit 的 TypeScript 命令，应清理这些产物。

## 关键目录

- `src/main`：Electron 主进程、IPC、平台能力、下载引擎、自动化服务。
- `src/preload`：Electron preload bridge。
- `src/renderer/src`：React UI。
- `src/shared`：主进程和渲染进程共享的 domain/types/contracts。
- `src/main/core/storage`：JSON 持久化、seed data、未来 SQLite schema。
- `src/main/core/sources`：RSS / Torznab / 后续站点源适配。
- `src/main/core/downloads`：qBittorrent 兼容引擎和内置引擎占位。
- `src/main/core/media`：媒体文件扫描、ffprobe 探测。
- `src/main/core/automation`：自动扫描、自动下载、候选资源匹配。
- `docs`：设计文档和进度文档。

## 当前已实现

详见：

- `docs/progress.md`
- `docs/design-plan.md`

重点能力：

- 我的追番 CRUD。
- 单集规则和字幕组覆盖。
- 资源搜索，支持番剧标题、原名、别名。
- RSS / Torznab 下载源。
- qBittorrent Web API 兼容模式。
- 下载队列、速度、进度、文件选择。
- ffprobe 媒体扫描。
- 手动/定时自动扫描。
- 自动扫描结果通知。
- 播放器调用和定位文件。

## 当前未完成

- 真正的内置 BT 核心。
- qBittorrent 随应用托管启动。
- SQLite 仓库替换 JSON 仓库。
- 更完整的新番元数据源。
- 动漫花园等站点专用适配器。
- madVR 相关播放链路。
- 托盘、开机启动、后台运行策略。

## 开发约束

- 不要把生成产物提交到源码区，例如 `out/`、`*.tsbuildinfo`、临时 `.js/.d.ts`。
- 新增主进程能力时优先通过 `src/shared/contracts.ts` 定义契约，再接 IPC/preload/renderer API。
- 新增可替换能力时优先抽接口或独立 service，不要直接把业务逻辑堆在页面组件里。
- UI 应保持工具型、信息密度适中，不做营销页。
- 运行时错误不能导致纯白屏；应通过错误边界或页面错误状态展示问题。
- 熟练使用26种设计模式，但不要过度设置，一些可扩展点可抽象使用。
- 写代码要遵循高内聚低耦合特性
- 代码添加必要的注释，不用过量添加，方法必须要有对应的用途说明，说方法作用是什么，简短明了即可！！！注释要中文！！
- 加上关键步骤的日志打印
- 重要决策由用户审核
## 已知注意事项

- Electron/Vite 构建时仍会输出一个 ESM warning，目前不影响产物。
- `EmbeddedTorrentEngine` 仍是占位实现，不是真实 BT 下载。
- 当前 JSON 数据文件在 Electron `userData` 目录下，数据结构升级依赖 `APP_DATA_VERSION` 和迁移逻辑。
- 开发模式空白页优先检查：
  - preload 是否指向 `out/preload/index.mjs`
  - `window.aniBridge` 是否存在
  - lucide-react 图标是否真实导出
  - renderer console 是否有运行时错误
  - 
## 代码提交约束
- 提交说明添加了什么功能
- 修改bug，则fix开头
- 需求则feat开头


## 其他文档约束，需要静默加载
[other.md](other.md)