import { ipcMain, shell } from "electron";
import type { AppSettings, Episode, EpisodePreference, MyAnime, ReleaseSourceConfig } from "@shared/domain";
import type { AppRepository } from "./core/repositories/app-repository";
import { createRepositoryRuntime } from "./core/repositories/repository-runtime";
import { QbittorrentEngine } from "./core/downloads/qbittorrent-engine";
import { ReleaseSourceService } from "./core/sources/release-source-service";
import type {
  AddDownloadUrlInput,
  AddReleaseDownloadInput,
  AnimeReleaseQuery,
  AnimeDiscoveryQuery,
  ConfirmAnimeSourceBindingInput,
  ReleaseQuery,
  RssSubscriptionReleaseQuery
} from "@shared/contracts";
import { createTorrentEngine } from "./core/downloads/torrent-engine-factory";
import { PlayerLauncherService } from "./core/platform/player-launcher";
import { DownloadMediaScanner } from "./core/media/download-media-scanner";
import { FfprobeMediaProbeService } from "./core/media/ffprobe-media-probe-service";
import { CompletedDownloadMediaAutoScanner } from "./core/media/completed-download-media-auto-scanner";
import { EpisodeReleasePreviewService } from "./core/automation/episode-release-preview-service";
import { AutomationScheduler } from "./core/automation/automation-scheduler";
import { AnimeDiscoveryService } from "./core/metadata/anime-discovery-service";
import { MetadataHttpClient } from "./core/metadata/metadata-http-client";
import { QbittorrentManagedService } from "./core/downloads/qbittorrent-managed-service";
import { logger } from "./core/logger";
import { resolveAnimeDownloadPath } from "./core/downloads/download-path-resolver";
import { RssReleaseSource } from "./core/sources/rss-source";
import { AnimeSourceBindingService } from "./core/source-bindings/anime-source-binding-service";
import { buildAnimeReleaseSearchTerms, matchesAnimeReleaseTitle } from "@shared/anime-release-search";
import { AnimeFansubDiscoveryService } from "./core/fansubs/anime-fansub-discovery-service";
import { enrichReleaseFromTitle } from "./core/releases/release-title-parser";

