# qBittorrent-nox macOS x64

- 平台：macOS Intel x64 (`darwin-x64`)
- 产物：`qbittorrent-nox.app/Contents/MacOS/qbittorrent-nox`
- qBittorrent：`release-5.2.3`，commit `0b63c3d`
- libtorrent：`v2.0.13`，commit `7d7fc38`，静态链接
- Qt：`6.11.1`
- OpenSSL：`3.6.3`
- Boost：`1.90.0_1`
- zlib：`1.3.2`
- 构建日期：2026-07-13

## 构建说明

本产物由 qBittorrent 官方源码本地构建：

```bash
cmake -S qBittorrent -B build -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DGUI=OFF \
  -DTESTING=OFF
cmake --build build --parallel
```

qBittorrent 使用本地构建并安装到临时前缀的 `libtorrent v2.0.13`，避免 Homebrew `libtorrent-rasterbar 2.1.x` 与 qBittorrent `5.2.3` API 不兼容。

macOS 产物经过 `macdeployqt` 部署，并补充了最小运行插件：

- `PlugIns/tls`
- `PlugIns/sqldrivers/libqsqlite.dylib`
- `Frameworks/ossl-modules/legacy.dylib`

## 验证

- `qbittorrent-nox --version` 输出 `qBittorrent v5.2.3`
- 使用临时 profile 启动 WebUI，`http://127.0.0.1:18081` 返回 `HTTP/1.1 200 OK`

## 预构建来源结论

官方 qBittorrent `release-5.2.3` 提供 macOS GUI DMG，没有 macOS `qbittorrent-nox` 预构建资产。

`userdocs/qbittorrent-nox-static` 提供的是 Alpine Linux/musl 静态 nox 二进制，不是 macOS Darwin 二进制；其中 `aarch64-qbittorrent-nox` 是 Linux ARM64，不适用于 Apple Silicon macOS。
