import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  getPlatformCapabilities,
  isMacOSNativePlatform,
  isMacOSRuntimePlatform,
  resolveAppRuntime
} from "../platform-runtime";

test("非 Tauri WebView 不会被识别为本地移动运行时", () => {
  assert.equal(
    resolveAppRuntime({ hasTauriBridge: false, nativePlatform: "android" }),
    "remote"
  );
});

test("Tauri Android 优先识别为移动运行时", () => {
  assert.equal(
    resolveAppRuntime({ hasTauriBridge: true, nativePlatform: "android" }),
    "android"
  );
});

test("Tauri iOS 优先识别为移动运行时", () => {
  assert.equal(
    resolveAppRuntime({ hasTauriBridge: true, nativePlatform: "ios" }),
    "ios"
  );
});

test("Tauri 桌面不会回退到远程运行时", () => {
  assert.equal(
    resolveAppRuntime({ hasTauriBridge: true, nativePlatform: "windows" }),
    "desktop"
  );
});

test("普通浏览器识别为远程运行时", () => {
  assert.equal(
    resolveAppRuntime({ hasTauriBridge: false, nativePlatform: "web" }),
    "remote"
  );
});

test("兼容识别 Tauri 与 Node 风格的 macOS 平台名", () => {
  assert.equal(isMacOSNativePlatform("macos"), true);
  assert.equal(isMacOSNativePlatform(" Darwin "), true);
  assert.equal(isMacOSNativePlatform("windows"), false);
  assert.equal(isMacOSNativePlatform(undefined), false);
});

test("构建平台缺失时使用 WebView 平台名识别 macOS", () => {
  assert.equal(isMacOSRuntimePlatform(undefined, "MacIntel"), true);
  assert.equal(isMacOSRuntimePlatform(undefined, "Win32"), false);
  assert.equal(isMacOSRuntimePlatform("macos", "Win32"), true);
});

test("Android 能力排除桌面托管进程和远程网关", () => {
  const capabilities = getPlatformCapabilities("android");
  assert.equal(capabilities.localData, true);
  assert.equal(capabilities.embeddedTorrent, true);
  assert.equal(capabilities.managedQbittorrent, false);
  assert.equal(capabilities.mediaScan, false);
  assert.equal(capabilities.remoteGateway, false);
  assert.equal(capabilities.windowControls, false);
});

test("返回能力副本不会污染后续读取", () => {
  const capabilities = getPlatformCapabilities("android");
  capabilities.localData = false;
  assert.equal(getPlatformCapabilities("android").localData, true);
});

test("iOS 能力保留内置下载和原生播放器", () => {
  const capabilities = getPlatformCapabilities("ios");
  assert.equal(capabilities.embeddedTorrent, true);
  assert.equal(capabilities.nativePlayer, true);
  assert.equal(capabilities.managedQbittorrent, false);
  assert.equal(capabilities.mediaScan, false);
  assert.equal(capabilities.remoteGateway, false);
});
