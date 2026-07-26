import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [
  mobileGate,
  androidRelease,
  iosRelease,
  androidGradle,
  androidRootGradle,
  androidPlayerGradle,
  androidGradleProperties,
  iosTorrentScript,
  iosTorrentCmake,
  iosTorrentModuleMap,
  iosFrameworkVerifier,
  playerPackage,
  torrentPackage,
  playerError,
  windowCommands
] = await Promise.all([
  readFile(".github/workflows/tauri-mobile.yml", "utf8"),
  readFile(".github/workflows/tauri-release-android.yml", "utf8"),
  readFile(".github/workflows/tauri-release-ios.yml", "utf8"),
  readFile("src-tauri/gen/android/app/build.gradle.kts", "utf8"),
  readFile("src-tauri/gen/android/build.gradle.kts", "utf8"),
  readFile("crates/tauri-plugin-ani-player/android/build.gradle.kts", "utf8"),
  readFile("src-tauri/gen/android/gradle.properties", "utf8"),
  readFile("scripts/prepare-ios-torrent-core.sh", "utf8"),
  readFile("native/torrent-core/CMakeLists.txt", "utf8"),
  readFile("native/torrent-core/apple/AniTorrentCore.modulemap", "utf8"),
  readFile("scripts/verify-ios-xcframework.sh", "utf8"),
  readFile("crates/tauri-plugin-ani-player/ios/Package.swift", "utf8"),
  readFile("crates/tauri-plugin-ani-torrent/ios/Package.swift", "utf8"),
  readFile("crates/tauri-plugin-ani-player/src/error.rs", "utf8"),
  readFile("src-tauri/src/commands/window.rs", "utf8")
]);

test("移动持续门禁真实编译两端产物并检查原生与包边界", () => {
  assert.match(mobileGate, /pull_request:/);
  assert.match(mobileGate, /tauri android build --target aarch64 --debug --apk --ci/);
  assert.match(mobileGate, /:tauri-plugin-ani-mobile:testDebugUnitTest/);
  assert.match(mobileGate, /verify:tauri:android-package/);
  assert.match(mobileGate, /tauri ios build --target aarch64 --ci --no-sign/);
  assert.match(mobileGate, /build-for-testing/);
  assert.match(mobileGate, /verify:tauri:ios-package -- --require-unsigned/);
});

test("Android 正式发布同时强制长期 JKS、自签校验与原生单测", () => {
  assert.match(androidRelease, /Missing required Android self-signing secret/);
  assert.match(androidRelease, /tauri android build --target aarch64 --apk --ci/);
  assert.match(androidRelease, /:tauri-plugin-ani-mobile:testReleaseUnitTest/);
  assert.match(androidRelease, /apksigner[^\n]*verify --verbose --print-certs/);
  assert.match(androidGradle, /taskNames\.any \{ it\.contains\("release", ignoreCase = true\) \}/);
  assert.match(androidGradle, /Android Release 必须配置 ANI_ANDROID_KEYSTORE_PATH/);
});

test("Android 播放器固定已验证的 Kotlin Compose 编译器与 JVM 资源边界", () => {
  assert.match(androidRootGradle, /kotlin-gradle-plugin:2\.0\.21/);
  assert.match(androidRootGradle, /compose-compiler-gradle-plugin:2\.0\.21/);
  assert.match(androidPlayerGradle, /id\("org\.jetbrains\.kotlin\.plugin\.compose"\)/);
  assert.doesNotMatch(androidPlayerGradle, /kotlinCompilerExtensionVersion/);
  assert.match(androidGradleProperties, /org\.gradle\.jvmargs=-Xmx4g/);
  assert.match(androidGradle, /sourceCompatibility = JavaVersion\.VERSION_17/);
  assert.match(androidGradle, /jvmTarget = "17"/);
  assert.match(mobileGate, /Diagnose Android Kotlin compiler failure/);
  assert.match(mobileGate, /steps\.android_build\.outcome == 'failure'/);
  assert.match(mobileGate, /:tauri-plugin-ani-player:compileDebugKotlin/);
  assert.match(mobileGate, /kotlin\.compiler\.execution\.strategy=in-process/);
});

test("iOS 正式发布保持未签名 IPA 与用户重签边界", () => {
  assert.match(iosRelease, /tauri ios build --target aarch64 --ci --no-sign/);
  assert.match(iosRelease, /package-unsigned-ios-ipa\.sh/);
  assert.match(iosRelease, /verify:tauri:ios-package -- --require-unsigned/);
  assert.doesNotMatch(iosRelease, /APPLE_(?:CERTIFICATE|PROVISIONING_PROFILE)/);
});

test("iOS torrent-core 隔离设备与模拟器依赖并在构建前校验", () => {
  assert.match(iosTorrentScript, /printf '%s\/device' "\$\{dependency_root\}"/);
  assert.match(iosTorrentScript, /printf '%s\/simulator' "\$\{dependency_root\}"/);
  assert.match(iosTorrentScript, /validate_dependencies "\$\{triplet\}"/);
  assert.match(iosTorrentScript, /package_framework_slice "\$\{build_root\}\/Release-\$\{sdk\}\/AniTorrentCore\.framework"/);
  assert.match(iosTorrentScript, /Headers\/AniTorrentCore\.h/);
  assert.match(iosTorrentScript, /Modules\/module\.modulemap/);
  assert.match(iosTorrentScript, /include\/boost\/version\.hpp/);
  assert.match(iosTorrentScript, /lib\/libcrypto\.a/);
});

test("iOS 原生插件校验 XCFramework 模块并显式提供切片搜索路径", () => {
  assert.match(iosTorrentCmake, /XCODE_ATTRIBUTE_MODULEMAP_FILE/);
  assert.match(iosTorrentCmake, /XCODE_ATTRIBUTE_CLANG_ENABLE_MODULES "YES"/);
  assert.match(iosTorrentCmake, /TARGET_BUNDLE_DIR:AniTorrentCore>\/Headers\/AniTorrentCore\.h/);
  assert.match(iosTorrentCmake, /TARGET_BUNDLE_DIR:AniTorrentCore>\/Modules\/module\.modulemap/);
  assert.match(iosTorrentModuleMap, /framework module AniTorrentCore/);
  assert.match(iosTorrentModuleMap, /umbrella header "AniTorrentCore\.h"/);
  assert.match(iosFrameworkVerifier, /Modules\/module\.modulemap/);
  assert.match(iosFrameworkVerifier, /--sdk "\$\{sdk\}" swiftc/);
  assert.match(iosFrameworkVerifier, /arm64-apple-ios\$\{deployment_target\}-simulator/);
  assert.match(playerPackage, /xcframeworkSearchFlags\(named: "MobileVLCKit"\)/);
  assert.match(torrentPackage, /xcframeworkSearchFlags\(named: "AniTorrentCore"\)/);
});

test("移动窗口命令不会编译桌面最小化与最大化 API", () => {
  assert.match(windowCommands, /#\[cfg\(desktop\)\][\s\S]*?\.minimize\(\)/);
  assert.match(windowCommands, /#\[cfg\(desktop\)\][\s\S]*?\.unmaximize\(\)/);
  assert.match(windowCommands, /#\[cfg\(mobile\)\][\s\S]*?window_operation_unsupported/);
});

test("移动播放器注册错误支持 Tauri PluginInvokeError", () => {
  assert.match(playerError, /PluginInvoke\(#\[from\] tauri::plugin::mobile::PluginInvokeError\)/);
});
