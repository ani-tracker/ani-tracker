# iOS 内置播放器

iOS 应用使用 SwiftUI 承载播放器 UI，视频表面由 `MobileVLCKit 3.7.3` 原生渲染。播放器共享源码已迁至 `crates/tauri-plugin-ani-player/ios/Sources`；旧工程由 XcodeGen 引用该目录并继续通过 CocoaPods 构建，直到 P8 退役。

## 构建

需要 Xcode 16、XcodeGen、CocoaPods 1.16 或更高版本：

```bash
cd ios
xcodegen generate
pod install --repo-update
xcodebuild \
  -workspace AniTracker.xcworkspace \
  -scheme AniTracker \
  -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' \
  CODE_SIGNING_ALLOWED=NO \
  build
```

仓库中的 `.github/workflows/ios-player.yml` 会在 macOS 15 / Xcode 16.4 上执行模拟器测试，并确认 `MobileVLCKit.framework` 已嵌入应用产物。当前本地仓库远程为 Gitee，需要同步到 GitHub 后才会触发该工作流。

播放器支持 `anitracker://player` 深链。`url` 是必需媒体地址；可选参数为 `title`、`episode`、`artwork`、`description`、`position`（毫秒）和重复的 `subtitle`。

```text
anitracker://player?url=https%3A%2F%2Fexample.test%2Fepisode.m3u8&title=Anime&episode=Episode%2001
```
