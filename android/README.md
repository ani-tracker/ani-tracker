# Android torrent host

该工程生成可复用 `torrent-host-release.aar` 和可安装宿主 APK。两者都包含 `arm64-v8a` JNI 库与 `TorrentDownloadService`；宿主通过本地 Binder 发送与桌面端一致的 NDJSON 请求，不运行桌面 sidecar，也不打包远程 Renderer、FFmpeg 或媒体转码能力。

## 构建

需要 JDK 17、Android SDK 35、NDK `27.2.12479018`、CMake 3.31.1、Gradle 8.10.2 和 vcpkg。先准备 Android 版 Boost/OpenSSL：

```bash
export ANDROID_NDK_HOME="$ANDROID_HOME/ndk/27.2.12479018"
export VCPKG_ROOT=/path/to/vcpkg
./scripts/prepare-android-torrent-dependencies.sh
gradle -p android :app:assembleDebug :torrent-host:assembleRelease
```

输出位于 `android/torrent-host/build/outputs/aar/torrent-host-release.aar` 和 `android/app/build/outputs/apk/debug/app-debug.apk`。发布 APK/AAB 需按 `docs/release-build.md` 配置 keystore 环境变量。当前 APK 是下载核心控制宿主，完整移动追番界面不在本阶段范围内。
