# qBittorrent bundled binaries

Place platform-specific qBittorrent or qBittorrent-nox binaries here so the Electron main process can launch them as a managed child process.

Expected layout:

```text
resources/qbittorrent/
  darwin-arm64/
    qbittorrent-nox
  darwin-x64/
    qbittorrent-nox
  win32-x64/
    qbittorrent-nox.exe
  linux-x64/
    qbittorrent-nox
```

Fallback executable names are also supported:

- macOS: `qbittorrent-nox`, `qbittorrent-nox.app/Contents/MacOS/qbittorrent-nox`, `qBittorrent-nox.app/Contents/MacOS/qbittorrent-nox`, `qBittorrent.app/Contents/MacOS/qbittorrent`, `qbittorrent`
- Windows: `qbittorrent-nox.exe`, `qbittorrent.exe`
- Linux: `qbittorrent-nox`, `qbittorrent`

Packaged builds should copy the same `qbittorrent/<platform>-<arch>/...` tree into Electron `process.resourcesPath`.

Managed startup uses qBittorrent WebUI on a high local port. The default is `127.0.0.1:18080`; if the configured port is below `10000` or already occupied, Ani Tracker picks an available port above `10000` for that process and reports the actual WebUI URL in Settings.
