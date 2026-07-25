import { strict as assert } from "node:assert";
import { test } from "node:test";
import { getPlatformCapabilities, resolveAppRuntime } from "../platform-runtime";

test("Electron bridge 优先识别为桌面运行时", () => {
  assert.equal(
    resolveAppRuntime({ hasElectronBridge: true, hasTauriBridge: true, nativePlatform: "android" }),
    "desktop"
  );
});

test("Capacitor Android 不会回退到远程运行时", () => {
  assert.equal(
    resolveAppRuntime({ hasElectronBridge: false, hasTauriBridge: false, nativePlatform: "android" }),
    "android"
  );
});

test("Tauri Android 优先识别为移动运行时", () => {
  assert.equal(
    resolveAppRuntime({ hasElectronBridge: false, hasTauriBridge: true, nativePlatform: "android" }),
    "android"
  );
});

test("Tauri iOS 优先识别为移动运行时", () => {
  assert.equal(
    resolveAppRuntime({ hasElectronBridge: false, hasTauriBridge: true, nativePlatform: "ios" }),
    "ios"
  );
});

test("Tauri 桌面不会回退到远程运行时", () => {
  assert.equal(
    resolveAppRuntime({ hasElectronBridge: false, hasTauriBridge: true, nativePlatform: "windows" }),
    "desktop"
  );
});

test("普通浏览器识别为远程运行时", () => {
  assert.equal(
    resolveAppRuntime({ hasElectronBridge: false, hasTauriBridge: false, nativePlatform: "web" }),
    "remote"
  );
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
