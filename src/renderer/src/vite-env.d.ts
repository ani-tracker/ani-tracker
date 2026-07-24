/// <reference types="vite/client" />

import type { AppClient } from "@shared/app-client";

/** Capacitor 在 WebView 中注入的最小运行时信息。 */
interface CapacitorRuntimeBridge {
  getPlatform?: () => string;
  isNativePlatform?: () => boolean;
}

/** Android 原生插件向业务客户端提供的统一调用入口。 */
interface AndroidAppBridge {
  invoke(method: string, args: unknown[]): Promise<unknown>;
  onDownloadServiceStatusChanged?(listener: () => void): () => void;
}

declare global {
  interface Window {
    aniBridge?: AppClient;
    aniAndroidBridge?: AndroidAppBridge;
    Capacitor?: CapacitorRuntimeBridge;
  }
}

interface ImportMetaEnv {
  readonly VITE_ANI_REMOTE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
