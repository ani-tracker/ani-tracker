# 启动说明

本文记录 Ani Tracker 的启动方式和已验证结果。

## 环境准备

推荐使用 pnpm 安装依赖：

```bash
pnpm install
```

Windows PowerShell 可使用：

```powershell
pnpm.cmd install
```

当前项目依赖 Electron 和 esbuild 的安装脚本。pnpm 11 会默认拦截依赖构建脚本，因此仓库通过 `pnpm-workspace.yaml` 显式允许：

```yaml
allowBuilds:
  electron: true
  esbuild: true
onlyBuiltDependencies:
  - electron
  - esbuild
```

如果本地依赖安装仍提示 build scripts 被忽略，可执行一次：

```bash
pnpm approve-builds electron esbuild
```

## 开发启动

日常开发启动：

```bash
pnpm dev
```

Windows PowerShell：

```powershell
pnpm.cmd dev
```

`pnpm dev` 实际执行 `electron-vite dev`，启动流程如下：

1. 编译主进程入口 `src/main/index.ts` 到 `out/main/index.js`。
2. 编译 preload 入口 `src/preload/index.ts` 到 `out/preload/index.mjs`。
3. 启动 renderer 的 Vite dev server，默认地址为 `http://localhost:5173/`。
4. 启动 Electron 应用。
5. 主进程创建 `BrowserWindow`，开发模式下通过 `ELECTRON_RENDERER_URL` 加载 Vite dev server。
6. preload 通过 `contextBridge` 暴露 `window.aniBridge`。
7. renderer 从 `src/renderer/index.html` 加载 `src/renderer/src/main.tsx`，再挂载 React `App`。

## 类型检查和构建

类型检查：

```bash
pnpm run typecheck
```

生产构建：

```bash
pnpm build
```

`pnpm build` 实际执行 `electron-vite build`，生成：

- `out/main/index.js`
- `out/preload/index.mjs`
- `out/renderer/index.html`
- `out/renderer/assets/*`

`package.json` 的 `main` 指向 `./out/main/index.js`，因此生产/预览模式会从构建后的主进程入口启动。

## 预览启动

预览构建产物：

```bash
pnpm preview
```

`pnpm preview` 会先执行 Electron Vite 构建，再启动 Electron。此时主进程不再依赖 `ELECTRON_RENDERER_URL`，而是加载 `out/renderer/index.html`。

## 非交互终端

在 CI、Codex 或其他无 TTY 的非交互终端里，如果 pnpm 触发依赖状态检查，可加上 `CI=true`：

```bash
CI=true pnpm install --frozen-lockfile
CI=true pnpm run typecheck
CI=true pnpm build
CI=true pnpm dev
```

开发启动需要监听本地端口 `5173`，Electron 启动还会打开桌面窗口；受限沙箱环境可能需要额外授权。

## 本次验证

验证时间：2026-07-13 14:24 左右，macOS / pnpm 11.12.0。

已验证通过：

- `CI=true pnpm install --frozen-lockfile`
- `CI=true pnpm run typecheck`
- `CI=true pnpm build`
- `CI=true pnpm dev`
- `CI=true pnpm preview`

验证到的启动日志要点：

- main 构建成功，输出 `out/main/index.js`。
- preload 构建成功，输出 `out/preload/index.mjs`。
- renderer dev server 启动在 `http://localhost:5173/`。
- Electron 应用启动，自动化调度器和每日提醒服务进入运行流程。
- `preview` 可完成构建并启动 Electron，说明构建产物加载路径可用。

验证过程中出现的 macOS/Electron 日志：

- `Tray icon is empty; tray integration skipped`
- `Unable to set login item: Operation not permitted`
- `EGL Driver message (Error) eglQueryDeviceAttribEXT: Bad attribute`

这些日志没有阻断开发启动、类型检查、构建或预览启动。
