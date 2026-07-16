# qBittorrent Enhanced nox macOS x64

- 平台：macOS Intel x64 (`darwin-x64`)
- 产物：`qbittorrent-nox.app/Contents/MacOS/qbittorrent-nox`
- qBittorrent Enhanced Edition：`release-5.2.1.10`
- 上游 qBittorrent 基线：`v5.2.1`
- libtorrent：`v2.0.13`，commit `7d7fc38`，静态链接
- Qt：`6.11.1`
- OpenSSL：`3.6.3`
- Boost：`1.90.0_1`
- zlib：`1.3.2`
- 构建日期：2026-07-16

## 构建说明

本产物由 qBittorrent Enhanced Edition 源码本地构建：

```bash
cmake -S qBittorrent-Enhanced-Edition -B build -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DGUI=OFF \
  -DTESTING=OFF \
  -DCMAKE_PREFIX_PATH="/private/tmp/ani-libtorrent-install-v2.0.13-static;/usr/local/Cellar/qtbase/6.11.1;/usr/local/Cellar/qttools/6.11.1;/usr/local/opt/boost;/usr/local/opt/openssl@3;/usr/local/opt/zlib" \
  -DQt6LinguistTools_DIR=/usr/local/Cellar/qttools/6.11.1/lib/cmake/Qt6LinguistTools \
  -DZLIB_ROOT=/usr/local/opt/zlib
cmake --build build --parallel
```

qBittorrent Enhanced 使用本地构建并安装到临时前缀的 `libtorrent v2.0.13`，避免 Homebrew `libtorrent-rasterbar 2.1.x` 与 qBittorrent `5.2.x` API 不兼容。

macOS 产物经过 `macdeployqt` 部署、修正 bundle 内相对依赖路径，并补充了最小运行插件：

- `PlugIns/tls`
- `PlugIns/sqldrivers/libqsqlite.dylib`
- `Frameworks/ossl-modules/legacy.dylib`

## 验证

- `qbittorrent-nox --version` 输出 `qBittorrent v5.2.1.10`
- `codesign --verify --deep --strict qbittorrent-nox.app` 验证通过
- 使用临时 profile 启动 WebUI，`http://127.0.0.1:18082` 返回 `HTTP/1.1 200 OK`
- WebUI 登录页标题为 `qBittorrent Enhanced Edition WebUI`

## 预构建来源结论

官方 qBittorrent Enhanced Edition `release-5.2.1.10` 未提供 macOS `qbittorrent-nox` 预构建资产。

`userdocs/qbittorrent-nox-static` 提供的是 Alpine Linux/musl 静态 nox 二进制，不是 macOS Darwin 二进制；其中 `aarch64-qbittorrent-nox` 是 Linux ARM64，不适用于 Apple Silicon macOS。
