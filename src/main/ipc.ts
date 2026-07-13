import { ipcMain, shell } from "electron";
import type { AppSettings, Episode, EpisodePreference, MyAnime, ReleaseSourceConfig } from "@shared/domain";
import { AppRepository } from "./core/repositories/app-repository";
import { AppDataStore } from "./core/storage/app-data-store";
import { QbittorrentEngine } from "./core/downloads/qbittorrent-engine";
import { ReleaseSourceService } from "./core/sources/release-source-service";
import type { AddDownloadUrlInput, AddReleaseDownloadInput, AnimeDiscoveryQuery, ReleaseQuery } from "@shared/contracts";
import { createTorrentEngine } from "./core/downloads/torrent-engine-factory";
import { PlayerLauncherService } from "./core/platform/player-launcher";
import { DownloadMediaScanner } from "./core/media/download-media-scanner";
import { FfprobeMediaProbeService } from "./core/media/ffprobe-media-probe-service";
import { CompletedDownloadMediaAutoScanner } from "./core/media/completed-download-media-auto-scanner";
import { EpisodeReleasePreviewService } from "./core/automation/episode-release-preview-service";
import { AutomationScheduler } from "./core/automation/automation-scheduler";
import { AnimeDiscoveryService } from "./core/metadata/anime-discovery-service";
import { QbittorrentManagedService } from "./core/downloads/qbittorrent-managed-service";
import { logger } from "./core/logger";

export const repository = new AppRepository(new AppDataStore());
export const qbittorrentManagedService = new QbittorrentManagedService();
export const automationScheduler = new AutomationScheduler(repository, undefined, {
  getQbittorrentBaseUrl: (settings) => qbittorrentManagedService.getRuntimeBaseUrl(settings)
});
const completedDownloadMediaAutoScanner = new CompletedDownloadMediaAutoScanner(repository);

interface RegisterIpcHandlersOptions {
  onSettingsUpdated?: (settings: AppSettings) => void | Promise<void>;
}

