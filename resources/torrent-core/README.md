# torrent-core resources

这里保存可随 Electron 分发的、依赖闭合的 `torrent-core` 平台资源。开发目录中的 CMake 产物不等同于发布资源。

```text
resources/torrent-core/
  licenses/
  darwin-arm64/
    torrent-core
    licenses/
    manifest.json
  darwin-x64/
  win32-x64/
  win32-arm64/
  linux-x64/
  linux-arm64/
```

## 生成清单

将核心和运行所需动态库放入目标目录后生成清单：

```bash
pnpm run manifest:torrent-core
pnpm run manifest:torrent-core -- --platform win32 --arch x64
```

生成器会复制完整许可证，并为每个文件记录大小和 SHA-256。macOS 核心及动态库必须使用 `@loader_path` 或 `@rpath`，不得引用 Homebrew 绝对路径。

## 校验与复制

```bash
pnpm run verify:torrent-core
pnpm run verify:torrent-core:all
pnpm run prepare:torrent-core
```

- `verify:torrent-core` 要求当前平台资源存在，并执行清单、摘要、可执行位、动态依赖和真实 `status/shutdown` 握手校验。
- `verify:torrent-core:all` 要求全部桌面目标存在。
- `prepare:torrent-core` 只把当前目标复制到 `out/torrent-core`；资源缺失时告警但不伪造产物。
- 正式发布流水线必须先执行 `verify:torrent-core`，再进行 Electron 签名和打包。

Android 使用 `.so` 与 JNI/前台服务，不使用这里的桌面 sidecar 目录。
