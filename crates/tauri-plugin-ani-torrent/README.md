# Tauri Ani Torrent Plugin

该内部插件把 `ani-downloads::TorrentCoreTransport` 映射到移动原生核心：

- Android：前台 `dataSync` Service、应用内 Binder、JNI libtorrent。
- iOS：Swift 串行 Session、稳定 C ABI、进入后台时有限时间刷盘。

插件不注册 Renderer command。下载页面仍只通过 Tauri 业务 commands 和
`AppClient` 使用统一下载服务。

原生依赖准备：

```bash
pnpm run prepare:torrent-core:android
pnpm run prepare:torrent-core:ios
```