export function registerIpcHandlers(options: RegisterIpcHandlersOptions = {}): void {
  ipcMain.handle("dashboard:get", () => repository.getDashboard());
  ipcMain.handle("notifications:list", () => repository.listNotifications());
  ipcMain.handle("notifications:unreadCount", () => repository.getUnreadNotificationCount());
  ipcMain.handle("notifications:markRead", (_event, notificationId: string) =>
    repository.markNotificationRead(notificationId)
  );
  ipcMain.handle("notifications:markAllRead", () => repository.markAllNotificationsRead());
  ipcMain.handle("notifications:clear", () => repository.clearNotifications());
  ipcMain.handle("myAnime:list", () => repository.listMyAnime());
  ipcMain.handle("myAnime:upsert", (_event, item: MyAnime) => repository.upsertMyAnime(item));
  ipcMain.handle("myAnime:remove", (_event, itemId: string) => repository.removeMyAnime(itemId));
  ipcMain.handle("animeCatalog:list", (_event, year?: number, month?: number) =>
    new AnimeDiscoveryService(repository).listCatalog(year, month)
  );
  ipcMain.handle("animeCatalog:search", (_event, keyword: string) =>
    new AnimeDiscoveryService(repository).searchCatalog(keyword)
  );
  ipcMain.handle("animeCatalog:collectMonth", (_event, query: AnimeDiscoveryQuery) =>
    new AnimeDiscoveryService(repository).collectMonth(query)
  );
  ipcMain.handle("episodes:list", (_event, animeId: string) => repository.listEpisodes(animeId));
  ipcMain.handle("episodes:upsert", (_event, episode: Episode) => repository.upsertEpisode(episode));
  ipcMain.handle("episodePreferences:list", (_event, animeId: string) => repository.listEpisodePreferences(animeId));
  ipcMain.handle("episodePreferences:upsert", (_event, preference: EpisodePreference) =>
    repository.upsertEpisodePreference(preference)
  );
  ipcMain.handle("episodePreferences:remove", (_event, episodeId: string) =>
    repository.removeEpisodePreference(episodeId)
  );
  ipcMain.handle("automation:previewEpisodeReleases", (_event, animeId: string, episodeId: string) =>
    new EpisodeReleasePreviewService(repository).preview(animeId, episodeId)
  );
  ipcMain.handle("automation:runOnce", () => automationScheduler.runNow({ trigger: "manual" }));
  ipcMain.handle("automation:getSchedulerStatus", () => automationScheduler.getStatus());
  ipcMain.handle("automation:restartScheduler", () => automationScheduler.restart());
  ipcMain.handle("downloads:list", () => repository.listDownloads());
  ipcMain.handle("downloads:refresh", async () => {
    const settings = await repository.getSettings();
    const engine = createTorrentEngine(settings, {
      qbittorrentBaseUrl: qbittorrentManagedService.getRuntimeBaseUrl(settings)
    });
    const tasks = await engine.listTasks();
    const merged = await repository.mergeDownloadTasksFromEngine(tasks);
    // Keep progress refresh responsive; completed media probing can take seconds per file.
    void completedDownloadMediaAutoScanner.scanCompletedTasks(merged);
    return merged;
  });
  ipcMain.handle("downloads:pause", async (_event, taskId: string) => {
    const task = await repository.getDownloadTask(taskId);
    if (!task) {
      throw new Error("下载任务不存在");
    }

    if (task.engine === "qbittorrent") {
      const settings = await repository.getSettings();
      const engine = new QbittorrentEngine({
        baseUrl: qbittorrentManagedService.getRuntimeBaseUrl(settings),
        username: settings.download.qbittorrent.username,
        password: settings.download.qbittorrent.password
      });
      await engine.pause(task.torrentHash ?? task.id);
    }

    return repository.updateDownloadStatus(task.id, "paused");
  });
  ipcMain.handle("downloads:resume", async (_event, taskId: string) => {
    const task = await repository.getDownloadTask(taskId);
    if (!task) {
      throw new Error("下载任务不存在");
    }

    if (task.engine === "qbittorrent") {
      const settings = await repository.getSettings();
      const engine = new QbittorrentEngine({
        baseUrl: qbittorrentManagedService.getRuntimeBaseUrl(settings),
        username: settings.download.qbittorrent.username,
        password: settings.download.qbittorrent.password
      });
      await engine.resume(task.torrentHash ?? task.id);
    }

    return repository.updateDownloadStatus(task.id, "downloading");
  });
  ipcMain.handle("downloads:remove", async (_event, taskId: string, deleteFiles: boolean) => {
    const task = await repository.getDownloadTask(taskId);
    if (!task) {
      return repository.listDownloads();
    }

    if (task.engine === "qbittorrent") {
      const settings = await repository.getSettings();
      const engine = new QbittorrentEngine({
        baseUrl: qbittorrentManagedService.getRuntimeBaseUrl(settings),
        username: settings.download.qbittorrent.username,
        password: settings.download.qbittorrent.password
      });
      await engine.remove(task.torrentHash ?? task.id, deleteFiles);
    }

    return repository.removeDownloadTask(task.id);
  });
  ipcMain.handle("downloads:setFilePriority", async (_event, taskId: string, fileIndexes: number[], priority: number) => {
    const task = await repository.getDownloadTask(taskId);
    if (!task) {
      throw new Error("下载任务不存在");
    }

    if (task.engine === "qbittorrent") {
      const settings = await repository.getSettings();
      const engine = new QbittorrentEngine({
        baseUrl: qbittorrentManagedService.getRuntimeBaseUrl(settings),
        username: settings.download.qbittorrent.username,
        password: settings.download.qbittorrent.password
      });
      await engine.setFilePriority(task.torrentHash ?? task.id, fileIndexes, priority);
    }

    return repository.upsertDownloadTask({
      ...task,
      files: task.files.map((file) =>
        fileIndexes.includes(file.index)
          ? {
              ...file,
              priority,
              selected: priority > 0
            }
        : file
      )
    });
  });
  ipcMain.handle("downloads:addUrl", async (_event, input: AddDownloadUrlInput) => {
    const settings = await repository.getSettings();
    const url = input.url.trim();
    if (!url) {
      throw new Error("请输入 magnet 或 torrent 地址");
    }

    logger.info("Manual download add requested", {
      engine: settings.download.defaultTorrentEngine,
      hasCustomSavePath: Boolean(input.savePath?.trim())
    });
    const engine = createTorrentEngine(settings, {
      qbittorrentBaseUrl: qbittorrentManagedService.getRuntimeBaseUrl(settings)
    });
    const savePath = input.savePath?.trim() || settings.download.defaultDownloadDir;
    const task = await engine.addMagnet(url, {
      savePath,
      paused: input.paused
    });

    return repository.upsertDownloadTask({
      ...task,
      name: input.name?.trim() || getManualDownloadName(url)
    });
  });
  ipcMain.handle("downloads:addRelease", async (_event, input: AddReleaseDownloadInput) => {
    const settings = await repository.getSettings();
    const release = input.release;
    const url = release.magnetUrl ?? release.torrentUrl;
    if (!url) {
      throw new Error("资源没有 magnet 或 torrent 地址，无法添加下载");
    }

    const animeId = input.animeId ?? release.animeId;
    const episodeId = input.episodeId;
    const episodeNo = input.episodeNo ?? release.episodeNo;
    const fansubGroupId = input.fansubGroupId ?? release.fansubGroupId;
    const savePath = input.savePath?.trim() || (await getAnimeDownloadDir(animeId)) || settings.download.defaultDownloadDir;
    logger.info("Release download add requested", {
      engine: settings.download.defaultTorrentEngine,
      animeId,
      episodeId,
      episodeNo,
      releaseId: release.id
    });
    const engine = createTorrentEngine(settings, {
      qbittorrentBaseUrl: qbittorrentManagedService.getRuntimeBaseUrl(settings)
    });
    const task = await engine.addMagnet(url, {
      savePath,
      paused: input.paused
    });
    const downloads = await repository.upsertDownloadTask({
      ...task,
      releaseId: release.id,
      animeId,
      episodeId,
      name: release.title
    });
    await updateEpisodeDownloadLink({
      animeId,
      episodeId,
      fansubGroupId,
      releaseId: release.id
    });

    return downloads;
  });
  ipcMain.handle("fansubs:list", () => repository.listFansubs());
  ipcMain.handle("sources:list", () => repository.listSources());
  ipcMain.handle("sources:setEnabled", (_event, sourceId: string, enabled: boolean) =>
    repository.updateSourceEnabled(sourceId, enabled)
  );
  ipcMain.handle("sources:upsert", (_event, source: ReleaseSourceConfig) => repository.upsertSource(source));
  ipcMain.handle("releases:search", async (_event, query: ReleaseQuery) => {
    const sources = await repository.listSources();
    return new ReleaseSourceService(sources).search(query);
  });
  ipcMain.handle("settings:get", () => repository.getSettings());
  ipcMain.handle("settings:update", async (_event, patch: Partial<AppSettings>) => {
    const settings = await repository.updateSettings(patch);
    await options.onSettingsUpdated?.(settings);
    await automationScheduler.restart();
    return settings;
  });
  ipcMain.handle("settings:resetDefaults", async () => {
    const settings = await repository.resetSettingsToDefaults();
    await options.onSettingsUpdated?.(settings);
    await automationScheduler.restart();
    return settings;
  });
  ipcMain.handle("downloads:getQbittorrentManagedStatus", async () => {
    const settings = await repository.getSettings();
    return qbittorrentManagedService.getStatus(settings);
  });
  ipcMain.handle("downloads:startQbittorrentManaged", async () => {
    const settings = await repository.getSettings();
    return qbittorrentManagedService.start(settings);
  });
  ipcMain.handle("downloads:stopQbittorrentManaged", () => qbittorrentManagedService.stop());
  ipcMain.handle("media:list", () => repository.listMediaFiles());
  ipcMain.handle("media:scanDownload", async (_event, taskId: string) => {
    const task = await repository.getDownloadTask(taskId);
    if (!task) {
      throw new Error("下载任务不存在");
    }

    const settings = await repository.getSettings();
    const probeService = new FfprobeMediaProbeService({
      ffprobePath: settings.media.ffprobePath,
      timeoutMs: settings.media.ffprobeTimeoutSeconds * 1000
    });
    const result = await new DownloadMediaScanner(probeService, settings).scanTask(task);
    if (result.mediaFiles.length) {
      await repository.upsertMediaFiles(result.mediaFiles);
    }

    return result;
  });
  ipcMain.handle("downloads:testQbittorrent", async () => {
    try {
      const settings = await repository.getSettings();
      const engine = new QbittorrentEngine({
        baseUrl: qbittorrentManagedService.getRuntimeBaseUrl(settings),
        username: settings.download.qbittorrent.username,
        password: settings.download.qbittorrent.password
      });
      await engine.connect();
      const tasks = await engine.listTasks();

      return {
        ok: true,
        message: "qBittorrent 连接正常",
        taskCount: tasks.length
      };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : "qBittorrent 连接失败"
      };
    }
  });
  ipcMain.handle("media:play", async (_event, filePath: string, profileId?: string) => {
    const settings = await repository.getSettings();
    await new PlayerLauncherService(settings).play(filePath, profileId);
  });
  ipcMain.handle("media:reveal", async (_event, filePath: string) => {
    PlayerLauncherService.reveal(filePath);
  });
  ipcMain.handle("platform:openExternal", (_event, url: string) => shell.openExternal(url));
}

