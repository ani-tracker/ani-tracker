import {
  useCallback,
  useEffect,
  useRef,
  type MouseEventHandler,
  type PointerEventHandler
} from "react";
import { appApi } from "@/lib/api";
import { isMacOSTauriRuntime } from "@/lib/runtime";

const PLAYER_NO_DRAG_SELECTOR = [
  "[data-player-no-drag]",
  "button",
  "a",
  "input",
  "select",
  "textarea",
  "[role='button']",
  "[role='menuitem']",
  "[role='slider']"
].join(",");

interface DesktopWindowDragState {
  pointerId: number;
  latestScreenX: number;
  latestScreenY: number;
  sentScreenX: number;
  sentScreenY: number;
  animationFrame?: number;
}

export interface DesktopWindowDragHandlers {
  onDoubleClick: MouseEventHandler<HTMLElement>;
  onLostPointerCapture?: PointerEventHandler<HTMLElement>;
  onPointerCancel?: PointerEventHandler<HTMLElement>;
  onPointerDown?: PointerEventHandler<HTMLElement>;
  onPointerMove?: PointerEventHandler<HTMLElement>;
  onPointerUp?: PointerEventHandler<HTMLElement>;
}

/** 在 macOS 上按动画帧合并指针事件，由主进程移动视频父窗口。 */
export function useDesktopWindowDrag(): {
  handlers?: DesktopWindowDragHandlers;
  nativeWindowDrag: boolean;
} {
  const customWindowDrag = isMacOSTauriRuntime();
  const dragStateRef = useRef<DesktopWindowDragState>();

  const flushMove = useCallback((): void => {
    const state = dragStateRef.current;
    if (!state) return;
    state.animationFrame = undefined;
    if (state.latestScreenX === state.sentScreenX && state.latestScreenY === state.sentScreenY) return;
    state.sentScreenX = state.latestScreenX;
    state.sentScreenY = state.latestScreenY;
    appApi.dragDesktopPlayerWindow({
      phase: "move",
      screenX: state.latestScreenX,
      screenY: state.latestScreenY
    });
  }, []);

  const finishDrag = useCallback((event: Parameters<PointerEventHandler<HTMLElement>>[0], flushFinalMove: boolean): void => {
    const state = dragStateRef.current;
    if (!state || state.pointerId !== event.pointerId) return;
    if (state.animationFrame !== undefined) {
      window.cancelAnimationFrame(state.animationFrame);
      state.animationFrame = undefined;
    }
    if (flushFinalMove) {
      state.latestScreenX = event.screenX;
      state.latestScreenY = event.screenY;
      flushMove();
    }
    appApi.dragDesktopPlayerWindow({ phase: "end" });
    dragStateRef.current = undefined;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, [flushMove]);

  const handlers: DesktopWindowDragHandlers = {
    onDoubleClick: (event) => {
      if (event.button !== 0 || (event.target as Element).closest(PLAYER_NO_DRAG_SELECTOR)) return;
      event.preventDefault();
      void appApi.toggleDesktopPlayerWindowMaximize().catch((error) => {
        console.error("[player] 切换播放器窗口最大化失败", error);
      });
    },
    ...(customWindowDrag ? {
      onPointerDown: (event) => {
        if (event.button !== 0 || (event.target as Element).closest(PLAYER_NO_DRAG_SELECTOR)) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        dragStateRef.current = {
          pointerId: event.pointerId,
          latestScreenX: event.screenX,
          latestScreenY: event.screenY,
          sentScreenX: event.screenX,
          sentScreenY: event.screenY
        };
        appApi.dragDesktopPlayerWindow({ phase: "start", screenX: event.screenX, screenY: event.screenY });
      },
      onPointerMove: (event) => {
        const state = dragStateRef.current;
        if (!state || state.pointerId !== event.pointerId) return;
        state.latestScreenX = event.screenX;
        state.latestScreenY = event.screenY;
        if (state.animationFrame === undefined) {
          state.animationFrame = window.requestAnimationFrame(flushMove);
        }
      },
      onPointerUp: (event) => finishDrag(event, true),
      onPointerCancel: (event) => finishDrag(event, false),
      onLostPointerCapture: (event) => finishDrag(event, false)
    } : {})
  };

  useEffect(() => () => {
    const state = dragStateRef.current;
    if (!state) return;
    if (state.animationFrame !== undefined) window.cancelAnimationFrame(state.animationFrame);
    appApi.dragDesktopPlayerWindow({ phase: "end" });
    dragStateRef.current = undefined;
  }, []);

  return {
    handlers,
    nativeWindowDrag: !customWindowDrag
  };
}
