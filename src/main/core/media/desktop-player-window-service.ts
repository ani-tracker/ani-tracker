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

interface PlayerWindowCloseEvent {
  preventDefault(): void;
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
  on(event: "close", listener: (event: PlayerWindowCloseEvent) => void): void;
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
  setSimpleFullScreen(fullscreen: boolean): void;
  isSimpleFullScreen(): boolean;
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
  allowWindowClose: boolean;
  requestedFullscreen: boolean;
  appliedFullscreen: boolean;
  windowedBounds: Rectangle;
  fullscreenTask?: Promise<boolean>;
  closeTask?: Promise<void>;
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
  onFullscreenChanged?: (webContentsId: number, fullscreen: boolean) => void | Promise<void>;
  onWindowClosing?: (webContentsId: number) => void | Promise<void>;
  platform?: NodeJS.Platform;
  fullscreenTransitionTimeoutMs?: number;
  fullscreenSettleDelayMs?: number;
  cleanupTimeoutMs?: number;
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
      cleanupStarted: false,
      allowWindowClose: false,
      requestedFullscreen: false,
      appliedFullscreen: false,
      windowedBounds: videoWindow.getBounds()
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
      await this.closePair(pair, "load-failure");
      logger.error("无边框 libVLC 播放器窗口加载失败", {
        ownerId,
        taskId: input.taskId,
        errorType: error instanceof Error ? error.name : typeof error
      });
      throw error;
    }
  }

  /** 关闭调用方所属的一整组播放器窗口。 */
  async close(ownerId: number): Promise<boolean> {
    const pair = this.pairs.get(ownerId);
    if (!pair) return false;
    await this.closePair(pair, "request");
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
      if (this.isFullscreenActive(pair) || pair.videoWindow.isMaximized()) return false;
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
    if (!dragState || this.isFullscreenActive(pair) || pair.videoWindow.isMaximized()) return false;
    const bounds = pair.videoWindow.getBounds();
    const nextBounds = {
      ...bounds,
      x: Math.round(dragState.windowStartX + input.screenX - dragState.pointerStartX),
      y: Math.round(dragState.windowStartY + input.screenY - dragState.pointerStartY)
    };
    if (nextBounds.x !== bounds.x || nextBounds.y !== bounds.y) {
      pair.videoWindow.setBounds(nextBounds, false);
      pair.windowedBounds = { ...nextBounds };
    }
    return true;
  }

  /** 仅切换视频宿主全屏，透明控制层通过边界同步跟随。 */
  async setFullscreen(ownerId: number, fullscreen: boolean): Promise<boolean> {
    const pair = this.pairs.get(ownerId);
    if (!pair || pair.cleanupStarted) return false;
    pair.dragState = undefined;
    pair.requestedFullscreen = fullscreen;
    if (!pair.fullscreenTask) {
      const trackedTask = this.drainFullscreenRequests(pair).finally(() => {
        if (pair.fullscreenTask === trackedTask) pair.fullscreenTask = undefined;
      });
      pair.fullscreenTask = trackedTask;
    }
    return pair.fullscreenTask;
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
      videoWindow.on("move", () => this.handleVideoWindowGeometryChanged(pair));
      videoWindow.on("resize", () => this.handleVideoWindowGeometryChanged(pair));
    } else {
      controlWindow.on("move", () => this.handleControlWindowGeometryChanged(pair));
      controlWindow.on("resize", () => this.handleControlWindowGeometryChanged(pair));
      videoWindow.on("move", () => this.handleVideoWindowGeometryChanged(pair));
      videoWindow.on("resize", () => this.handleVideoWindowGeometryChanged(pair));
    }
    for (const event of ["minimize", "restore", "maximize", "unmaximize"] as const) {
      controlWindow.on(event, () => this.syncWindowState(pair, controlWindow, videoWindow, event));
      videoWindow.on(event, () => this.syncWindowState(pair, videoWindow, controlWindow, event));
    }
    videoWindow.on("enter-full-screen", () => this.syncBounds(pair, videoWindow, controlWindow));
    videoWindow.on("leave-full-screen", () => this.syncBounds(pair, videoWindow, controlWindow));
    videoWindow.on("focus", () => {
      if (!pair.cleanupStarted && !controlWindow.isDestroyed()) controlWindow.focus();
    });
    controlWindow.on("close", (event) => this.handleWindowCloseRequested(pair, event, "control"));
    videoWindow.on("close", (event) => this.handleWindowCloseRequested(pair, event, "video"));
    controlWindow.on("closed", () => this.handleWindowClosedUnexpectedly(pair, "control"));
    videoWindow.on("closed", () => this.handleWindowClosedUnexpectedly(pair, "video"));
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

  /** 视频宿主是全屏和全屏期间几何变化的唯一状态源。 */
  private handleVideoWindowGeometryChanged(pair: DesktopPlayerWindowPair): void {
    const { videoWindow, controlWindow } = pair;
    if (pair.cleanupStarted || videoWindow.isDestroyed() || controlWindow.isDestroyed()) return;
    if (!this.isFullscreenActive(pair)) pair.windowedBounds = videoWindow.getBounds();
    this.syncBounds(pair, videoWindow, controlWindow);
  }

  /** 窗口态允许控制层驱动尺寸；全屏态禁止反向覆盖视频宿主。 */
  private handleControlWindowGeometryChanged(pair: DesktopPlayerWindowPair): void {
    if (this.isFullscreenActive(pair)) return;
    this.syncBounds(pair, pair.controlWindow, pair.videoWindow);
    if (!pair.videoWindow.isDestroyed()) pair.windowedBounds = pair.videoWindow.getBounds();
  }

  /** macOS 控制层缩放时更新父窗口，并消除父窗口位移带来的子窗口偏移。 */
  private syncMacControlResize(pair: DesktopPlayerWindowPair): void {
    const { controlWindow, videoWindow } = pair;
    if (
      pair.syncingBounds
      || pair.cleanupStarted
      || this.isFullscreenActive(pair)
      || controlWindow.isDestroyed()
      || videoWindow.isDestroyed()
    ) return;
    const controlBounds = controlWindow.getBounds();
    if (sameBounds(controlBounds, videoWindow.getBounds())) return;
    pair.syncingBounds = true;
    try {
      videoWindow.setBounds(controlBounds, false);
      if (!sameBounds(controlBounds, controlWindow.getBounds())) {
        controlWindow.setBounds(controlBounds, false);
      }
      pair.windowedBounds = { ...controlBounds };
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

  /** 串行处理全屏请求，避免快速连续点击触发平台窗口状态竞争。 */
  private async drainFullscreenRequests(pair: DesktopPlayerWindowPair): Promise<boolean> {
    while (!pair.cleanupStarted && (
      pair.appliedFullscreen !== pair.requestedFullscreen
      || this.isVideoWindowFullscreen(pair) !== pair.requestedFullscreen
    )) {
      const target = pair.requestedFullscreen;
      if (target && !pair.appliedFullscreen && !this.isVideoWindowFullscreen(pair)) {
        pair.windowedBounds = pair.videoWindow.getBounds();
      }
      this.applyVideoWindowFullscreen(pair, target);
      const reachedTarget = await waitForCondition(
        () => pair.cleanupStarted || this.isVideoWindowFullscreen(pair) === target,
        this.options.fullscreenTransitionTimeoutMs ?? 2_000
      );
      if (pair.cleanupStarted) return false;
      if (!reachedTarget) {
        pair.appliedFullscreen = this.isVideoWindowFullscreen(pair);
        pair.requestedFullscreen = pair.appliedFullscreen;
        logger.warn("独立播放器全屏切换超时", {
          ownerId: pair.ownerId,
          taskId: pair.taskId,
          platform: this.platform,
          requestedFullscreen: target
        });
        break;
      }

      await delay(this.options.fullscreenSettleDelayMs ?? 80);
      if (pair.cleanupStarted) return false;
      pair.appliedFullscreen = target;
      this.restoreAndSyncFullscreenBounds(pair, target);
      await this.notifyFullscreenChanged(pair, target);
      if (!pair.controlWindow.isDestroyed()) {
        pair.controlWindow.show();
        pair.controlWindow.focus();
      }
      logger.info("独立播放器全屏状态已切换", {
        ownerId: pair.ownerId,
        taskId: pair.taskId,
        platform: this.platform,
        fullscreen: target
      });
    }
    return pair.appliedFullscreen;
  }

  /** macOS 使用简单全屏，其余平台使用视频宿主的系统全屏。 */
  private applyVideoWindowFullscreen(pair: DesktopPlayerWindowPair, fullscreen: boolean): void {
    if (pair.videoWindow.isDestroyed()) return;
    if (this.platform === "darwin") pair.videoWindow.setSimpleFullScreen(fullscreen);
    else pair.videoWindow.setFullScreen(fullscreen);
  }

  /** 退出全屏后恢复进入前边界，并始终让控制层覆盖视频宿主。 */
  private restoreAndSyncFullscreenBounds(pair: DesktopPlayerWindowPair, fullscreen: boolean): void {
    const { videoWindow, controlWindow } = pair;
    if (videoWindow.isDestroyed() || controlWindow.isDestroyed()) return;
    if (!fullscreen && !sameBounds(videoWindow.getBounds(), pair.windowedBounds)) {
      videoWindow.setBounds(pair.windowedBounds, false);
    }
    this.syncBounds(pair, videoWindow, controlWindow);
  }

  /** 通知原生视频子窗口重新测量宿主布局，避免退出全屏后黑屏。 */
  private async notifyFullscreenChanged(pair: DesktopPlayerWindowPair, fullscreen: boolean): Promise<void> {
    try {
      await this.options.onFullscreenChanged?.(pair.ownerId, fullscreen);
    } catch (error) {
      logger.warn("独立播放器原生视频布局刷新失败", {
        ownerId: pair.ownerId,
        taskId: pair.taskId,
        errorType: error instanceof Error ? error.name : typeof error
      });
    }
  }

  /** 返回视频宿主在当前平台使用的真实全屏状态。 */
  private isVideoWindowFullscreen(pair: DesktopPlayerWindowPair): boolean {
    if (pair.videoWindow.isDestroyed()) return false;
    return this.platform === "darwin"
      ? pair.videoWindow.isSimpleFullScreen()
      : pair.videoWindow.isFullScreen();
  }

  /** 判断窗口是否处于或正在进入全屏，阻止控制层反向改写边界。 */
  private isFullscreenActive(pair: DesktopPlayerWindowPair): boolean {
    return pair.requestedFullscreen || pair.appliedFullscreen || this.isVideoWindowFullscreen(pair);
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

  /** 拦截系统关闭，统一进入先释放原生资源的异步关闭流程。 */
  private handleWindowCloseRequested(
    pair: DesktopPlayerWindowPair,
    event: PlayerWindowCloseEvent,
    closedRole: "video" | "control"
  ): void {
    if (pair.allowWindowClose) return;
    event.preventDefault();
    if (!pair.cleanupStarted) void this.closePair(pair, closedRole);
  }

  /** 处理窗口被外部强制销毁的兜底路径，确保另一个窗口仍被回收。 */
  private handleWindowClosedUnexpectedly(pair: DesktopPlayerWindowPair, closedRole: "video" | "control"): void {
    if (pair.allowWindowClose || pair.cleanupStarted) return;
    logger.warn("独立播放器窗口意外关闭", {
      ownerId: pair.ownerId,
      taskId: pair.taskId,
      closedRole
    });
    void this.closePair(pair, closedRole);
  }

  /** 幂等执行退出全屏、资源释放和双窗口销毁。 */
  private closePair(pair: DesktopPlayerWindowPair, source: string): Promise<void> {
    pair.closeTask ??= this.performClose(pair, source);
    return pair.closeTask;
  }

  /** 按固定顺序关闭播放器，避免 libVLC 持有已销毁的宿主窗口。 */
  private async performClose(pair: DesktopPlayerWindowPair, source: string): Promise<void> {
    pair.cleanupStarted = true;
    pair.dragState = undefined;
    pair.requestedFullscreen = false;

    if (this.isVideoWindowFullscreen(pair)) {
      this.applyVideoWindowFullscreen(pair, false);
      await waitForCondition(
        () => pair.videoWindow.isDestroyed() || !this.isVideoWindowFullscreen(pair),
        Math.min(this.options.fullscreenTransitionTimeoutMs ?? 2_000, 500)
      );
    }

    await this.runWindowClosingHook(pair);
    pair.allowWindowClose = true;
    this.pairs.delete(pair.ownerId);
    if (!pair.controlWindow.isDestroyed()) pair.controlWindow.destroy();
    if (!pair.videoWindow.isDestroyed()) pair.videoWindow.destroy();
    logger.info("无边框 libVLC 播放器窗口已关闭", {
      ownerId: pair.ownerId,
      taskId: pair.taskId,
      source
    });
  }

  /** 等待播放器和会话释放；超时后继续销毁窗口并记录诊断信息。 */
  private async runWindowClosingHook(pair: DesktopPlayerWindowPair): Promise<void> {
    if (!this.options.onWindowClosing) return;
    const cleanup = Promise.resolve()
      .then(() => this.options.onWindowClosing?.(pair.ownerId))
      .then(() => true)
      .catch((error: unknown) => {
        logger.warn("独立播放器关闭前资源回收失败", {
          ownerId: pair.ownerId,
          taskId: pair.taskId,
          errorType: error instanceof Error ? error.name : typeof error
        });
        return true;
      });
    const completed = await resolvesWithin(cleanup, this.options.cleanupTimeoutMs ?? 3_000);
    if (!completed) {
      logger.warn("独立播放器关闭前资源回收超时", {
        ownerId: pair.ownerId,
        taskId: pair.taskId
      });
    }
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

/** 在限定时间内轮询 Electron 的异步窗口状态。 */
async function waitForCondition(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  if (condition()) return true;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    await delay(Math.min(16, timeoutMs));
    if (condition()) return true;
  }
  return condition();
}

/** 提供不会阻塞事件循环的短暂窗口状态稳定期。 */
function delay(milliseconds: number): Promise<void> {
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** 判断异步清理是否在截止时间内结束，并清除计时器。 */
function resolvesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), Math.max(0, timeoutMs));
    void promise.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
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
