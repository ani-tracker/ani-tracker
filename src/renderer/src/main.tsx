import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { ErrorBoundary } from "./components/error-boundary";
import { ThemeProvider, ThemeToaster } from "./components/theme-provider";
import "./styles/globals.css";

/** 仅在 Web/PWA 生产环境注册离线缓存，避免干扰 Electron 调试。 */
async function registerWebServiceWorker(): Promise<void> {
  if (window.aniBridge || !import.meta.env.PROD || !("serviceWorker" in navigator)) {
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

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <ThemeProvider>
        <App />
        <ThemeToaster />
      </ThemeProvider>
    </ErrorBoundary>
  </React.StrictMode>
);
