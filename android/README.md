# Android 应用宿主

该工程生成可复用 `torrent-host-release.aar` 和可安装宿主 APK。两者都包含 `arm64-v8a` JNI 库与 `TorrentDownloadService`；宿主通过本地 Binder 发送与桌面端一致的 NDJSON 请求，不运行桌面 sidecar，也不打包远程 Renderer、FFmpeg 或媒体转码能力。应用内置 `libvlc-all:3.6.2`，播放页使用原生 VLC Surface 与 Compose 横竖屏 UI，不依赖 ArtPlayer。

## 构建

需要 JDK 17、Android SDK 35、NDK `27.2.12479018`、CMake 3.31.1、Gradle 8.10.2 和 vcpkg。先准备 Android 版 Boost/OpenSSL：

```bash
export ANDROID_NDK_HOME="$ANDROID_HOME/ndk/27.2.12479018"
export VCPKG_ROOT=/path/to/vcpkg
./scripts/prepare-android-torrent-dependencies.sh
gradle -p android :app:assembleDebug :torrent-host:assembleRelease
```

输出位于 `android/torrent-host/build/outputs/aar/torrent-host-release.aar` 和 `android/app/build/outputs/apk/debug/app-debug.apk`。发布 APK/AAB 需按 `docs/release-build.md` 配置 keystore 环境变量。

## 播放器接入

业务层通过 `PlayerLaunchContract.createIntent()` 打开 `PlayerActivity`。必需参数是至少一条媒体 URI；可选参数包括会话 ID、番剧标题、单集标签、封面、简介、续播毫秒位置、字幕 URI 和播放列表。`content://` URI 由调用方授予读取权限，HTTP/HTTPS/HLS 等远程地址直接交给 libVLC。

```kotlin
startActivity(
    PlayerLaunchContract.createIntent(
        context,
        PlayerLaunchRequest(
            sessionId = "episode-session",
            animeTitle = "番剧标题",
            description = "",
            artworkUri = null,
            episodes = listOf(
                PlayerEpisode("episode-1", "番剧标题", "第 01 集", mediaUri)
            ),
            activeIndex = 0,
            startPositionMillis = 0L,
            autoplay = true
        )
    )
)
```