export const repositoryRuntime = createRepositoryRuntime();
export const repository = repositoryRuntime.repository;
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
  ipcMain.handle("myAnime:upsert", async (_event, item: MyAnime) => {
    const existed = (await repository.listMyAnime()).some((entry) => entry.id === item.id);
    const items = await repository.upsertMyAnime(item);
    if (!existed) {
      new AnimeFansubDiscoveryService(repository).discoverInBackground(item);
    }
    return items;
  });
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
    const [settings, knownFansubs] = await Promise.all([
      repository.getSettings(),
      repository.listFansubs(input.animeId ?? input.release.animeId)
    ]);
    const release = enrichReleaseFromTitle(input.release, knownFansubs);
    const url = release.magnetUrl ?? release.torrentUrl;
    if (!url) {
      throw new Error("资源没有 magnet 或 torrent 地址，无法添加下载");
    }

    const animeId = input.animeId ?? release.animeId;
    const episodeNo = input.episodeNo ?? release.episodeNo;
    const fansubGroupId = release.fansubName
      ? release.fansubGroupId
      : release.fansubGroupId ?? input.fansubGroupId;
    const [followedAnime, fansubs] = await Promise.all([
      findMyAnime(animeId),
      repository.listFansubs()
    ]);
    const fansubName =
      release.fansubName ?? fansubs.find((item) => item.id === fansubGroupId)?.name;
    if (animeId) {
      await repository.observeAnimeFansubs(animeId, [release]);
    }
    const duplicate = findDuplicateReleaseDownload(await repository.listDownloads(), {
      releaseId: release.id,
      animeId,
      episodeNo,
      fansubGroupId,
      fansubName
    });
    if (duplicate) {
      throw new Error(
        episodeNo !== undefined
          ? `第 ${episodeNo} 集的同字幕组资源已在下载队列中`
          : "该资源已在下载队列中"
      );
    }
    const episode = await resolveDownloadEpisode(animeId, input.episodeId, episodeNo);
    const savePath = input.savePath?.trim() || resolveAnimeDownloadPath(settings, followedAnime);
    logger.info("Release download add requested", {
      engine: settings.download.defaultTorrentEngine,
      animeId,
      episodeId: episode?.id,
      episodeNo,
      fansubGroupId,
      savePath,
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
      episodeId: episode?.id,
      animeTitle: followedAnime?.anime.title,
      episodeNo,
      fansubGroupId,
      fansubName,
      name: release.title
    });
    await updateEpisodeDownloadLink({
      animeId,
      episodeId: episode?.id,
      fansubGroupId,
      releaseId: release.id
    });

    return downloads;
  });
  ipcMain.handle("fansubs:list", (_event, animeId?: string) => repository.listFansubs(animeId));
  ipcMain.handle("sources:list", () => repository.listSources());
  ipcMain.handle("sources:setEnabled", (_event, sourceId: string, enabled: boolean) =>
    repository.updateSourceEnabled(sourceId, enabled)
  );
  ipcMain.handle("sources:upsert", (_event, source: ReleaseSourceConfig) => repository.upsertSource(source));
  ipcMain.handle("animeSourceBindings:getState", async (_event, animeId: string, discoverCandidates = true) => {
    const settings = await repository.getSettings();
    return new AnimeSourceBindingService(
      repository,
      new MetadataHttpClient(settings.network.metadataProxy)
    ).getState(animeId, discoverCandidates);
  });
  ipcMain.handle("animeSourceBindings:confirm", async (_event, input: ConfirmAnimeSourceBindingInput) => {
    const settings = await repository.getSettings();
    return new AnimeSourceBindingService(
      repository,
      new MetadataHttpClient(settings.network.metadataProxy)
    ).confirm(input);
  });
  ipcMain.handle("animeSourceBindings:remove", async (_event, animeId: string, sourceId: string) => {
    const settings = await repository.getSettings();
    return new AnimeSourceBindingService(
      repository,
      new MetadataHttpClient(settings.network.metadataProxy)
    ).remove(animeId, sourceId);
  });
  ipcMain.handle("releases:search", async (_event, query: ReleaseQuery) => {
    const [sources, fansubs, settings] = await Promise.all([
      repository.listSources(),
      repository.listFansubs(),
      repository.getSettings()
    ]);
    const result = await new ReleaseSourceService(
      sources,
      fansubs,
      new MetadataHttpClient(settings.network.metadataProxy)
    ).search(query);
    if (query.animeId && await findMyAnime(query.animeId)) {
      await repository.observeAnimeFansubs(query.animeId, result.releases);
    }
    return result;
  });
  ipcMain.handle("releases:searchAnime", async (_event, query: AnimeReleaseQuery) => {
    const followedAnime = await findMyAnime(query.animeId);
    if (!followedAnime) {
      throw new Error("追番不存在");
    }
    const [sources, fansubs, settings] = await Promise.all([
      repository.listSources(),
      repository.listFansubs(query.animeId),
      repository.getSettings()
    ]);
    const httpClient = new MetadataHttpClient(settings.network.metadataProxy);
    const bindingState = await new AnimeSourceBindingService(repository, httpClient).getState(query.animeId, false);
    const result = await new ReleaseSourceService(sources, fansubs, httpClient).searchAnime(
      followedAnime.anime,
      query,
      bindingState.bindings
    );
    await repository.observeAnimeFansubs(query.animeId, result.releases);
    return result;
  });
  ipcMain.handle("releases:searchRssSubscription", (_event, query: RssSubscriptionReleaseQuery) =>
    searchRssSubscriptionReleases(query)
  );
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

/** 根据番剧目录 ID 查找追番配置。 */
async function findMyAnime(animeId?: string): Promise<MyAnime | undefined> {
  if (!animeId) {
    return undefined;
  }

  return (await repository.listMyAnime()).find((item) => item.anime.id === animeId);
}

