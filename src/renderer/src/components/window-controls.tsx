import { Copy, Minus, Square, X } from "lucide-react";
import { type CSSProperties, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { appApi } from "@/lib/api";

const dragRegionStyle = { WebkitAppRegion: "drag" } as CSSProperties;
const noDragRegionStyle = { WebkitAppRegion: "no-drag" } as CSSProperties;

/** 为桌面端无边框主窗口提供顶部拖拽热区和窗口控制按钮。 */
export function WindowControls() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let active = true;
    void appApi.getWindowState().then((state) => {
      if (active) setMaximized(state.maximized);
    });
    const unsubscribe = window.aniBridge?.onWindowStateChanged((state) => setMaximized(state.maximized));
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, []);

  /** 切换最大化状态并立即同步按钮图标。 */
  async function toggleMaximize() {
    const state = await appApi.toggleMaximizeWindow();
    setMaximized(state.maximized);
  }

  return (
    <>
      <div
        aria-hidden="true"
        className="fixed left-0 right-[var(--window-controls-width)] top-0 z-40 hidden h-[var(--app-content-padding)] md:block"
        data-tauri-drag-region=""
        data-window-drag-region=""
        onDoubleClick={() => void toggleMaximize()}
        style={dragRegionStyle}
      />
      <div
        aria-label="窗口控制"
        className="fixed right-0 top-0 z-50 flex h-[var(--window-control-height)] w-[var(--window-controls-width)] shrink-0 bg-transparent text-foreground"
        data-window-controls=""
        role="group"
        style={noDragRegionStyle}
      >
        <Button
          aria-label="最小化窗口"
          className="h-[var(--window-control-height)] min-h-0 w-11 rounded-none p-0"
          onClick={() => void appApi.minimizeWindow()}
          title="最小化"
          type="button"
          variant="ghost"
        >
          <Minus aria-hidden="true" data-icon="inline-start" />
        </Button>
        <Button
          aria-label={maximized ? "还原窗口" : "最大化窗口"}
          className="h-[var(--window-control-height)] min-h-0 w-11 rounded-none p-0"
          onClick={() => void toggleMaximize()}
          title={maximized ? "还原" : "最大化"}
          type="button"
          variant="ghost"
        >
          {maximized ? (
            <Copy aria-hidden="true" data-icon="inline-start" />
          ) : (
            <Square aria-hidden="true" data-icon="inline-start" />
          )}
        </Button>
        <Button
          aria-label="关闭窗口"
          className="h-[var(--window-control-height)] min-h-0 w-11 rounded-none p-0 hover:bg-destructive hover:text-destructive-foreground"
          onClick={() => void appApi.closeWindow()}
          title="关闭"
          type="button"
          variant="ghost"
        >
          <X aria-hidden="true" data-icon="inline-start" />
        </Button>
      </div>
    </>
  );
}
