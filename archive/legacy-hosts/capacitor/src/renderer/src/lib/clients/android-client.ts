import type { AppClient } from "@shared/app-client";

export interface AndroidClientBridge {
  /** 调用一个经过 Android 插件白名单校验的业务方法。 */
  invoke(method: string, args: unknown[]): Promise<unknown>;
  /** 订阅 Android 下载服务状态变化。 */
  onDownloadServiceStatusChanged?(listener: () => void): () => void;
}

/** 创建 Android 原生插件客户端，未连接插件时返回明确错误。 */
export function createAndroidClient(bridge: AndroidClientBridge | undefined): AppClient {
  return new Proxy({ platform: "android" } as AppClient, {
    get(target, property) {
      if (property === "platform") {
        return target.platform;
      }
      if (property === "onDownloadServiceStatusChanged") {
        return (listener: () => void) => bridge?.onDownloadServiceStatusChanged?.(listener) ?? (() => undefined);
      }
      if (typeof property !== "string") {
        return undefined;
      }
      return (...args: unknown[]) => {
        if (!bridge) {
          return Promise.reject(new Error("Android 原生桥未初始化"));
        }
        return bridge.invoke(property, args);
      };
    }
  });
}