/** 按单个追番 RSS 订阅读取资源，独立于全局下载源开关。 */
async function searchRssSubscriptionReleases(query: RssSubscriptionReleaseQuery) {
  const [settings, followedAnime] = await Promise.all([
    repository.getSettings(),
    findMyAnime(query.animeId)
  ]);
  if (!followedAnime) {
    return {
      query,
      releases: [],
      errors: [{ sourceId: query.subscriptionId, message: "追番不存在" }]
    };
  }
  const subscription = followedAnime.rssSubscriptions?.find((item) => item.id === query.subscriptionId);
  if (!subscription?.enabled) {
    return {
      query,
      releases: [],
      errors: [{ sourceId: query.subscriptionId, message: "RSS 订阅不存在或未启用" }]
    };
  }
  logger.info("RSS 订阅资源搜索开始", {
    animeId: query.animeId,
    subscriptionId: query.subscriptionId,
    subscriptionName: subscription.name
  });
  try {
    const rssUrl = validateRssUrl(subscription.url);
    const source = new RssReleaseSource(
      {
        id: `rss-subscription:${query.subscriptionId}`,
        name: subscription.name,
        kind: "rss",
        enabled: true,
        rssUrl
      },
      new MetadataHttpClient(settings.network.metadataProxy)
    );
    const releases = await source.searchReleases({
      keyword: "",
      animeId: query.animeId,
      preferredResolution: query.preferredResolution,
      limit: query.limit
    });
    const searchTerms = buildAnimeReleaseSearchTerms(followedAnime.anime);
    const relevantReleases = isExactMikanSubscription(rssUrl, followedAnime)
      ? releases
      : releases.filter((release) => matchesAnimeReleaseTitle(release.title, searchTerms));
    const knownFansubs = await repository.listFansubs(query.animeId);
    const normalizedReleases = relevantReleases.map((release) => ({
      ...enrichReleaseFromTitle(release, knownFansubs),
      animeId: query.animeId
    }));
    await repository.observeAnimeFansubs(query.animeId, normalizedReleases);
    logger.info("RSS 订阅资源搜索完成", {
      animeId: query.animeId,
      subscriptionId: query.subscriptionId,
      releaseCount: relevantReleases.length,
      filteredCount: releases.length - relevantReleases.length
    });
    return {
      query,
      releases: normalizedReleases,
      errors: []
    };
  } catch (error) {
    const message = formatReleaseSearchError(error);
    logger.warn("RSS 订阅资源搜索失败", {
      animeId: query.animeId,
      subscriptionId: query.subscriptionId,
      message
    });
    return {
      query,
      releases: [],
      errors: [{ sourceId: query.subscriptionId, message }]
    };
  }
}

/** 校验用户保存的 RSS 地址，主进程只允许 HTTP(S)。 */
function validateRssUrl(value: string): string {
  const url = new URL(value.trim());
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("RSS 订阅仅支持 HTTP 或 HTTPS 地址");
  }
  return url.toString();
}

/** 判断 RSS 是否为当前番剧外部 ID 对应的 Mikan 精确订阅。 */
function isExactMikanSubscription(rssUrl: string, followedAnime: MyAnime): boolean {
  const mikanId = followedAnime.anime.externalIds.mikan?.trim();
  if (!mikanId) {
    return false;
  }
  const url = new URL(rssUrl);
  const hostname = url.hostname.toLowerCase();
  return (hostname === "mikanani.me" || hostname.endsWith(".mikanani.me")) &&
    url.searchParams.get("bangumiId") === mikanId;
}

/** 复用或创建资源下载需要关联的单集。 */
async function resolveDownloadEpisode(
  animeId?: string,
  episodeId?: string,
  episodeNo?: number
): Promise<Episode | undefined> {
  if (!animeId) {
    return undefined;
  }

  const episodes = await repository.listEpisodes(animeId);
  const existing =
    (episodeId ? episodes.find((item) => item.id === episodeId) : undefined) ??
    (episodeNo !== undefined ? episodes.find((item) => item.episodeNo === episodeNo) : undefined);
  if (existing) {
    return existing;
  }

  if (episodeNo === undefined) {
    return undefined;
  }

  const episode: Episode = {
    id: createEpisodeId(animeId, episodeNo),
    animeId,
    episodeNo,
    status: "downloading"
  };
  await repository.upsertEpisode(episode);
  logger.info("Episode created from release download", { animeId, episodeId: episode.id, episodeNo });
  return episode;
}

function createEpisodeId(animeId: string, episodeNo: number): string {
  return `episode-${animeId}-${String(episodeNo).replace(".", "-")}`;
}

function findDuplicateReleaseDownload(
  downloads: Awaited<ReturnType<AppRepository["listDownloads"]>>,
  input: {
    releaseId: string;
    animeId?: string;
    episodeNo?: number;
    fansubGroupId?: string;
    fansubName?: string;
  }
) {
  return downloads.find((task) => {
    if (task.releaseId === input.releaseId) {
      return true;
    }

    const fansubKey = input.fansubGroupId ?? input.fansubName;
    return Boolean(
      input.animeId &&
      input.episodeNo !== undefined &&
      fansubKey &&
      task.animeId === input.animeId &&
      task.episodeNo === input.episodeNo &&
      (task.fansubGroupId ?? task.fansubName) === fansubKey
    );
  });
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

function formatReleaseSearchError(error: unknown): string {
  if (!(error instanceof Error)) {
    return "下载源搜索失败";
  }

  const cause = error.cause instanceof Error ? error.cause.message : undefined;
  const message = cause ? `${error.message}: ${cause}` : error.message;
  if (/fetch failed/i.test(message)) {
    return "下载源网络请求失败，请检查网络、代理或下载源地址";
  }

  if (/aborted|timeout/i.test(message)) {
    return "下载源请求超时，请稍后重试";
  }

  return message;
}
