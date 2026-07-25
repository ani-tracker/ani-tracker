import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { MobileApp, type MobileBootstrapState } from "./MobileApp";
import { ErrorBoundary } from "./components/error-boundary";
import { ThemeProvider, ThemeToaster } from "./components/theme-provider";
import { bootstrapAndroidApplication } from "./platform/android/bootstrap";
import { installAndroidClientBridge } from "./platform/android/capacitor-plugins";
import "./styles/globals.css";

installAndroidClientBridge();

/** 管理 Android 启动阶段，失败时保留可诊断界面而不是白屏。 */
function MobileBootstrap() {
  const [bootstrap, setBootstrap] = useState<MobileBootstrapState>({
    phase: "loading",
    message: "正在准备本地数据库"
  });

  useEffect(() => {
    let active = true;
    void bootstrapAndroidApplication()
      .then(({ seeded }) => {
        if (active) {
          setBootstrap({
            phase: "ready",
            message: seeded ? "本地数据库已创建" : "本地数据库已恢复"
          });
        }
      })
      .catch((error) => {
        console.error("[android-bootstrap] 应用初始化失败", error);
        if (active) {
          setBootstrap({
            phase: "error",
            message: error instanceof Error ? error.message : "本地数据初始化失败"
          });
        }
      });
    return () => {
      active = false;
    };
  }, []);

  return <MobileApp bootstrap={bootstrap} />;
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <ThemeProvider>
        <MobileBootstrap />
        <ThemeToaster />
      </ThemeProvider>
    </ErrorBoundary>
  </React.StrictMode>
);
