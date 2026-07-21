# Ani Tracker 启动说明

最近核对：2026-07-21

## 环境要求

- Node.js 20 或 22。
- pnpm；仓库当前按 pnpm 11 配置依赖构建许可。
- 运行 Electron 桌面窗口的图形环境。

安装依赖：

```bash
pnpm install
```

Windows PowerShell：

```powershell
pnpm.cmd install
```

`pnpm-workspace.yaml` 已允许 Electron、esbuild 和 better-sqlite3 执行安装脚本。FFprobe 已随仓库资源内置，安装依赖时不会再下载平台包；根目录 `postinstall` 会按当前 Electron ABI 重建 better-sqlite3。

## 开发模式

完整开发启动：

```bash
pnpm dev
```

该命令先离线校验并复制当前平台的 FFmpeg/FFprobe，再执行 `prepare:remote-renderer`，将远程静态页面写入 `.remote-pwa/renderer`，最后启动 Electron、主进程、preload 和桌面 Renderer 的 Vite 热更新服务。

只调试桌面端：

```bash
pnpm dev:desktop
```

该模式跳过远程静态页面预构建，远程 PWA 不保证可用。远程界面修改后可单独刷新：

```bash
pnpm run prepare:remote-renderer
```

## 检查与测试

```bash
pnpm run typecheck
pnpm run test:theme
pnpm run test:parsers
```

- `typecheck` 分别检查 Node 和 Web TypeScript 配置，不应在源码目录生成 JS、声明文件或 tsbuildinfo。
- `test:theme` 校验内置主题令牌和对比度。
- `test:parsers` 先编译 Node 测试到被忽略的 `out/test-node`，再使用 Electron 的 Node 运行模式执行测试。

如果源码区出现 `electron.vite.config.js`、`electron.vite.config.d.ts` 或 `*.tsbuildinfo`，说明运行了会 emit 的 TypeScript 命令，应先确认来源，再清理对应生成物。

## 构建与预览

生产构建：

```bash
pnpm build
```

实际步骤：

1. `electron-vite build` 生成 main、preload 和 renderer。
2. `prepare:qbittorrent` 校验并复制当前目标平台的托管 qBittorrent 资源。
3. `prepare:ffmpeg` 校验并复制当前目标平台的 FFmpeg/FFprobe 资源。

交叉构建时可通过 npm 目标变量选择平台，CLI 参数优先级更高：

```bash
npm_config_platform=win32 npm_config_arch=x64 pnpm build
pnpm run prepare:qbittorrent -- --platform win32 --arch x64
```

qBittorrent 仅在显式执行 `node scripts/prepare-qbittorrent-resources.mjs --all` 时准备全部已有平台资源。每次准备前会清空 `out/qbittorrent`，避免混入上一次构建的平台目录。

主要输出：

```text
out/main/index.js
out/preload/index.mjs
out/renderer/
out/qbittorrent/<platform>-<arch>/
out/ffmpeg/<platform>-<arch>/
```

预览生产构建：

```bash
pnpm preview
```

预览模式从 `out/renderer` 提供桌面和远程页面。修改主进程代码后必须完整重启 Electron。

## 资源维护

离线校验仓库中的全部 FFmpeg/FFprobe 资源：

```bash
pnpm run verify:ffmpeg
```

显式更新三平台 FFmpeg/FFprobe 资源：

```bash
pnpm run download:ffmpeg
```

校验当前目标平台 qBittorrent 资源：

```bash
pnpm run verify:qbittorrent
```

构建过程默认不下载 qBittorrent、FFmpeg 或 FFprobe。`download:ffmpeg` 是显式联网维护命令，不属于日常安装或构建。

## 远程 PWA

1. 使用 `pnpm dev` 或 `pnpm preview` 启动完整应用。
2. 在“设置 -> 远程设备”中启用局域网 HTTPS。
3. 使用设置页显示的私网地址安装并信任本地 CA。
4. 在桌面端生成六位配对码，再由远程设备完成配对。

开发模式远程页面来自 `.remote-pwa/renderer`，生产预览来自 `out/renderer`。出现 `PWA_NOT_BUILT` 时，重新执行 `pnpm run prepare:remote-renderer` 或完整预览构建。

## 常见问题

### better-sqlite3 加载失败

重新执行安装脚本或 Electron rebuild，确保原生模块 ABI 与当前 Electron 一致：

```bash
pnpm install
pnpm exec electron-rebuild -f -w better-sqlite3
```

### 开发模式白屏

依次检查：

- `out/preload/index.mjs` 是否存在。
- `window.aniBridge` 是否暴露。
- Renderer 控制台是否有组件或图标运行时错误。
- 主进程日志中的页面地址与 `ELECTRON_RENDERER_URL` 是否一致。

### 构建资源被占用

运行中的托管 qBittorrent 可能占用 `out/qbittorrent`。确认没有进行中的下载后，从应用正常退出，再重新构建；不要通过强制终止破坏下载任务。

### HTTPS 无法连接

- 确认设置页已开启局域网 HTTPS，访问地址使用证书包含的私网 IP。
- 确认远程端已安装并信任当前本地 CA。
- 默认远程端口为 `18083`；托管 qBittorrent 默认端口为 `18080`，两者用途不同。

### 站点返回 403 或 429

检查全局代理、来源代理开关和来源熔断状态。保护期内不要高频强制刷新；AniBT 应使用单一稳定出口，应用不会轮换 IP 或模拟 Cloudflare Cookie。

## 产物约束

`out/`、`.remote-pwa/`、`out/test-node/`、`*.tsbuildinfo` 和临时 JS/声明文件均为生成物，不应提交到源码区。
