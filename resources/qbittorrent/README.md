# qBittorrent-nox 内置资源

Ani Tracker 只托管无头版 qBittorrent Enhanced Edition。构建固定使用 `GUI=OFF`、`WEBUI=ON`，不接受 qBittorrent GUI 可执行文件；macOS 的 `.app` 仅用于承载可迁移的 Qt 动态库。

## 目标与版本

| 目标 | 可执行文件 |
| --- | --- |
| `win32-x64` | `qbittorrent-nox.exe` |
| `darwin-x64` | `qbittorrent-nox.app/Contents/MacOS/qbittorrent-nox` |
| `darwin-arm64` | `qbittorrent-nox.app/Contents/MacOS/qbittorrent-nox` |
| `linux-x64` | `qbittorrent-nox` |

- qBittorrent Enhanced Edition：`release-5.2.1.10`
- libtorrent-rasterbar：`2.0.13`
- Qt：`6.8.3`
- vcpkg：`2025.06.13`
- Boost、OpenSSL、zlib、libtorrent 静态链接；Qt 运行库随 bundle 部署。

## 构建

GitHub Actions 使用各目标的原生 runner 构建，不做跨平台二进制复用。Qt 需要 `qtbase` 与 `qttools`；Unix 需要 CMake、Ninja 和 vcpkg，Linux 还需要 `patchelf`、`pax-utils`；Windows 需要 MSVC 2022 与 PowerShell 7。

```bash
pnpm run prepare:qbittorrent:sources
pnpm run build:qbittorrent:nox:unix --platform darwin --arch x64
pnpm run build:qbittorrent:nox:unix --platform darwin --arch arm64
pnpm run build:qbittorrent:nox:unix --platform linux --arch x64
```

```powershell
pnpm run build:qbittorrent:nox:windows -Arch x64
```

构建生成：

```text
artifacts/qbittorrent/<platform>-<arch>/
artifacts/qbittorrent-packages/qbittorrent-nox-<platform>-<arch>.tar.gz
```

每个 bundle 都包含 `SOURCE.md`、许可证和带 SHA-256 的 `manifest.json`。验证会检查固定版本、清单完整性、运行库可迁移性、无 Qt Gui/Widgets 依赖，并启动临时 WebUI 冒烟测试。Linux job 还会把两份固定摘要的上游源码归档作为独立 Artifact 和 Release 资产上传。

## 应用打包

Actions 将当前 runner 生成的 bundle 复制到 `out/qbittorrent`，Tauri 再写入最终桌面应用的 `resources/qbittorrent/<platform>-<arch>`。设置中的“内置 qBittorrent-nox”启动受控本地 WebUI；默认端口为 `127.0.0.1:18080`，冲突时自动选择 `10000` 以上端口。

仓库中已有的 `resources/qbittorrent` 仅供本地开发和兼容现有 macOS x64、Windows x64 包；CI 最终包始终使用本次源码构建产物。`prepare:qbittorrent` 只复制当前目标，`--all` 仅用于显式资源维护，并会先清理输出目录以避免混入其他平台文件。
