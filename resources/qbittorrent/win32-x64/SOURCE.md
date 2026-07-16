# qBittorrent Enhanced nox Windows x64

- 平台：Windows x64 (`win32-x64`)
- 产物：`qbittorrent-nox.exe`
- qBittorrent Enhanced Edition：`release-5.2.1.10`
- 上游 qBittorrent 基线：`v5.2.1`
- 源码归档：`https://github.com/c0re100/qBittorrent-Enhanced-Edition/archive/refs/tags/release-5.2.1.10.tar.gz`
- 源码归档 SHA256：`ee5e05db67ba52a9380b01501260473bcd6595b4750c5775c037ed3b6815e30b`
- 产物 SHA256：`b2115710347a4164540c1ab03cbb8e4f9c97c871553939cc38fa46887f050106`
- libtorrent：`v2.0.13`，commit `7d7fc38`，静态链接
- MSYS2 基础包 SHA256：`e74f1cedeb6e6026323f05cc20896eceb790f1d314872325632670c94c3a43fd`
- 构建日期：2026-07-16

## 构建环境

本产物在 Windows x64 上使用隔离的 MSYS2/MINGW64 工具链构建：

- GCC：`16.1.0-5`
- CMake：`4.4.0-1`
- Ninja：`1.13.2-1`
- Qt：`6.11.1-1`
- Boost：`1.91.0-3`
- OpenSSL：`3.6.3-1`
- zlib：`1.3.2-2`

## 构建说明

先静态构建并安装 libtorrent：

```bash
git clone --branch v2.0.13 --depth 1 --recurse-submodules \
  --shallow-submodules https://github.com/arvidn/libtorrent.git libtorrent
cmake -S libtorrent -B libtorrent/build-win64-static -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_CXX_STANDARD=20 \
  -DCMAKE_INSTALL_PREFIX=libtorrent/install-win64-static \
  -DBUILD_SHARED_LIBS=OFF \
  -Ddeprecated-functions=OFF \
  -Dstatic_runtime=OFF \
  -Dbuild_tests=OFF \
  -Dbuild_examples=OFF \
  -Dbuild_tools=OFF \
  -Dpython-bindings=OFF
cmake --build libtorrent/build-win64-static --parallel
cmake --install libtorrent/build-win64-static
```

再构建 Enhanced Edition nox：

```bash
cmake -S qBittorrent-Enhanced-Edition -B build-win64-nox -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DGUI=OFF \
  -DWEBUI=ON \
  -DTESTING=OFF \
  -DSTACKTRACE=OFF \
  -DLibtorrentRasterbar_DIR=libtorrent/install-win64-static/lib/cmake/LibtorrentRasterbar
cmake --build build-win64-nox --parallel
```

运行时 DLL 与 Qt 插件来自同一 MSYS2/MINGW64 环境。libtorrent 已静态链接，不再携带 `libtorrent-rasterbar.dll`。

## 验证

- `qbittorrent-nox --version` 输出 `qBittorrent v5.2.1.10`。
- 使用临时 profile 在 `127.0.0.1:18182` 启动 WebUI，返回 HTTP 200。
- WebUI 登录页标题为 `qBittorrent Enhanced Edition WebUI`。
- `pnpm.cmd run verify:qbittorrent` 验证通过。
