# 旧应用宿主归档

本目录保存 P8 退役时的 Electron 与 Capacitor 宿主实现，仅用于历史审计和行为对照，不参与安装、类型检查、测试、构建或发布。

## 最后回退点

- 分支：`Tauri_迁移`
- 提交：`6caf060`（`feat: 完成 Tauri 全平台发布工作流与品牌资源`）
- 恢复方式：从该提交创建独立分支；不要把归档目录重新加入当前构建链。

## 归档范围

- `electron/`：主进程、preload、Renderer Client、electron-vite/electron-builder 配置、开发重建脚本和旧 libVLC N-API 验证脚本。
- `capacitor/`：Android/iOS 旧宿主、Capacitor 配置、移动 Renderer 入口、Android Client 与插件桥。
- `legacy-dependencies.json`：退役时从根依赖清单移除的宿主依赖。

Android libVLC 播放器源码已作为正式实现迁至 `crates/tauri-plugin-ani-player/android/src/main/java/dev/ani/tracker/android/player`，不在归档中保留重复副本。旧宿主的完整可构建状态以回退提交为准。
