import { ipcMain, shell } from "electron";
import type { AppSettings, Episode, EpisodePreference, MyAnime, Release, ReleaseSourceConfig } from "@shared/domain";
import { AppRepository } from "./core/repositories/app-repository";
import { AppDataStore } from "./core/storage/app-data-store";
import { QbittorrentEngine } from "./core/downloads/qbittorrent-engine";
import { ReleaseSourceService } from "./core/sources/release-source-service";
import type { AnimeDiscoveryQuery, ReleaseQuery } from "@shared/contracts";
import { createTorrentEngine } from "./core/downloads/torrent-engine-factory";
import { PlayerLauncherService } from "./core/platform/player-launcher";
import { DownloadMediaScanner } from "./core/media/download-media-scanner";
import { FfprobeMediaProbeService } from "./core/media/ffprobe-media-probe-service";
import { EpisodeReleasePreviewService } from "./core/automation/episode-release-preview-service";
import { AutomationScheduler } from "./core/automation/automation-scheduler";
import { AnimeDiscoveryService } from "./core/metadata/anime-discovery-service";

export const repository = new AppRepository(new AppDataStore());
export const automationScheduler = new AutomationScheduler(repository);

export function registerIpcHandlers(): void {
  ipcMain.handle("dashboard:get", () => repository.getDashboard());
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
  ipcMain.handle("automation:runOnce", () => automationScheduler.runNow());
  ipcMain.handle("automation:getSchedulerStatus", () => automationScheduler.getStatus());
  ipcMain.handle("automation:restartScheduler", () => automationScheduler.restart());
  ipcMain.handle("downloads:list", () => repository.listDownloads());
  ipcMain.handle("downloads:refresh", async () => {
    const settings = await repository.getSettings();
    const engine = createTorrentEngine(settings);
    const tasks = await engine.listTasks();
    return repository.mergeDownloadTasksFromEngine(tasks);
  });
  ipcMain.handle("downloads:pause", async (_event, taskId: string) => {
    const task = await repository.getDownloadTask(taskId);
    if (!task) {
      throw new Error("下载任务不存在");
    }

    if (task.engine === "qbittorrent") {
      const settings = await repository.getSettings();
      const engine = new QbittorrentEngine({
        baseUrl: settings.download.qbittorrent.baseUrl,
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
        baseUrl: settings.download.qbittorrent.baseUrl,
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
        baseUrl: settings.download.qbittorrent.baseUrl,
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
        baseUrl: settings.download.qbittorrent.baseUrl,
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
  ipcMain.handle("downloads:addRelease", async (_event, release: Release) => {
    const settings = await repository.getSettings();
    const url = release.magnetUrl ?? release.torrentUrl;
    if (!url) {
      throw new Error("资源没有 magnet 或 torrent 地址，无法添加下载");
    }

    const engine = createTorrentEngine(settings);
    const task = await engine.addMagnet(url, {
      savePath: settings.download.defaultDownloadDir
    });
    const downloads = await repository.upsertDownloadTask({
      ...task,
      releaseId: release.id,
      animeId: release.animeId,
      name: release.title
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
    await automationScheduler.restart();
    return settings;
  });
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
        baseUrl: settings.download.qbittorrent.baseUrl,
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
