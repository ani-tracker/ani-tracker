# VLC source and replacement information

## Desktop

- VLC/libVLC: 3.0.21 on Windows and macOS. Linux packages record the exact
  distribution version in the generated `SOURCE.json`.
- Upstream source: https://get.videolan.org/vlc/3.0.21/vlc-3.0.21.tar.xz
- Source SHA-256: `24dbbe1d7dfaeea0994d5def0bbde200177347136dbfe573f5b6a4cee25afbb0`
- Upstream repository: https://code.videolan.org/videolan/vlc
- Ani Tracker does not modify VLC source code. Linux packaging only adjusts
  copied ELF RPATH values so the shared libraries remain relocatable.
- Tauri desktop dynamically loads the libVLC C API through the Rust player
  adapter; Ani Tracker does not statically link VLC.

To use a modified library, close Ani Tracker and replace the complete
`resources/libvlc/<platform-arch>` directory with a compatible VLC 3.0.x
runtime that preserves the expected library names and `plugins` directory.

## Android

- Maven artifact: `org.videolan.android:libvlc-all:3.6.2`
- Source: https://code.videolan.org/videolan/vlc-android
- License declared by the artifact: GNU LGPL 2.1.

## iOS

- CocoaPod: `MobileVLCKit 3.7.3`
- Source: https://code.videolan.org/videolan/VLCKit
- License: GNU LGPL 2.1 or later, subject to the notices in the upstream SDK.

No local modifications are applied to the Android AAR or MobileVLCKit
framework. Exact binary metadata is retained by Gradle and CocoaPods lock data
or build logs.