function getManualDownloadName(url: string): string {
  if (url.startsWith("magnet:")) {
    try {
      return new URL(url).searchParams.get("dn") || "手动添加下载";
    } catch {
      return "手动添加下载";
    }
  }

  try {
    const pathname = new URL(url).pathname;
    const filename = pathname.split("/").filter(Boolean).at(-1);
    return filename || "手动添加下载";
  } catch {
    return "手动添加下载";
  }
}

async function getAnimeDownloadDir(animeId?: string): Promise<string | undefined> {
  if (!animeId) {
    return undefined;
  }

  const anime = (await repository.listMyAnime()).find((item) => item.anime.id === animeId);
  return anime?.downloadDir?.trim() || undefined;
}

async function updateEpisodeDownloadLink(input: {
  animeId?: string;
  episodeId?: string;
  fansubGroupId?: string;
  releaseId: string;
}): Promise<void> {
  if (!input.animeId || !input.episodeId) {
    return;
  }

  const [episodes, preferences] = await Promise.all([
    repository.listEpisodes(input.animeId),
    repository.listEpisodePreferences(input.animeId)
  ]);
  const episode = episodes.find((item) => item.id === input.episodeId);
  if (episode) {
    await repository.upsertEpisode({
      ...episode,
      status: "downloading"
    });
  }

  const existingPreference = preferences.find((item) => item.episodeId === input.episodeId);
  if (!existingPreference && !input.fansubGroupId) {
    return;
  }

  await repository.upsertEpisodePreference({
    id: existingPreference?.id ?? `episode-pref-${Date.now()}`,
    animeId: input.animeId,
    episodeId: input.episodeId,
    fansubGroupId: existingPreference?.fansubGroupId ?? input.fansubGroupId,
    releaseId: input.releaseId,
    isManualOverride: existingPreference?.isManualOverride ?? Boolean(input.fansubGroupId)
  });
}
