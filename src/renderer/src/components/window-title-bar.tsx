import { Copy, Minus, Square, X } from "lucide-react";
import { type CSSProperties, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { appApi } from "@/lib/api";

const dragRegionStyle = { WebkitAppRegion: "drag" } as CSSProperties;
const noDragRegionStyle = { WebkitAppRegion: "no-drag" } as CSSProperties;

/** 渲染 Windows 无边框主窗口的自绘标题栏。 */
export function WindowTitleBar() {
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
    <header
      aria-label="应用窗口标题栏"
      className="fixed inset-x-0 top-0 z-50 flex h-9 items-center border-b bg-background text-foreground"
      style={dragRegionStyle}
    >
      <div
        className="flex min-w-0 flex-1 items-center gap-2 px-3"
        onDoubleClick={() => void toggleMaximize()}
      >
        <img
          alt=""
          className="h-4 w-6 shrink-0 object-contain"
          draggable={false}
          src="./icons/ani-tracker-mark.png"
        />
        <span className="truncate text-xs font-medium">Ani Tracker</span>
      </div>
      <div className="flex h-full shrink-0" style={noDragRegionStyle}>
        <Button
          aria-label="最小化窗口"
          className="h-9 min-h-0 w-11 rounded-none p-0"
          onClick={() => void appApi.minimizeWindow()}
          title="最小化"
          type="button"
          variant="ghost"
        >
          <Minus data-icon="inline-start" />
        </Button>
        <Button
          aria-label={maximized ? "还原窗口" : "最大化窗口"}
          className="h-9 min-h-0 w-11 rounded-none p-0"
          onClick={() => void toggleMaximize()}
          title={maximized ? "还原" : "最大化"}
          type="button"
          variant="ghost"
        >
          {maximized ? <Copy data-icon="inline-start" /> : <Square data-icon="inline-start" />}
        </Button>
        <Button
          aria-label="关闭窗口"
          className="h-9 min-h-0 w-11 rounded-none p-0 hover:bg-destructive hover:text-destructive-foreground"
          onClick={() => void appApi.closeWindow()}
          title="关闭"
          type="button"
          variant="ghost"
        >
          <X data-icon="inline-start" />
        </Button>
      </div>
    </header>
  );
}
