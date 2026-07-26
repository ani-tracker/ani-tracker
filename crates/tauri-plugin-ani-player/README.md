# tauri-plugin-ani-player

Ani Tracker 内部播放器插件。桌面端通过动态加载的 libVLC 3.0.x 绑定原生窗口，Android 与 iOS 通过 Tauri 移动插件复用平台 VLC SDK。原生调用不直接暴露给 Renderer。

当前 Windows、macOS、Linux、Android 与 iOS transport 已接通。Android 复用 Compose `PlayerActivity` 与 `libvlc-all:3.6.2`，iOS 复用 SwiftUI 播放页与 `MobileVLCKit 3.7.3`；真实媒体路径仅由 Rust 受控会话传入。
