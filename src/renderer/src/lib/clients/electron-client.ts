import type { AppClient } from "@shared/app-client";

/** 返回 Electron preload 注入的桌面客户端。 */
export function createElectronClient(bridge: AppClient | undefined): AppClient {
  if (!bridge) {
    throw new Error("Electron preload bridge 未初始化");
  }
  return bridge;
}
