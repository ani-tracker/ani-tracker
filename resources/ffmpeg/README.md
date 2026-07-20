# FFmpeg bundled resources

FFmpeg is downloaded only during a platform build. A normal dependency install does not download a binary.

Supported build targets:

```text
darwin-arm64/ffmpeg
darwin-x64/ffmpeg
win32-x64/ffmpeg.exe
```

Run the preparation script for the host platform:

```bash
pnpm run prepare:ffmpeg
```

An explicit proxy can also be passed without changing the shell environment:

```bash
pnpm run prepare:ffmpeg -- --proxy http://127.0.0.1:7897
```

Specify the package target when cross-building:

```bash
pnpm run prepare:ffmpeg -- --platform darwin --arch arm64
pnpm run prepare:ffmpeg -- --platform win32 --arch x64
```

The script downloads release `b6.1.1` from `eugeneware/ffmpeg-static`, validates every file with SHA-256, caches downloads in `.cache/ffmpeg/b6.1.1`, and writes only the selected platform to `out/ffmpeg/<platform>-<arch>`.

Set `FFMPEG_BINARIES_URL` to a compatible mirror base when GitHub Releases is unavailable. Packagers must copy `out/ffmpeg` to Electron `process.resourcesPath/ffmpeg`.

The downloader automatically reads `HTTPS_PROXY`, `https_proxy`, `HTTP_PROXY`, and `http_proxy`. For example:

```bash
export https_proxy=http://127.0.0.1:7897
export http_proxy=http://127.0.0.1:7897
pnpm run prepare:ffmpeg
```
