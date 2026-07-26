import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "@/renderer-app";
import { ErrorBoundary } from "./components/error-boundary";
import { ThemeProvider, ThemeToaster } from "./components/theme-provider";
import { appApi } from "@/lib/api";
import { isLocalAppRuntime } from "./lib/runtime";
import type { AppearanceSettings } from "@shared/theme";
import "./styles/globals.css";

/** 仅在 Web/PWA 生产环境注册离线缓存，避免干扰本地应用宿主。 */
async function registerWebServiceWorker(): Promise<void> {
  if (isLocalAppRuntime() || !import.meta.env.PROD || !("serviceWorker" in navigator)) {
    return;
  }

  try {
    await navigator.serviceWorker.register("/sw.js");
    console.info("[renderer] Web Service Worker 注册完成");
  } catch (error) {
    console.error("[renderer] Web Service Worker 注册失败", error);
  }
}

void registerWebServiceWorker();

/** 所有本地宿主从 SQLite 读取持久化外观，远程网页继续使用浏览器缓存。 */
async function loadRuntimeAppearance(): Promise<AppearanceSettings | undefined> {
  if (!isLocalAppRuntime()) {
    return undefined;
  }
  return (await appApi.getSettings()).appearance;
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <ThemeProvider loadAppearance={loadRuntimeAppearance}>
        <App />
        <ThemeToaster />
      </ThemeProvider>
    </ErrorBoundary>
  </React.StrictMode>
);
