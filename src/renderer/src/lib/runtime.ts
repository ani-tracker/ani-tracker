import {
  getPlatformCapabilities,
  resolveAppRuntime,
  type AppRuntimeKind,
  type PlatformCapabilities
} from "@shared/platform-runtime";

/** 读取 Capacitor 注入的平台名称。 */
function getNativePlatform(): string | undefined {
  try {
    return window.Capacitor?.getPlatform?.();
  } catch (error) {
    console.warn("[runtime] Capacitor 平台读取失败", error);
    return undefined;
  }
}

/** 识别当前 Renderer 运行时。 */
export function getAppRuntime(): AppRuntimeKind {
  return resolveAppRuntime({
    hasElectronBridge: Boolean(window.aniBridge),
    nativePlatform: getNativePlatform()
  });
}

/** 返回当前运行时的稳定能力集合。 */
export function getAppCapabilities(): PlatformCapabilities {
  return getPlatformCapabilities(getAppRuntime());
}

/** 判断当前 Renderer 是否运行在本地完整客户端。 */
export function isLocalAppRuntime(): boolean {
  return getAppRuntime() !== "remote";
}
