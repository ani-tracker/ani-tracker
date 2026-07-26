import assert from "node:assert/strict";
import test from "node:test";

import {
  verifyEntries,
  verifyUnsignedIosPackage
} from "./verify-tauri-mobile-package.mjs";

const unsignedIosEntries = [
  "Payload/",
  "Payload/Ani Tracker.app/",
  "Payload/Ani Tracker.app/Info.plist",
  "Payload/Ani Tracker.app/Frameworks/AniTorrentCore.framework/AniTorrentCore",
  "Payload/Ani Tracker.app/Frameworks/MobileVLCKit.framework/MobileVLCKit",
  "Payload/Ani Tracker.app/licenses/torrent-core/libtorrent-BSD-3-Clause.txt",
  "Payload/Ani Tracker.app/licenses/vlc/SOURCE.md",
  "Payload/Ani Tracker.app/licenses/ani-tracker-LICENSE.txt"
];

const androidEntries = [
  "AndroidManifest.xml",
  "lib/arm64-v8a/libani_torrent_core.so",
  "lib/arm64-v8a/libvlc.so",
  "lib/arm64-v8a/libvlcjni.so",
  "assets/licenses/torrent-core/libtorrent-BSD-3-Clause.txt",
  "assets/licenses/vlc/SOURCE.md",
  "assets/licenses/ani-tracker/LICENSE.txt"
];

test("接受包含 ARM64 torrent-core、LibVLC 和许可证的 Android APK", () => {
  assert.doesNotThrow(() => verifyEntries("android", "ani-tracker.apk", androidEntries));
});

test("接受 AAB 的 base 模块原生库和许可证路径", () => {
  assert.doesNotThrow(() => verifyEntries(
    "android",
    "ani-tracker.aab",
    androidEntries.map((entry) => `base/${entry}`)
  ));
});

test("拒绝缺少内置 torrent-core 的 Android 安装包", () => {
  assert.throws(
    () => verifyEntries(
      "android",
      "missing-torrent.apk",
      androidEntries.filter((entry) => !entry.endsWith("libani_torrent_core.so"))
    ),
    /ARM64 内置 torrent-core/
  );
});

test("拒绝缺少 LibVLC JNI 的 Android 安装包", () => {
  assert.throws(
    () => verifyEntries(
      "android",
      "missing-vlc.apk",
      androidEntries.filter((entry) => !entry.endsWith("libvlcjni.so"))
    ),
    /ARM64 LibVLC JNI/
  );
});

test("接受包含应用目录且不含签名材料的 iOS IPA", () => {
  assert.doesNotThrow(() => verifyEntries("ios", "ani-tracker.ipa", unsignedIosEntries));
  assert.doesNotThrow(() => verifyUnsignedIosPackage("ios", "ani-tracker.ipa", unsignedIosEntries));
});

test("拒绝不含 Payload 应用目录的伪 iOS IPA", () => {
  assert.throws(
    () => verifyEntries("ios", "invalid.ipa", ["README.txt"]),
    /缺少 Payload\/\*\.app/
  );
});

test("拒绝缺少 AniTorrentCore 的 iOS IPA", () => {
  assert.throws(
    () => verifyEntries(
      "ios",
      "missing-torrent.ipa",
      unsignedIosEntries.filter((entry) => !entry.includes("AniTorrentCore.framework"))
    ),
    /内置 AniTorrentCore/
  );
});

test("拒绝缺少 MobileVLCKit 的 iOS IPA", () => {
  assert.throws(
    () => verifyEntries(
      "ios",
      "missing-vlc.ipa",
      unsignedIosEntries.filter((entry) => !entry.includes("MobileVLCKit.framework"))
    ),
    /内置 MobileVLCKit/
  );
});

test("拒绝缺少 torrent-core 许可证的移动安装包", () => {
  assert.throws(
    () => verifyEntries(
      "android",
      "missing-license.apk",
      androidEntries.filter((entry) => !entry.includes("libtorrent-BSD-3-Clause.txt"))
    ),
    /torrent-core 许可证/
  );
});

test("拒绝仍包含代码签名目录的 iOS 用户重签包", () => {
  assert.throws(
    () => verifyUnsignedIosPackage("ios", "signed.ipa", [
      ...unsignedIosEntries,
      "Payload/Ani Tracker.app/_CodeSignature/CodeResources"
    ]),
    /仍包含签名材料/
  );
});

test("拒绝仍包含描述文件的 iOS 用户重签包", () => {
  assert.throws(
    () => verifyUnsignedIosPackage("ios", "profile.ipa", [
      ...unsignedIosEntries,
      "Payload/Ani Tracker.app/embedded.mobileprovision"
    ]),
    /仍包含签名材料/
  );
});
