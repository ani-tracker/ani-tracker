import type { BrowserWindow, BrowserWindowConstructorOptions, Rectangle } from "electron";
import type { DesktopPlayerWindowDragInput, DesktopPlayerWindowInput } from "@shared/contracts";
import {
  createDesktopPlayerSearchParams,
  createDesktopVlcHostSearchParams
} from "@shared/desktop-player-route";
import { logger } from "../logger";

interface PlayerWindowWebContents {
  id: number;
  on(event: "did-fail-load", listener: (...args: unknown[]) => void): void;
  on(event: "render-process-gone", listener: (...args: unknown[]) => void): void;
}

type PlayerWindowEvent =
  | "closed"
  | "move"
  | "resize"
  | "minimize"
  | "restore"
  | "maximize"
  | "unmaximize"
  | "enter-full-screen"
  | "leave-full-screen"
  | "focus";

export interface DesktopPlayerBrowserWindow {
  webContents: PlayerWindowWebContents;
  loadURL(url: string): Promise<void>;
  loadFile(filePath: string, options?: { query?: Record<string, string> }): Promise<void>;
  on(event: PlayerWindowEvent, listener: () => void): void;
  isDestroyed(): boolean;
  show(): void;
  focus(): void;
  close(): void;
  destroy(): void;
  minimize(): void;
  restore(): void;
  isMinimized(): boolean;
  maximize(): void;
  unmaximize(): void;
  isMaximized(): boolean;
  setFullScreen(fullscreen: boolean): void;
  isFullScreen(): boolean;
  getBounds(): Rectangle;
  setBounds(bounds: Rectangle, animate?: boolean): void;
  setMenuBarVisibility(visible: boolean): void;
  removeMenu(): void;
}

interface DesktopPlayerWindowPair {
  ownerId: number;
  taskId: string;
  videoWindow: DesktopPlayerBrowserWindow;
  controlWindow: DesktopPlayerBrowserWindow;
  syncingBounds: boolean;
  syncingState: boolean;
  cleanupStarted: boolean;
  dragState?: {
    pointerStartX: number;
    pointerStartY: number;
    windowStartX: number;
    windowStartY: number;
  };
}

export interface DesktopPlayerWindowServiceOptions {
  createWindow: (options: BrowserWindowConstructorOptions) => DesktopPlayerBrowserWindow;
  preloadPath: string;
  rendererFilePath: string;
  rendererUrl?: string;
  prepareVideoHost?: (ownerId: number, window: DesktopPlayerBrowserWindow) => void | Promise<void>;
  onWindowClosed?: (webContentsId: number) => void | Promise<void>;
  platform?: NodeJS.Platform;
}

/** 创建并协调 libVLC 视频宿主与透明 React 控制层窗口。 */
export class DesktopPlayerWindowService {
  private readonly pairs = new Map<number, DesktopPlayerWindowPair>();
  private readonly platform: NodeJS.Platform;

  constructor(private readonly options: DesktopPlayerWindowServiceOptions) {
    this.platform = options.platform ?? process.platform;
  }

  /** 每次播放请求创建一组无边框视频/控制窗口。 */
  async open(input: DesktopPlayerWindowInput): Promise<void> {
    const playerSearchParams = createDesktopPlayerSearchParams(input);
    const initialBounds = { width: 1280, height: 800 };
    const videoWindow = this.options.createWindow({
      ...initialBounds,
      minWidth: 800,
      minHeight: 520,
      title: "Ani Tracker 播放器",
      show: false,
      frame: false,
      autoHideMenuBar: true,
      backgroundColor: "#000000",
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false
      }
    });
    const controlWindow = this.options.createWindow({
      ...initialBounds,
      minWidth: 800,
      minHeight: 520,
      title: "Ani Tracker 播放器控制层",
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      hasShadow: false,
      skipTaskbar: true,
      parent: videoWindow as unknown as BrowserWindow,
      ...(this.platform === "darwin" ? { movable: false } : {}),
      autoHideMenuBar: true,
      webPreferences: {
        preload: this.options.preloadPath,
        sandbox: false,
        contextIsolation: true,
        nodeIntegration: false
      }
    });
    const ownerId = controlWindow.webContents.id;
    const pair: DesktopPlayerWindowPair = {
      ownerId,
      taskId: input.taskId,
      videoWindow,
      controlWindow,
      syncingBounds: false,
      syncingState: false,
      cleanupStarted: false
    };
    this.pairs.set(ownerId, pair);
    this.bindPairLifecycle(pair);
    this.removeMenus(videoWindow, controlWindow);

