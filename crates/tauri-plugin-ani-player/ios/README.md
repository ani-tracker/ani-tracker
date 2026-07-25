# iOS Ani Player Plugin

Tauri iOS 生成工程编译本 Swift Package。执行 `scripts/prepare-ios-libvlc.sh` 后，`Frameworks/MobileVLCKit.xcframework` 必须同时包含真机和模拟器切片。

插件只接受 Rust `PlayerTransport` 传入的受控媒体会话，不向 WebView 暴露本地文件路径。MobileVLCKit 版本固定为 `3.7.3`，归档 SHA-256 由准备脚本校验。
