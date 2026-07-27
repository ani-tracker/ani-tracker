# Android Tauri 2 全面适配状态

最近核对：2026-07-27

状态：代码、构建链与自动化门禁已全面适配完成；正式签名安装和真机矩阵仍需发布验收。

## 已完成能力

- Tauri 2 是 Android 唯一正式宿主，复用 React、Tailwind CSS、shadcn/ui 风格组件和 `AppClient` 契约。
- 首页、发现、详情、追番、资源搜索、下载、提醒、来源和设置已接入 Rust 领域服务与 SQLite Repository。
- 内置 torrent-core 已通过 JNI 接入前台下载服务，支持任务控制、文件优先级、恢复目录和生命周期恢复。
- Android LibVLC 已支持播放控制、字幕、音轨、倍速、比例、续播、90% 已看和自动下一集。
- 已接入 WorkManager、Keystore、本地通知、通知导航、文件导入导出、主题同步、低存储保护和系统外链。
- Android ARM64 Debug APK、原生策略测试、Renderer 隔离和安装包内容边界已进入持续集成门禁。

## 移动产物边界

- 保留本地主 Renderer、SQLite、内置 torrent-core、Android LibVLC、完整业务能力和主题系统。
- 排除远程 PWA、远程 HTTPS 网关、FFmpeg、FFprobe、HLS 转码、托管 qBittorrent-nox 和桌面窗口能力。
- 正式发布仅生成 ARM64 自签 APK；缺少长期 JKS 时构建直接失败，不生成未签名正式包。

## 待发布验收

- 使用长期 JKS 完成正式自签 APK 的安装、升级和数据保留验证。
- 在真机验证前后台切换、系统杀进程、网络切换、低存储和后台限制恢复。
- 验收 H.264、HEVC 10bit、HDR、ASS、外挂字幕、多音轨、横竖屏和自动下一集媒体矩阵。
- 验收公网 BT、损坏恢复数据及不同 Android 系统版本行为。

以上项目属于发布与真机验收，不代表 Android 功能适配未完成，也不阻塞 Tauri 宿主迁移收口。

## 相关文档

- 当前全平台实现见 [实现状态](progress.md)。
- 打包、签名与验收流程见 [跨平台打包与发布](release-build.md)。
- Tauri 迁移前的 Capacitor 方案见 [历史归档](archive/2026-07-native-runtime/android-application-plan.md)。
