import { app, BrowserWindow, Menu, nativeImage, Tray, type NativeImage } from "electron";
import { join } from "node:path";
import type { AppSettings } from "@shared/domain";
import { logger } from "../logger";

interface DesktopIntegrationActions {
  showMainWindow: () => void;
  runAutomation: () => Promise<unknown>;
  quitApp: () => void;
}

const DEFAULT_DESKTOP_SETTINGS = {
  minimizeToTray: true,
  launchAtLogin: false
};

export class DesktopIntegrationService {
  private settings: AppSettings["desktop"] = DEFAULT_DESKTOP_SETTINGS;
  private tray: Tray | null = null;
  private window: BrowserWindow | null = null;
  private isQuitting = false;
  private hasAppliedLaunchAtLogin = false;

  constructor(private readonly actions: DesktopIntegrationActions) {}

  bindWindow(window: BrowserWindow): void {
    this.window = window;

    window.on("close", (event) => {
      if (!this.shouldHideWindowOnClose()) {
        return;
      }

      // Keep scheduled scans and tray actions alive when the user closes the main window.
      event.preventDefault();
      window.hide();
      logger.info("Main window hidden to tray");
    });

    window.on("closed", () => {
      if (this.window === window) {
        this.window = null;
      }
    });
  }

  applySettings(settings: AppSettings): void {
    const previous = this.settings;
    this.settings = settings.desktop ?? DEFAULT_DESKTOP_SETTINGS;

    this.configureTray(this.settings.minimizeToTray);

    if (!this.hasAppliedLaunchAtLogin || previous.launchAtLogin !== this.settings.launchAtLogin) {
      this.applyLaunchAtLogin(this.settings.launchAtLogin);
      this.hasAppliedLaunchAtLogin = true;
    }
  }

  prepareToQuit(): void {
    this.isQuitting = true;
  }

  shouldKeepAppRunning(): boolean {
    return Boolean(this.settings.minimizeToTray && this.tray && !this.isQuitting);
  }

  private shouldHideWindowOnClose(): boolean {
    return Boolean(this.settings.minimizeToTray && this.tray && !this.isQuitting);
  }

  private configureTray(enabled: boolean): void {
    if (!enabled) {
      if (this.tray) {
        this.tray.destroy();
        this.tray = null;
        logger.info("Tray integration disabled");
      }
      return;
    }

    if (!this.tray) {
      const icon = createTrayIcon();
      if (icon.isEmpty()) {
        logger.warn("Tray icon is empty; tray integration skipped");
        return;
      }

      this.tray = new Tray(icon);
      this.tray.setToolTip("Ani Tracker");
      this.tray.on("click", () => this.actions.showMainWindow());
      logger.info("Tray integration initialized");
    }

    this.tray.setContextMenu(this.createTrayMenu());
  }

  private createTrayMenu(): Menu {
    return Menu.buildFromTemplate([
      {
        label: "显示主窗口",
        click: () => this.actions.showMainWindow()
      },
      {
        label: "扫描更新",
        click: () => this.runAutomationFromTray()
      },
      {
        type: "separator"
      },
      {
        label: "退出",
        click: () => {
          logger.info("Application quit requested from tray");
          this.prepareToQuit();
          this.actions.quitApp();
        }
      }
    ]);
  }

  private runAutomationFromTray(): void {
    logger.info("Automation scan requested from tray");
    void this.actions.runAutomation().catch((error: unknown) => {
      logger.error("Automation scan from tray failed", {
        message: getErrorMessage(error)
      });
    });
  }

  private applyLaunchAtLogin(enabled: boolean): void {
    if (process.platform !== "win32" && process.platform !== "darwin") {
      if (enabled) {
        logger.warn("Launch at login is not supported on this platform yet", {
          platform: process.platform
        });
      }
      return;
    }

    try {
      app.setLoginItemSettings({
        openAtLogin: enabled
      });
      logger.info("Launch-at-login setting applied", {
        enabled,
        platform: process.platform,
        packaged: app.isPackaged
      });
    } catch (error) {
      logger.error("Failed to apply launch-at-login setting", {
        message: getErrorMessage(error)
      });
    }
  }
}

/** 从应用资源加载跨平台托盘图标，缺失时返回空图像并跳过托盘初始化。 */
function createTrayIcon(): NativeImage {
  const fileCandidates = [
    join(__dirname, "../renderer/icons/ani-tracker-192.png"),
    join(app.getAppPath(), "out/renderer/icons/ani-tracker-192.png"),
    join(app.getAppPath(), "src/renderer/public/icons/ani-tracker-192.png")
  ];
  for (const [index, candidate] of fileCandidates.entries()) {
    const fileImage = nativeImage.createFromPath(candidate);
    if (!fileImage.isEmpty()) {
      return resizeTrayIcon(fileImage);
    }
    logger.warn("Tray icon file candidate is empty", { candidateIndex: index });
  }

  logger.error("Tray icon files are unavailable");
  return nativeImage.createEmpty();
}

/** 按平台生成托盘所需尺寸，并为 macOS 标记模板图像。 */
function resizeTrayIcon(image: NativeImage): NativeImage {
  if (process.platform === "darwin") {
    image.setTemplateImage(true);
  }

  return image.resize({ width: 16, height: 16 });
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
