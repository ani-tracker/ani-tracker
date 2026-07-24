# 桌面构建脚本说明

本目录提供 Windows 与 macOS 共用的桌面开发构建流程。Windows 必须在 Git Bash 中执行 Bash 脚本；macOS 使用系统 Bash 环境。

## 快速开始

首次构建先检查并安装原生工具链：

```bash
bash scripts/setup-desktop-build-tools.sh --check-only
bash scripts/setup-desktop-build-tools.sh
```

日常开发优先使用增量重建：

```bash
bash scripts/incremental-rebuild.sh --run none
```

依赖或缓存异常时执行完全重建：

```bash
bash scripts/clean-rebuild.sh --run none --kill-app
```

`--run` 支持：

- `preview`：构建后启动 Electron 预览，默认值。
- `dev`：构建后启动开发服务。
- `none`：只构建，不启动应用。

## 最小工具链

### Windows x64

`setup-desktop-build-tools.sh` 使用 `winget` 安装 Visual Studio 2022 Build Tools 的最小必要组件：

- `Microsoft.VisualStudio.Workload.VCTools`
- `Microsoft.VisualStudio.Component.VC.CMake.Project`
- `Microsoft.VisualStudio.Component.Windows11SDK.26100`

不会安装 Visual Studio IDE、MFC、ATL、测试工具和分析器。安装仍需要数 GB 空间，并可能触发 UAC。

项目使用固定版本 `vcpkg 2025.06.13`。首次原生构建会自动克隆到 `.vcpkg/` 并安装 Boost、OpenSSL、zlib 等静态依赖，后续增量构建复用缓存。

### macOS x64 / ARM64

安装脚本检查 Xcode Command Line Tools；缺失时会触发系统安装窗口，完成后需要重新运行脚本。其他依赖由 Homebrew 安装：

- CMake
- Ninja
- Boost
- OpenSSL 3

## 用户入口

### `setup-desktop-build-tools.sh`

安装和验证桌面原生构建工具链。

- `--check-only`：只检查，不修改系统。
- Windows：通过 winget 最小安装 MSVC、Windows SDK、CMake 和 Ninja。
- macOS：准备 Xcode Command Line Tools 与 Homebrew 依赖。
- 安装完成后调用项目原生构建器进行验证。

### `clean-rebuild.sh`

执行完全重建：

1. 在删除文件前检查原生工具链。
2. 可选终止当前工作区的 Electron 和原生 sidecar。
3. 清理 `node_modules`、应用产物、CMake 当前平台产物和 TypeScript 意外输出。
4. 可选执行 `pnpm store prune`。
5. 重新安装依赖并执行类型检查。
6. 编译 `torrent-core`、Electron 应用和 libVLC 原生绑定。
7. 按 `--run` 启动预览、开发服务或直接结束。

额外参数：

- `--skip-store-prune`：保留 pnpm store。
- `--kill-app`：构建前终止当前工作区进程。

### `incremental-rebuild.sh`

执行日常增量重建。它会清理应用产物和工具缓存，但保留：

- `node_modules`
- pnpm store
- `.vcpkg/`
- CMake 原生构建缓存
- 已校验的 `.cache/libvlc/` 下载归档

CMake 和 vcpkg 会自行判断未变化内容，因此仍会执行构建命令，但不会重复编译全部依赖。

支持 `--kill-app` 和全部 `--run` 模式。

## 内部辅助脚本

以下脚本由用户入口调用，通常不需要直接执行。

### `rebuild-common.sh`

提供两个重建入口共用的能力：

- 识别 Windows/macOS 和当前架构。
- Windows 选择 `pnpm.cmd`，macOS 选择 `pnpm`。
- 限制删除目标必须位于项目工作区内。
- 检查原生构建工具链。
- 编排 `torrent-core`、Electron、libVLC 和启动模式。

### `prepare-desktop-torrent-core-dev.mjs`

编译、打包并校验当前平台的 portable `torrent-core`：

- Windows：自动加载 VS 2022 开发环境，维护固定版本 vcpkg，使用静态依赖构建。
- macOS：使用 Homebrew 的 Boost 与 OpenSSL，并指定当前目标架构。
- 输出到 `artifacts/torrent-core/<platform>-<arch>/`。
- 生成文件清单、摘要和许可证，并执行运行校验。
- `--check-only` 只验证工具链，不下载或编译。

### `prepare-windows-libvlc-dev.mjs`

准备 Windows x64 libVLC 开发运行时：

1. 下载并校验固定摘要的 VLC 3.0.21 官方 ZIP。
2. 整理运行时到 `out/libvlc/win32-x64/`。
3. 按 Electron ABI 重编 `better-sqlite3` 和 `electron-vlc-player`。
4. 校验原生绑定、运行时文件与许可证。
5. 通过 Electron 执行 libVLC 烟测。

macOS 对应流程由 `prepare-mac-libvlc-dev.mjs` 处理。

### `stop-workspace-processes.ps1`

Windows 内部进程清理器。只终止可执行文件位于当前项目目录内的：

- Electron
- qBittorrent-nox
- torrent-core

不会按进程名全局终止其他项目或系统中的同名进程。

### `prepare-torrent-core-resources.mjs`

校验并复制已生成的 `torrent-core` bundle。重建入口通过 `ANI_TORRENT_CORE_SOURCE_ROOT` 指向 `artifacts/torrent-core/`，确保 Electron 构建使用刚编译的当前平台核心。

## 常见问题

### 缺少 Visual Studio 2022 Build Tools

执行：

```bash
bash scripts/setup-desktop-build-tools.sh
```

安装结束后重新打开 Git Bash，再执行重建脚本。

### `EBUSY` 或输出目录被占用

应用或 sidecar 仍在使用构建产物。执行：

```bash
bash scripts/incremental-rebuild.sh --kill-app --run none
```

### `no verified bundle for win32-x64`

直接运行 `pnpm build` 时，尚未生成 Windows `torrent-core` bundle 会出现该警告。使用 `clean-rebuild.sh` 或 `incremental-rebuild.sh`，脚本会先编译原生核心并把产物传给 Electron 构建。

### macOS 提示缺少 Xcode Command Line Tools

运行安装脚本，完成 macOS 弹出的安装流程后，再次运行同一命令。
