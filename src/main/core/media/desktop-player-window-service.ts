import type { BrowserWindowConstructorOptions } from "electron";
import type { DesktopPlayerWindowInput } from "@shared/contracts";
import { createDesktopPlayerSearchParams } from "@shared/desktop-player-route";
import { logger } from "../logger";

interface PlayerWindowWebContents {
  id: number;
  on(event: "did-fail-load", listener: (...args: unknown[]) => void): void;
  on(event: "render-process-gone", listener: (...args: unknown[]) => void): void;
}

export interface DesktopPlayerBrowserWindow {
  webContents: PlayerWindowWebContents;
  loadURL(url: string): Promise<void>;
  loadFile(filePath: string, options?: { query?: Record<string, string> }): Promise<void>;
  on(event: "closed", listener: () => void): void;
  isDestroyed(): boolean;
  show(): void;
  focus(): void;
  close(): void;
  destroy(): void;
  setMenuBarVisibility(visible: boolean): void;
  removeMenu(): void;
}

export interface DesktopPlayerWindowServiceOptions {
  createWindow: (options: BrowserWindowConstructorOptions) => DesktopPlayerBrowserWindow;
  preloadPath: string;
  rendererFilePath: string;
  rendererUrl?: string;
  getBackgroundColor: () => string;
  onWindowClosed?: (webContentsId: number) => void | Promise<void>;
  platform?: NodeJS.Platform;
}

/** 创建并管理与主界面生命周期解耦的播放器窗口。 */
export class DesktopPlayerWindowService {
  private readonly windows = new Map<number, DesktopPlayerBrowserWindow>();
  private readonly platform: NodeJS.Platform;

  constructor(private readonly options: DesktopPlayerWindowServiceOptions) {
    this.platform = options.platform ?? process.platform;
  }

  /** 每次播放请求创建一个独立窗口并加载专用播放器入口。 */
  async open(input: DesktopPlayerWindowInput): Promise<void> {
    const searchParams = createDesktopPlayerSearchParams(input);
    const playerWindow = this.options.createWindow({
      width: 1280,
      height: 800,
      minWidth: 800,
      minHeight: 520,
      title: "Ani Tracker 播放器",
      show: false,
      frame: true,
      autoHideMenuBar: true,
      backgroundColor: this.options.getBackgroundColor(),
      webPreferences: {
        preload: this.options.preloadPath,
        sandbox: false,
        contextIsolation: true,
        nodeIntegration: false
      }
    });
    const webContentsId = playerWindow.webContents.id;
    this.windows.set(webContentsId, playerWindow);
    this.bindWindowLifecycle(playerWindow, input);

    if (this.platform === "win32") {
      playerWindow.setMenuBarVisibility(false);
      playerWindow.removeMenu();
    }

    try {
      if (this.options.rendererUrl) {
        const targetUrl = new URL(this.options.rendererUrl);
        targetUrl.search = searchParams.toString();
        await playerWindow.loadURL(targetUrl.toString());
      } else {
        await playerWindow.loadFile(this.options.rendererFilePath, {
          query: Object.fromEntries(searchParams.entries())
        });
      }
      if (!playerWindow.isDestroyed()) {
        playerWindow.show();
        playerWindow.focus();
      }
      logger.info("独立内置播放器窗口已打开", {
        webContentsId,
        taskId: input.taskId,
        fileIndex: input.fileIndex
      });
    } catch (error) {
      if (!playerWindow.isDestroyed()) {
        playerWindow.destroy();
      }
      logger.error("独立内置播放器窗口加载失败", {
        webContentsId,
        taskId: input.taskId,
        errorType: error instanceof Error ? error.name : typeof error
      });
      throw error;
    }
  }

  /** 仅关闭调用方所属的播放器窗口。 */
  close(webContentsId: number): boolean {
    const playerWindow = this.windows.get(webContentsId);
    if (!playerWindow || playerWindow.isDestroyed()) {
      return false;
    }
    playerWindow.close();
    return true;
  }

  /** 绑定窗口异常日志和关闭后的媒体资源回收。 */
  private bindWindowLifecycle(
    playerWindow: DesktopPlayerBrowserWindow,
    input: DesktopPlayerWindowInput
  ): void {
    const webContentsId = playerWindow.webContents.id;
    playerWindow.webContents.on("did-fail-load", (...args) => {
      logger.error("独立内置播放器页面加载失败", {
        webContentsId,
        taskId: input.taskId,
        errorCode: args[1],
        errorDescription: args[2]
      });
    });
    playerWindow.webContents.on("render-process-gone", (...args) => {
      logger.error("独立内置播放器渲染进程退出", {
        webContentsId,
        taskId: input.taskId,
        details: args[1]
      });
    });
    playerWindow.on("closed", () => {
      this.windows.delete(webContentsId);
      void Promise.resolve(this.options.onWindowClosed?.(webContentsId)).catch((error: unknown) => {
        logger.warn("独立内置播放器关闭后资源回收失败", {
          webContentsId,
          errorType: error instanceof Error ? error.name : typeof error
        });
      });
      logger.info("独立内置播放器窗口已关闭", { webContentsId, taskId: input.taskId });
    });
  }
}
