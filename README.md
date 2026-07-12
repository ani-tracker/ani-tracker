# Ani Tracker

本项目是一个本地追番工具，目标是管理新番发现、我的追番、字幕组规则、BT 下载、媒体编码扫描、播放器调用和更新提醒。

## 当前进度

已经完成第一版工程骨架：

- Electron + React + TypeScript + Vite
- Tailwind + shadcn/ui 风格基础组件
- Electron preload bridge
- 首页、我的追番、新番发现、资源搜索、下载队列、下载源、设置页面
- 追番、资源、下载、媒体文件、设置等核心类型
- 服务接口设计
- 媒体编码解析链骨架
- qBittorrent 状态映射骨架
- JSON 本地仓库和设置持久化骨架
- RSS / Torznab 下载源适配器
- 资源标题解析和自动匹配评分骨架
- qBittorrent 兼容引擎和连接测试入口
- 详细设计文档：`docs/design-plan.md`

## 运行方式

推荐使用 pnpm：

```powershell
pnpm install
pnpm dev
```

PowerShell 默认可能禁止直接运行 `npm.ps1`，如果改用 npm，建议使用：

```powershell
npm.cmd install
npm.cmd run dev
```

## 下一步

1. 接入 SQLite，持久化设置和我的追番。
2. 实现新番数据源适配。
3. 用真实 RSS / Torznab 源验证资源搜索和添加下载流程。
4. 接入 ffprobe / MediaInfo 扫描真实媒体编码。
5. 接入播放器配置和 Windows 平台能力。
6. 实现真正的内置 TorrentCore，让用户无需单独安装 qBittorrent。
