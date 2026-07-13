# qBittorrent-nox for Windows x64

- Version: qBittorrent 5.2.3
- Source archive: https://github.com/qbittorrent/qBittorrent/releases/download/release-5.2.3/qbittorrent-5.2.3.tar.xz
- Source SHA256: `7573621859da7287ba708378ea9f5eb12f30962a1a7c28eba5f44ecf8c4c114c`
- Built executable SHA256: `94891bf92b11e37467ec8eee6778ada5612a230d2439e70122b6cdee609c1cc7`

## Build Environment

Built on Windows x64 with local MSYS2/MINGW64.

Key package versions:

- `mingw-w64-x86_64-gcc 16.1.0-5`
- `mingw-w64-x86_64-cmake 4.4.0-1`
- `mingw-w64-x86_64-ninja 1.13.2-1`
- `mingw-w64-x86_64-qt6-base 6.11.1-1`
- `mingw-w64-x86_64-qt6-tools 6.11.1-1`
- `mingw-w64-x86_64-libtorrent-rasterbar 2.0.12-3`
- `mingw-w64-x86_64-boost 1.91.0-3`
- `mingw-w64-x86_64-openssl 3.6.3-1`
- `mingw-w64-x86_64-zlib 1.3.2-2`

## Commands

```powershell
curl.exe --proxy http://127.0.0.1:7897 --ssl-no-revoke -L -C - -o .build\downloads\qbittorrent-5.2.3.tar.xz https://github.com/qbittorrent/qBittorrent/releases/download/release-5.2.3/qbittorrent-5.2.3.tar.xz
Get-FileHash .build\downloads\qbittorrent-5.2.3.tar.xz -Algorithm SHA256
tar -xf .build\downloads\qbittorrent-5.2.3.tar.xz -C .build\src
$env:PATH=(Resolve-Path .build\msys64\mingw64\bin).Path + ';' + (Resolve-Path .build\msys64\usr\bin).Path + ';' + $env:PATH
.build\msys64\mingw64\bin\cmake.exe -S .build\src\qbittorrent-5.2.3 -B .build\src\qbittorrent-5.2.3\build-win64-nox -G Ninja -DCMAKE_BUILD_TYPE=Release -DGUI=OFF -DTESTING=OFF
.build\msys64\mingw64\bin\cmake.exe --build .build\src\qbittorrent-5.2.3\build-win64-nox --parallel
```

Runtime DLLs and Qt plugins were copied from the same MSYS2 MINGW64 environment into this directory.

## Verification

- `resources\qbittorrent\win32-x64\qbittorrent-nox.exe --version` exits successfully.
- Started with `--webui-port=18181 --confirm-legal-notice`; WebUI returned HTTP 200.
- `pnpm.cmd run verify:qbittorrent` passes on Windows x64.
