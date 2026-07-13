# Ani Tracker

本项目是一个本地追番工具，目标是管理新番发现、我的追番、字幕组规则、BT 下载、媒体编码扫描、播放器调用和更新提醒。

## 当前进度

已经完成可运行的第一版核心闭环：

- Electron + React + TypeScript + Vite
- Tailwind + shadcn/ui 风格基础组件
- Electron preload bridge
- 首页、我的追番、新番发现、资源搜索、下载队列、下载源、设置页面
- 追番、单集、资源、下载、媒体文件、设置等核心类型
- JSON 本地仓库和设置持久化
- RSS / Torznab 下载源适配器
- 资源标题解析和自动匹配评分
- qBittorrent 兼容引擎、连接测试、进度刷新、文件选择
- ffprobe 媒体扫描
- 单集字幕组覆盖
- 手动/定时自动扫描和通知
- 播放器调用

详细文档：

- `docs/design-plan.md`
- `docs/progress.md`
- `docs/startup.md`
- `AGENTS.md`

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

## 下一步

1. 实现真正的内置 TorrentCore，让用户无需单独安装 qBittorrent。
2. 接入 SQLite，替换 JSON 仓库。
3. 完善新番元数据源和新番采集。
4. 增加动漫花园等站点专用适配器。
5. 补托盘、后台运行和开机启动策略。



待评估： https://github.com/equeim/tremotesf2 作为单文件下载器