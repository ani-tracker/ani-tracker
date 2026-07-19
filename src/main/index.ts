import { app, BrowserWindow, dialog, safeStorage } from "electron";
import { join } from "node:path";
import { DailyReminderService } from "./core/automation/daily-reminder-service";
import { logger } from "./core/logger";
import { DesktopIntegrationService } from "./core/platform/desktop-integration-service";
import { AppearanceService } from "./core/platform/appearance-service";
import {
  automationScheduler,
  animeDetailService,
  downloadTaskControlService,
  qbittorrentManagedService,
  registerIpcHandlers,
  repository,
  repositoryRuntime,
  sourceSyncScheduler
} from "./ipc";
import { AnimeDiscoveryService } from "./core/metadata/anime-discovery-service";
import { createRemoteMethodRegistry } from "./core/remote/remote-method-registry";
import { RemoteDeviceAuth } from "./core/remote/remote-device-auth";
import { RemoteDeviceCredentialStore } from "./core/remote/remote-device-credential-store";
import { RemoteHttpGateway } from "./core/remote/remote-http-gateway";
import { RemoteMediaSessionService } from "./core/remote/remote-media-session-service";
import { resolveRemoteRendererDirectory } from "./core/remote/remote-renderer-directory";
import { RemoteTlsCertificateStore } from "./core/remote/remote-tls-certificate-store";
import { ImageCacheService } from "./core/cache/image-cache-service";
import { registerImageCacheProtocol, registerImageCacheScheme } from "./core/cache/image-cache-protocol";
import { MetadataHttpClient } from "./core/metadata/metadata-http-client";

let mainWindow: BrowserWindow | null = null;
let quitAfterManagedQbittorrentStops = false;
const appearanceService = new AppearanceService(() => mainWindow);
registerImageCacheScheme();
const imageCacheService = new ImageCacheService({
  cacheDirectory: join(app.getPath("userData"), "Cache", "images"),
  fetcher: async (input, options) => {
    const settings = await repository.getSettings();
    return new MetadataHttpClient(settings.network.metadataProxy).fetch(input, {
      ...options,
      source: "image-cache"
    });
  }
});

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
  getAnimeDetail: (animeId) => animeDetailService.getAnimeDetail(animeId),
  searchAnimeCatalog: (keyword) => new AnimeDiscoveryService(repository).searchCatalog(keyword),
  listFansubs: (animeId) => repository.listFansubs(animeId),
  listEpisodes: (animeId) => repository.listEpisodes(animeId),
  listEpisodePreferences: (animeId) => repository.listEpisodePreferences(animeId),
  listDownloads: () => repository.listDownloads(),
  refreshDownloads: () => downloadTaskControlService.refresh(),
  pauseDownload: (taskId) => downloadTaskControlService.pause(taskId),
  resumeDownload: (taskId) => downloadTaskControlService.resume(taskId)
});
const remoteMediaSessionService = new RemoteMediaSessionService(repository);
const secretProtector = {
  isAvailable: () => safeStorage.isEncryptionAvailable(),
  encryptString: (value: string) => safeStorage.encryptString(value),
  decryptString: (value: Buffer) => safeStorage.decryptString(value)
};
const remoteDeviceAuth = new RemoteDeviceAuth({
  credentialStore: new RemoteDeviceCredentialStore(join(app.getPath("userData"), "remote-auth"), secretProtector)
});
const remoteGateway = new RemoteHttpGateway(remoteMethodRegistry, {
  auth: remoteDeviceAuth,
  rendererDirectory: resolveRemoteRendererDirectory({
    appPath: app.getAppPath(),
    bundleDirectory: __dirname,
    rendererDevServerUrl: process.env.ELECTRON_RENDERER_URL
  }),
  imageCacheService,
  mediaSessionService: remoteMediaSessionService,
  tlsCertificateStore: new RemoteTlsCertificateStore(join(app.getPath("userData"), "remote-tls"), secretProtector)
});

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 720,
    minHeight: 560,
    title: "Ani Tracker",
    backgroundColor: appearanceService.getWindowBackgroundColor(),
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
  registerImageCacheProtocol(imageCacheService);
  registerIpcHandlers({
    remoteGateway,
    imageCacheService,
    onSettingsUpdated: async (settings) => {
      imageCacheService.setCacheDirectory(join(settings.storage.cacheDir, "images"));
      appearanceService.applySettings(settings.appearance);
      await remoteGateway.applySettings(settings.network.remoteAccess);
      desktopIntegration.applySettings(settings);
      await qbittorrentManagedService.applySettings(settings);
    }
  });
  const settings = await repository.getSettings();
  imageCacheService.setCacheDirectory(join(settings.storage.cacheDir, "images"));
  appearanceService.applySettings(settings.appearance);
  await remoteGateway.applySettings(settings.network.remoteAccess).catch((error: unknown) => remoteGateway.setStartupError(error));
  desktopIntegration.applySettings(settings);
  void qbittorrentManagedService.applySettings(settings);
  createWindow();
  void automationScheduler.start();
  void sourceSyncScheduler.start();
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

app.on("will-quit", () => {
  sourceSyncScheduler.stop();
  appearanceService.dispose();
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