    try {
      await this.loadRenderer(videoWindow, createDesktopVlcHostSearchParams());
      await this.options.prepareVideoHost?.(ownerId, videoWindow);
      await this.loadRenderer(controlWindow, playerSearchParams);
      if (!videoWindow.isDestroyed() && !controlWindow.isDestroyed()) {
        this.syncBounds(
          pair,
          this.platform === "darwin" ? videoWindow : controlWindow,
          this.platform === "darwin" ? controlWindow : videoWindow
        );
        videoWindow.show();
        controlWindow.show();
        controlWindow.focus();
      }
      logger.info("无边框 libVLC 播放器窗口已打开", {
        ownerId,
        videoWebContentsId: videoWindow.webContents.id,
        taskId: input.taskId,
        fileIndex: input.fileIndex
      });
    } catch (error) {
      this.destroyPair(pair);
      logger.error("无边框 libVLC 播放器窗口加载失败", {
        ownerId,
        taskId: input.taskId,
        errorType: error instanceof Error ? error.name : typeof error
      });
      throw error;
    }
  }

  /** 关闭调用方所属的一整组播放器窗口。 */
  close(ownerId: number): boolean {
    const pair = this.pairs.get(ownerId);
    if (!pair || pair.cleanupStarted) return false;
    if (!pair.controlWindow.isDestroyed()) pair.controlWindow.close();
    else if (!pair.videoWindow.isDestroyed()) pair.videoWindow.close();
    return true;
  }

  /** 在 macOS 上移动视频父窗口，透明控制层交由系统原生跟随。 */
  drag(ownerId: number, input: DesktopPlayerWindowDragInput): boolean {
    const pair = this.pairs.get(ownerId);
    if (this.platform !== "darwin" || !pair || pair.cleanupStarted || !isValidDragInput(input)) return false;

    if (input.phase === "end") {
      const dragged = Boolean(pair.dragState);
      pair.dragState = undefined;
      if (dragged) logger.info("macOS 独立播放器窗口拖动结束", { ownerId, taskId: pair.taskId });
      return dragged;
    }
    if (!isFiniteScreenPoint(input) || pair.videoWindow.isDestroyed()) return false;

    if (input.phase === "start") {
      if (pair.videoWindow.isFullScreen() || pair.videoWindow.isMaximized()) return false;
      const bounds = pair.videoWindow.getBounds();
      pair.dragState = {
        pointerStartX: input.screenX,
        pointerStartY: input.screenY,
        windowStartX: bounds.x,
        windowStartY: bounds.y
      };
      logger.info("macOS 独立播放器窗口拖动开始", { ownerId, taskId: pair.taskId });
      return true;
    }

    const dragState = pair.dragState;
    if (!dragState || pair.videoWindow.isFullScreen() || pair.videoWindow.isMaximized()) return false;
    const bounds = pair.videoWindow.getBounds();
    const nextBounds = {
      ...bounds,
      x: Math.round(dragState.windowStartX + input.screenX - dragState.pointerStartX),
      y: Math.round(dragState.windowStartY + input.screenY - dragState.pointerStartY)
    };
    if (nextBounds.x !== bounds.x || nextBounds.y !== bounds.y) {
      pair.videoWindow.setBounds(nextBounds, false);
    }
    return true;
  }

  /** 同步切换视频宿主与控制层的全屏状态。 */
  setFullscreen(ownerId: number, fullscreen: boolean): boolean {
    const pair = this.pairs.get(ownerId);
    if (!pair || pair.cleanupStarted) return false;
    pair.dragState = undefined;
    this.withStateSync(pair, () => {
      if (!pair.videoWindow.isDestroyed()) pair.videoWindow.setFullScreen(fullscreen);
      if (!pair.controlWindow.isDestroyed()) pair.controlWindow.setFullScreen(fullscreen);
    });
    return fullscreen;
  }

  /** 加载开发服务器或生产 renderer 文件，并传递窗口用途参数。 */
  private async loadRenderer(window: DesktopPlayerBrowserWindow, searchParams: URLSearchParams): Promise<void> {
    if (this.options.rendererUrl) {
      const targetUrl = new URL(this.options.rendererUrl);
      targetUrl.search = searchParams.toString();
      await window.loadURL(targetUrl.toString());
      return;
    }
    await window.loadFile(this.options.rendererFilePath, {
      query: Object.fromEntries(searchParams.entries())
    });
  }

  /** 绑定窗口几何、状态、焦点和关闭生命周期的双向同步。 */
  private bindPairLifecycle(pair: DesktopPlayerWindowPair): void {
    const { videoWindow, controlWindow } = pair;
    this.bindWindowDiagnostics(videoWindow, pair, "视频宿主");
    this.bindWindowDiagnostics(controlWindow, pair, "控制层");

    if (this.platform === "darwin") {
      controlWindow.on("resize", () => this.syncMacControlResize(pair));
      videoWindow.on("resize", () => this.syncBounds(pair, videoWindow, controlWindow));
    } else {
      for (const event of ["move", "resize"] as const) {
        controlWindow.on(event, () => this.syncBounds(pair, controlWindow, videoWindow));
        videoWindow.on(event, () => this.syncBounds(pair, videoWindow, controlWindow));
      }
    }
    for (const event of ["minimize", "restore", "maximize", "unmaximize"] as const) {
      controlWindow.on(event, () => this.syncWindowState(pair, controlWindow, videoWindow, event));
      videoWindow.on(event, () => this.syncWindowState(pair, videoWindow, controlWindow, event));
    }
    controlWindow.on("enter-full-screen", () => this.syncFullscreen(pair, controlWindow, videoWindow, true));
    controlWindow.on("leave-full-screen", () => this.syncFullscreen(pair, controlWindow, videoWindow, false));
    videoWindow.on("enter-full-screen", () => this.syncFullscreen(pair, videoWindow, controlWindow, true));
    videoWindow.on("leave-full-screen", () => this.syncFullscreen(pair, videoWindow, controlWindow, false));
    videoWindow.on("focus", () => {
      if (!pair.cleanupStarted && !controlWindow.isDestroyed()) controlWindow.focus();
    });
    controlWindow.on("closed", () => this.handleWindowClosed(pair, "control"));
    videoWindow.on("closed", () => this.handleWindowClosed(pair, "video"));
  }

  /** 记录页面加载与 renderer 异常，便于区分 VLC 和页面故障。 */
  private bindWindowDiagnostics(
    window: DesktopPlayerBrowserWindow,
    pair: DesktopPlayerWindowPair,
    role: string
  ): void {
    window.webContents.on("did-fail-load", (...args) => {
      logger.error(`独立播放器${role}页面加载失败`, {
        ownerId: pair.ownerId,
        taskId: pair.taskId,
        errorCode: args[1],
        errorDescription: args[2]
      });
    });
    window.webContents.on("render-process-gone", (...args) => {
      logger.error(`独立播放器${role}渲染进程退出`, {
        ownerId: pair.ownerId,
        taskId: pair.taskId,
        details: args[1]
      });
    });
  }

  private syncBounds(
    pair: DesktopPlayerWindowPair,
    source: DesktopPlayerBrowserWindow,
    target: DesktopPlayerBrowserWindow
  ): void {
    if (pair.syncingBounds || pair.cleanupStarted || source.isDestroyed() || target.isDestroyed()) return;
    const sourceBounds = source.getBounds();
    if (sameBounds(sourceBounds, target.getBounds())) return;
    pair.syncingBounds = true;
    try {
      target.setBounds(sourceBounds, false);
    } finally {
      pair.syncingBounds = false;
    }
  }

  /** macOS 控制层缩放时更新父窗口，并消除父窗口位移带来的子窗口偏移。 */
  private syncMacControlResize(pair: DesktopPlayerWindowPair): void {
    const { controlWindow, videoWindow } = pair;
    if (pair.syncingBounds || pair.cleanupStarted || controlWindow.isDestroyed() || videoWindow.isDestroyed()) return;
    const controlBounds = controlWindow.getBounds();
    if (sameBounds(controlBounds, videoWindow.getBounds())) return;
    pair.syncingBounds = true;
    try {
      videoWindow.setBounds(controlBounds, false);
      if (!sameBounds(controlBounds, controlWindow.getBounds())) {
        controlWindow.setBounds(controlBounds, false);
      }
    } finally {
      pair.syncingBounds = false;
    }
  }

  private syncWindowState(
    pair: DesktopPlayerWindowPair,
    source: DesktopPlayerBrowserWindow,
    target: DesktopPlayerBrowserWindow,
    event: "minimize" | "restore" | "maximize" | "unmaximize"
  ): void {
    if (pair.syncingState || pair.cleanupStarted || source.isDestroyed() || target.isDestroyed()) return;
    this.withStateSync(pair, () => {
      if (event === "minimize" && !target.isMinimized()) target.minimize();
      if (event === "restore" && target.isMinimized()) target.restore();
      if (event === "maximize" && !target.isMaximized()) target.maximize();
      if (event === "unmaximize" && target.isMaximized()) target.unmaximize();
    });
  }

  private syncFullscreen(
    pair: DesktopPlayerWindowPair,
    source: DesktopPlayerBrowserWindow,
    target: DesktopPlayerBrowserWindow,
    fullscreen: boolean
  ): void {
    if (pair.syncingState || pair.cleanupStarted || source.isDestroyed() || target.isDestroyed()) return;
    if (target.isFullScreen() === fullscreen) return;
    this.withStateSync(pair, () => target.setFullScreen(fullscreen));
  }

  private withStateSync(pair: DesktopPlayerWindowPair, action: () => void): void {
    if (pair.syncingState || pair.cleanupStarted) return;
    pair.syncingState = true;
    try {
      action();
    } finally {
      pair.syncingState = false;
    }
  }

  /** 任一窗口关闭时同步关闭另一窗口，并且只回收一次媒体资源。 */
  private handleWindowClosed(pair: DesktopPlayerWindowPair, closedRole: "video" | "control"): void {
    if (pair.cleanupStarted) return;
    pair.cleanupStarted = true;
    this.pairs.delete(pair.ownerId);
    const peer = closedRole === "video" ? pair.controlWindow : pair.videoWindow;
    if (!peer.isDestroyed()) peer.close();
    void Promise.resolve(this.options.onWindowClosed?.(pair.ownerId)).catch((error: unknown) => {
      logger.warn("独立播放器关闭后资源回收失败", {
        ownerId: pair.ownerId,
        errorType: error instanceof Error ? error.name : typeof error
      });
    });
    logger.info("无边框 libVLC 播放器窗口已关闭", {
      ownerId: pair.ownerId,
      taskId: pair.taskId,
      closedRole
    });
  }

  private destroyPair(pair: DesktopPlayerWindowPair): void {
    if (!pair.controlWindow.isDestroyed()) pair.controlWindow.destroy();
    if (!pair.videoWindow.isDestroyed()) pair.videoWindow.destroy();
    if (!pair.cleanupStarted) this.handleWindowClosed(pair, "control");
  }

  private removeMenus(...windows: DesktopPlayerBrowserWindow[]): void {
    if (this.platform !== "win32") return;
    for (const window of windows) {
      window.setMenuBarVisibility(false);
      window.removeMenu();
    }
  }
}

function sameBounds(left: Rectangle, right: Rectangle): boolean {
  return left.x === right.x
    && left.y === right.y
    && left.width === right.width
    && left.height === right.height;
}

/** 拒绝来自 renderer 的异常坐标，避免无效值污染窗口边界。 */
function isValidDragInput(input: unknown): input is DesktopPlayerWindowDragInput {
  if (!input || typeof input !== "object" || !("phase" in input)) return false;
  const candidate = input as { phase?: unknown; screenX?: unknown; screenY?: unknown };
  if (candidate.phase === "end") return true;
  return (candidate.phase === "start" || candidate.phase === "move")
    && isFiniteScreenPoint(candidate);
}

/** 限制窗口拖动坐标为合理有限值。 */
function isFiniteScreenPoint(input: { screenX?: unknown; screenY?: unknown }): input is { screenX: number; screenY: number } {
  return typeof input.screenX === "number"
    && typeof input.screenY === "number"
    && Number.isFinite(input.screenX)
    && Number.isFinite(input.screenY)
    && Math.abs(input.screenX) <= 1_000_000
    && Math.abs(input.screenY) <= 1_000_000;
}
