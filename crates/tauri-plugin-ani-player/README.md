# tauri-plugin-ani-player

Ani Tracker 内部播放器插件。桌面端通过动态加载的 libVLC 3.0.x 绑定原生窗口，Android 与 iOS 通过 Tauri 移动插件复用平台 VLC SDK。原生调用不直接暴露给 Renderer。

当前 Windows、macOS 与 Linux transport 已接通；Android 与 iOS 适配按 `docs/tauri-2-migration-plan.md` 的 P5 阶段继续实现。
