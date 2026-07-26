import { isTauri } from "@tauri-apps/api/core";
import {
  getPlatformCapabilities,
  resolveAppRuntime,
  type AppRuntimeKind,
  type PlatformCapabilities
} from "@shared/platform-runtime";

/** 读取 Tauri 构建时注入的平台名称。 */
function getNativePlatform(): string | undefined {
  try {
    return isTauri() ? import.meta.env.TAURI_ENV_PLATFORM : undefined;
  } catch (error) {
    console.warn("[runtime] 本地平台读取失败", error);
    return undefined;
  }
}

/** 识别当前 Renderer 运行时。 */
export function getAppRuntime(): AppRuntimeKind {
  return resolveAppRuntime({
    hasTauriBridge: isTauri(),
    nativePlatform: getNativePlatform()
  });
}

/** 判断当前 Renderer 是否由 Tauri 宿主承载。 */
export function isTauriAppRuntime(): boolean {
  return isTauri();
}

/** 返回当前运行时的稳定能力集合。 */
export function getAppCapabilities(): PlatformCapabilities {
  return getPlatformCapabilities(getAppRuntime());
}

/** 判断当前 Renderer 是否运行在本地完整客户端。 */
export function isLocalAppRuntime(): boolean {
  return getAppRuntime() !== "remote";
}
