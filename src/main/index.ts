import { app, BrowserWindow, dialog } from "electron";
import { join } from "node:path";
import { DailyReminderService } from "./core/automation/daily-reminder-service";
import { logger } from "./core/logger";
import { DesktopIntegrationService } from "./core/platform/desktop-integration-service";
import {
  automationScheduler,
  downloadTaskControlService,
  qbittorrentManagedService,
  registerIpcHandlers,
  repository,
  repositoryRuntime
} from "./ipc";
import { AnimeDiscoveryService } from "./core/metadata/anime-discovery-service";
import { createRemoteMethodRegistry } from "./core/remote/remote-method-registry";
import { RemoteHttpGateway } from "./core/remote/remote-http-gateway";

let mainWindow: BrowserWindow | null = null;
let quitAfterManagedQbittorrentStops = false;

const desktopIntegration = new DesktopIntegrationService({
  showMainWindow,
  runAutomation: () => automationScheduler.runNow({ trigger: "tray" }),
  quitApp: () => app.quit()
});
const dailyReminderService = new DailyReminderService(repository);
const remoteMethodRegistry = createRemoteMethodRegistry({
  getDashboard: () => repository.getDashboard(),
  listNotifications: () => repository.listNotifications(),
  getUnreadNotificationCount: () => repository.getUnreadNotificationCount(),
  markNotificationRead: (notificationId) => repository.markNotificationRead(notificationId),
  markAllNotificationsRead: () => repository.markAllNotificationsRead(),
  listMyAnime: () => repository.listMyAnime(),
  listAnimeCatalog: (year, month) => new AnimeDiscoveryService(repository).listCatalog(year, month),
  searchAnimeCatalog: (keyword) => new AnimeDiscoveryService(repository).searchCatalog(keyword),
  listFansubs: (animeId) => repository.listFansubs(animeId),
  listEpisodes: (animeId) => repository.listEpisodes(animeId),
  listEpisodePreferences: (animeId) => repository.listEpisodePreferences(animeId),
  listDownloads: () => repository.listDownloads(),
  refreshDownloads: () => downloadTaskControlService.refresh(),
  pauseDownload: (taskId) => downloadTaskControlService.pause(taskId),
  resumeDownload: (taskId) => downloadTaskControlService.resume(taskId)
});
const remoteGateway = new RemoteHttpGateway(remoteMethodRegistry, {
  rendererDirectory: join(__dirname, "../renderer")
});

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 720,
    minHeight: 560,
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

  await repositoryRuntime.initialize();
  registerIpcHandlers({
    remoteGateway,
    onSettingsUpdated: async (settings) => {
      desktopIntegration.applySettings(settings);
      await qbittorrentManagedService.applySettings(settings);
    }
  });
  const settings = await repository.getSettings();
  await remoteGateway.start().catch((error: unknown) => remoteGateway.setStartupError(error));
  desktopIntegration.applySettings(settings);
  void qbittorrentManagedService.applySettings(settings);
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
}).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  logger.error("Application startup failed", { message });
  dialog.showErrorBox("Ani Tracker 启动失败", `SQLite 数据库初始化失败：${message}`);
  app.quit();
});

app.on("before-quit", (event) => {
  desktopIntegration.prepareToQuit();
  if (quitAfterManagedQbittorrentStops) {
    return;
  }

  event.preventDefault();
  void stopManagedQbittorrentThenQuit();
});

app.on("window-all-closed", () => {
  if (desktopIntegration.shouldKeepAppRunning()) {
    return;
  }

  if (process.platform !== "darwin") {
    app.quit();
  }
});

async function stopManagedQbittorrentThenQuit(): Promise<void> {
  try {
    await remoteGateway.stop();
  } catch (error) {
    logger.error("Remote HTTP gateway stop failed before quit", {
      message: error instanceof Error ? error.message : String(error)
    });
  }
  try {
    await qbittorrentManagedService.stop();
  } catch (error) {
    logger.error("Managed qBittorrent stop failed before quit", {
      message: error instanceof Error ? error.message : String(error)
    });
  } finally {
    repositoryRuntime.close();
    quitAfterManagedQbittorrentStops = true;
    app.quit();
  }
}
