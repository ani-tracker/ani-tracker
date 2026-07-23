# Ani Tracker torrent-core

`torrent-core` 是 Electron 主进程托管的 libtorrent-rasterbar 2.1 sidecar。它只通过 stdin/stdout 的 NDJSON 协议通信，不开放 WebUI 或局域网端口。

## 本机构建

本机构建使用已安装的 libtorrent 2.1，适合开发和测试：

```bash
pnpm run build:torrent-core
```

输出位于 `native/torrent-core/build/release/`。Electron 开发模式会从该目录查找当前平台核心，也可用 `ANI_TORRENT_CORE_PATH` 指定绝对路径。

## 便携构建

发布构建强制下载固定 SHA-256 的 libtorrent 2.1.0 源码并关闭共享库构建：

```bash
pnpm run build:torrent-core:portable
```

该命令需要 CMake 3.24、Ninja、C++17、Boost 和 OpenSSL 开发文件。不同操作系统必须在对应目标环境或交叉工具链中执行；macOS arm64/x64 应分别构建并签名。

## 协议

每行请求格式为 `{"id":"...","method":"status","params":{}}`，每行响应包含同一 `id`、`ok` 和 `result` 或 `error`。支持：

- `status`、`configure`、`shutdown`
- `addMagnet`、`addTorrentFile`
- `listTasks`、`getTask`、`getFiles`
- `setFilePriority`、`pause`、`resume`、`remove`

任务、session state 和 fastresume 数据保存在应用 `userData/torrent-core`，退出时先请求恢复数据落盘，再关闭进程。
