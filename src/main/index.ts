import { app, BrowserWindow, dialog, Menu, safeStorage, webContents } from "electron";
import { join } from "node:path";
import { DailyReminderService } from "./core/automation/daily-reminder-service";
import { logger } from "./core/logger";
import { DesktopIntegrationService } from "./core/platform/desktop-integration-service";
import { AppearanceService } from "./core/platform/appearance-service";
import {
  automationScheduler,
  animeDetailService,
  downloadTaskControlService,
  embeddedTorrentCoreService,
  playbackCheckpointService,
  playbackStatusService,
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
import { DesktopPlaybackSessionService } from "./core/media/desktop-playback-session-service";
import { registerDesktopMediaProtocol, registerDesktopMediaScheme } from "./core/media/desktop-media-protocol";
import { DesktopPlayerWindowService } from "./core/media/desktop-player-window-service";
import { DesktopLibVlcPlayerService } from "./core/media/desktop-libvlc-player-service";

declare const __ANI_TRUSTED_ORIGINS__: string;

const APP_ID = "dev.ani.tracker";
const APP_ICON_PATH = join(__dirname, "../renderer/icons/ani-tracker-512.png");
const trustedOriginsFromEnvFile = typeof __ANI_TRUSTED_ORIGINS__ === "string"
  ? __ANI_TRUSTED_ORIGINS__
  : undefined;

let mainWindow: BrowserWindow | null = null;
let quitAfterManagedQbittorrentStops = false;
const appearanceService = new AppearanceService(() => mainWindow);
registerImageCacheScheme();
registerDesktopMediaScheme();
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
  listMyAnimeWatchProgress: () => repository.listMyAnimeWatchProgress(),
  setAnimeWatchProgress: (input) => repository.setAnimeWatchProgress(input),
  reportPlaybackProgress: (input) => playbackStatusService.handleTaskProgress(input),
  savePlaybackCheckpoint: (input) => playbackCheckpointService.save(input),
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
const desktopPlaybackSessionService = new DesktopPlaybackSessionService(remoteMediaSessionService);
let desktopPlayerWindowService: DesktopPlayerWindowService;
const desktopLibVlcPlayerService = new DesktopLibVlcPlayerService({
  resolveAsset: (requestUrl) => desktopPlaybackSessionService.resolveAsset(requestUrl),
  publishSnapshot: (ownerId, snapshot) => {
    const target = webContents.fromId(ownerId);
    if (target && !target.isDestroyed()) target.send("player:snapshot", snapshot);
  },
  setFullscreen: (ownerId, fullscreen) => desktopPlayerWindowService.setFullscreen(ownerId, fullscreen),
  closeWindow: (ownerId) => desktopPlayerWindowService.close(ownerId)
});
desktopPlayerWindowService = new DesktopPlayerWindowService({
  createWindow: (options) => new BrowserWindow(options),
  preloadPath: join(__dirname, "../preload/index.mjs"),
  rendererFilePath: join(__dirname, "../renderer/index.html"),
  rendererUrl: process.env.ELECTRON_RENDERER_URL,
  prepareVideoHost: (ownerId, window) => desktopLibVlcPlayerService.attach(ownerId, window),
  onWindowClosed: async (webContentsId) => {
    await Promise.all([
      desktopLibVlcPlayerService.dispose(webContentsId),
      desktopPlaybackSessionService.closeOwnerSessions(webContentsId)
    ]);
  }
});
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
  trustedOrigins: process.env.ANI_TRUSTED_ORIGINS ?? trustedOriginsFromEnvFile,
  tlsCertificateStore: new RemoteTlsCertificateStore(join(app.getPath("userData"), "remote-tls"), secretProtector)
});

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 720,
    minHeight: 560,
    title: "Ani Tracker",
    icon: APP_ICON_PATH,
    autoHideMenuBar: process.platform === "win32",
    frame: process.platform !== "win32",
    backgroundColor: appearanceService.getWindowBackgroundColor(),
    webPreferences: {
      preload: join(__dirname, "../preload/index.mjs"),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow = window;
  if (process.platform === "win32") {
    window.setMenuBarVisibility(false);
    window.removeMenu();
  }
  desktopIntegration.bindWindow(window);

  /** 向渲染进程同步主窗口最大化状态。 */
  const publishWindowState = () => {
    if (!window.isDestroyed()) {
      window.webContents.send("window:stateChanged", { maximized: window.isMaximized() });
    }
  };
  window.on("maximize", publishWindowState);
  window.on("unmaximize", publishWindowState);

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
    app.setAppUserModelId(APP_ID);
    Menu.setApplicationMenu(null);
  }

  await repositoryRuntime.initialize();
  registerImageCacheProtocol(imageCacheService);
  registerDesktopMediaProtocol(desktopPlaybackSessionService);
  registerIpcHandlers({
    remoteGateway,
    imageCacheService,
    desktopPlaybackSessionService,
    desktopPlayerWindowService,
    desktopPlayerControlService: desktopLibVlcPlayerService,
    getMainWindow: () => mainWindow,
    onSettingsUpdated: async (settings) => {
      imageCacheService.setCacheDirectory(join(settings.storage.cacheDir, "images"));
      appearanceService.applySettings(settings.appearance);
      await remoteGateway.applySettings(settings.network.remoteAccess);
      desktopIntegration.applySettings(settings);
      await qbittorrentManagedService.applySettings(settings);
      await embeddedTorrentCoreService.applySettings(settings).catch((error: unknown) => {
        logger.error("Embedded torrent core settings apply failed", {
          message: error instanceof Error ? error.message : String(error)
        });
      });
    }
  });
  const settings = await repository.getSettings();
  imageCacheService.setCacheDirectory(join(settings.storage.cacheDir, "images"));
  appearanceService.applySettings(settings.appearance);
  await remoteGateway.applySettings(settings.network.remoteAccess).catch((error: unknown) => remoteGateway.setStartupError(error));
  desktopIntegration.applySettings(settings);
  void qbittorrentManagedService.applySettings(settings);
  void embeddedTorrentCoreService.applySettings(settings).catch((error: unknown) => {
    logger.error("Embedded torrent core startup failed", {
      message: error instanceof Error ? error.message : String(error)
    });
  });
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
    await embeddedTorrentCoreService.stop();
  } catch (error) {
    logger.error("Embedded torrent core stop failed before quit", {
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
