import { app, BrowserWindow } from "electron";
import { join } from "node:path";
import { DailyReminderService } from "./core/automation/daily-reminder-service";
import { logger } from "./core/logger";
import { DesktopIntegrationService } from "./core/platform/desktop-integration-service";
import { automationScheduler, registerIpcHandlers, repository } from "./ipc";

let mainWindow: BrowserWindow | null = null;

const desktopIntegration = new DesktopIntegrationService({
  showMainWindow,
  runAutomation: () => automationScheduler.runNow({ trigger: "tray" }),
  quitApp: () => app.quit()
});
const dailyReminderService = new DailyReminderService(repository);

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 1024,
    minHeight: 700,
    title: "Ani Tracker",
    backgroundColor: "#f8fafc",
    webPreferences: {
      preload: join(__dirname, "../preload/index.mjs"),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow = window;
  desktopIntegration.bindWindow(window);

  if (!app.isPackaged) {
    window.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedUrl) => {
      console.error(`[renderer] failed to load ${validatedUrl}: ${errorCode} ${errorDescription}`);
    });
    window.webContents.on("render-process-gone", (_event, details) => {
      console.error(`[renderer] process gone: ${details.reason}`);
    });
  }

  if (process.env.ELECTRON_RENDERER_URL) {
    window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    window.loadFile(join(__dirname, "../renderer/index.html"));
  }

  window.on("closed", () => {
    if (mainWindow === window) {
      mainWindow = null;
    }
  });
}

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
  }

  if (!mainWindow) {
    return;
  }

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }

  mainWindow.show();
  mainWindow.focus();
}

app.whenReady().then(async () => {
  if (process.platform === "win32") {
    app.setAppUserModelId("AniTracker");
  }

  registerIpcHandlers({
    onSettingsUpdated: (settings) => desktopIntegration.applySettings(settings)
  });
  desktopIntegration.applySettings(await repository.getSettings());
  createWindow();
  void automationScheduler.start();
  void dailyReminderService.runOnce().catch((error: unknown) => {
    logger.error("Daily reminder failed", {
      message: error instanceof Error ? error.message : String(error)
    });
  });

  app.on("activate", () => {
    showMainWindow();
  });
});

app.on("before-quit", () => {
  desktopIntegration.prepareToQuit();
});

app.on("window-all-closed", () => {
  if (desktopIntegration.shouldKeepAppRunning()) {
    return;
  }

  if (process.platform !== "darwin") {
    app.quit();
  }
});
