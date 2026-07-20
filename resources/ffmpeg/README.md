# FFmpeg 预构建资源

此目录保存 `ffmpeg-static b6.1.1` 的三平台预构建文件。`pnpm install` 和 `pnpm build` 均不下载 FFmpeg；构建仅校验并复制目标平台资源到 `out/ffmpeg`。

目录结构：

```text
darwin-arm64/ffmpeg
darwin-x64/ffmpeg
win32-x64/ffmpeg.exe
```

离线校验全部预构建资源：

```bash
pnpm run verify:ffmpeg
```

为当前构建目标准备输出资源：

```bash
pnpm run prepare:ffmpeg
```

交叉构建时显式指定目标：

```bash
pnpm run prepare:ffmpeg -- --platform darwin --arch arm64
pnpm run prepare:ffmpeg -- --platform win32 --arch x64
```

`prepare:ffmpeg` 会校验二进制大小、SHA-256、许可证、上游说明和来源元数据，任一文件缺失或损坏都会终止构建。

升级 FFmpeg 时才执行联网维护命令；该命令下载并更新三个平台目录：

```bash
pnpm run download:ffmpeg
```

下载器读取 `HTTPS_PROXY`、`https_proxy`、`HTTP_PROXY` 和 `http_proxy`，也支持通过参数显式指定代理：

```bash
pnpm run download:ffmpeg -- --proxy http://127.0.0.1:7897
```

也可使用 `FFMPEG_BINARIES_URL` 指向兼容镜像。下载缓存位于 `.cache/ffmpeg/b6.1.1`，产物写入前会校验归档和解压后二进制的 SHA-256。

仅更新单个平台时直接调用维护脚本：

```bash
node scripts/download-ffmpeg-resources.mjs --platform darwin --arch arm64
```
