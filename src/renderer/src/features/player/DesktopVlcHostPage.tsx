import { useLayoutEffect } from "react";

/** 为主进程 libVLC 原生子窗口提供稳定的全屏定位容器。 */
export function DesktopVlcHostPage() {
  useLayoutEffect(() => {
    document.documentElement.classList.add("desktop-vlc-host-root");
    return () => document.documentElement.classList.remove("desktop-vlc-host-root");
  }, []);

  return (
    <main className="desktop-vlc-host-page" aria-label="libVLC 视频宿主">
      <div id="vlc-host" className="size-full" />
    </main>
  );
}
