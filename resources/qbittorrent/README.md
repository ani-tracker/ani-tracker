# qBittorrent-nox bundled binaries

Place platform-specific qBittorrent-nox binaries here so the Electron main process can launch a managed headless child process. GUI qBittorrent binaries are intentionally not accepted for managed startup.

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

Accepted executable names:

- macOS: `qbittorrent-nox`, `qbittorrent-nox.app/Contents/MacOS/qbittorrent-nox`, `qBittorrent-nox.app/Contents/MacOS/qbittorrent-nox`
- Windows: `qbittorrent-nox.exe`
- Linux: `qbittorrent-nox`

Packaged builds should copy the same `qbittorrent/<platform>-<arch>/...` tree into Electron `process.resourcesPath`.

Managed startup uses qBittorrent-nox WebUI on a high local port. The default is `127.0.0.1:18080`; if the configured port is below `10000` or already occupied, Ani Tracker picks an available port above `10000` for that process and reports the actual WebUI URL in Settings.

Resource preparation:

```bash
npm run prepare:qbittorrent
npm run verify:qbittorrent
node scripts/prepare-qbittorrent-resources.mjs --platform win32 --arch x64
node scripts/prepare-qbittorrent-resources.mjs --all
```

- `prepare:qbittorrent` copies only the current build target into `out/qbittorrent` after `electron-vite build`; CLI `--platform` and `--arch` override npm target variables and the host platform.
- `verify:qbittorrent` requires the current platform and architecture nox binary to exist and exits with a non-zero code when it is missing.
- `--all` is reserved for explicit resource maintenance and copies every available supported target.
- The output root is cleared before preparation so resources from a previous platform build cannot leak into the next package.
