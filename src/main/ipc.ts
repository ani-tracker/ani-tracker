import { dialog, ipcMain, shell, type BrowserWindow } from "electron";
import type {
  AppSettings,
  Episode,
  EpisodePreference,
  MyAnime,
  PlayerProfile,
  Release,
  ReleaseSourceConfig,
  SubtitleLanguage
} from "@shared/domain";
import { getSubtitleCoverage, resolveSubtitleLanguages } from "@shared/release-metadata";
import type { AppRepository } from "./core/repositories/app-repository";
import { createRepositoryRuntime } from "./core/repositories/repository-runtime";
import { QbittorrentEngine } from "./core/downloads/qbittorrent-engine";
import { embeddedTorrentCoreService } from "./core/downloads/embedded-torrent-core-service";
import { ReleaseSourceService, resolveAnimeReleaseCacheTtlMs } from "./core/sources/release-source-service";
import type {
  AddDownloadUrlInput,
  AddReleaseDownloadInput,
  AnimeReleaseQuery,
  AnimeDiscoveryQuery,
  AnimeDiscoverySeasonQuery,
  ConfirmAnimeSourceBindingInput,
  DesktopPlayerWindowDragInput,
  DesktopPlayerWindowInput,
  DesktopPlaybackSessionInput,
  ReportAnimeSourceCandidateMismatchInput,
  ReportPlaybackProgressInput,
  ReleaseQuery,
  RssSubscriptionReleaseQuery,
  SelectPlayerExecutableInput,
  SavePlaybackCheckpointInput,
  SetAnimeWatchProgressInput
} from "@shared/contracts";
import { createTorrentEngine } from "./core/downloads/torrent-engine-factory";
import { PlayerLauncherService } from "./core/platform/player-launcher";
import { DownloadMediaScanner } from "./core/media/download-media-scanner";
import { FfprobeMediaProbeService } from "./core/media/ffprobe-media-probe-service";
import { resolveFfprobeCommands } from "./core/media/ffmpeg-binary-resolver";
import { EpisodeReleasePreviewService } from "./core/automation/episode-release-preview-service";
import { AutomationScheduler } from "./core/automation/automation-scheduler";
import { AnimeDiscoveryService } from "./core/metadata/anime-discovery-service";
import { AnimeDetailService } from "./core/metadata/anime-detail-service";
import { MetadataHttpClient } from "./core/metadata/metadata-http-client";
import { QbittorrentManagedService } from "./core/downloads/qbittorrent-managed-service";
import { logger } from "./core/logger";
import { resolveAnimeDownloadPath } from "./core/downloads/download-path-resolver";
import { addReleaseTorrentToEngine, addTorrentAddressToEngine } from "./core/downloads/torrent-resource-adder";
import { RssReleaseSource } from "./core/sources/rss-source";
import { createSourceHttpClient } from "./core/sources/source-http-client";
import { AnimeSourceBindingService } from "./core/source-bindings/anime-source-binding-service";
import { buildAnimeReleaseSearchTerms, classifyAnimeRelease, matchesAnimeReleaseTitle } from "@shared/anime-release-search";
import { AnimeFollowPreparationService } from "./core/follows/anime-follow-preparation-service";
import { enrichReleaseFromTitle } from "./core/releases/release-title-parser";
import { sortReleasesByRules } from "./core/releases/release-matcher";
import { PlaybackStatusService } from "./core/media/playback-status-service";
import { PlaybackCheckpointService } from "./core/media/playback-checkpoint-service";
import { DownloadTaskControlService } from "./core/downloads/download-task-control-service";
import { PlayerDetectionService } from "./core/platform/player-detection-service";
import type { RemoteHttpGateway } from "./core/remote/remote-http-gateway";
import type { ImageCacheService } from "./core/cache/image-cache-service";
import { SourceSyncScheduler } from "./core/sources/source-sync-scheduler";
import type { DesktopPlaybackSessionService } from "./core/media/desktop-playback-session-service";
import type { DesktopPlayerWindowService } from "./core/media/desktop-player-window-service";
import {
  createUnavailablePlayerCapabilities,
  type PlayerCapabilities,
  type PlayerCommand,
  type PlayerCommandResult
} from "@shared/player-contract";

interface DesktopPlayerControlService {
  /** 返回指定播放器窗口可使用的原生播放能力。 */
  getCapabilities(ownerId: number): PlayerCapabilities | Promise<PlayerCapabilities>;
  /** 将受校验的播放器命令发送到指定窗口的原生后端。 */
  dispatch(command: PlayerCommand, ownerId: number): PlayerCommandResult | Promise<PlayerCommandResult>;
}

export const repositoryRuntime = createRepositoryRuntime();
export const repository = repositoryRuntime.repository;
export const qbittorrentManagedService = new QbittorrentManagedService();
export { embeddedTorrentCoreService };
export const automationScheduler = new AutomationScheduler(repository, undefined, {
  getQbittorrentBaseUrl: (settings) => qbittorrentManagedService.getRuntimeBaseUrl(settings)
});
export const sourceSyncScheduler = new SourceSyncScheduler(repository);
export const downloadTaskControlService = new DownloadTaskControlService(repository, qbittorrentManagedService, {
  embeddedTorrentClient: embeddedTorrentCoreService
});
export const animeDetailService = new AnimeDetailService(repository);
export const playbackStatusService = new PlaybackStatusService(repository);
export const playbackCheckpointService = new PlaybackCheckpointService(repository, playbackStatusService);
export const animeFollowPreparationService = new AnimeFollowPreparationService(repository);

interface RegisterIpcHandlersOptions {
  onSettingsUpdated?: (settings: AppSettings) => void | Promise<void>;
  remoteGateway?: RemoteHttpGateway;
  imageCacheService?: ImageCacheService;
  desktopPlaybackSessionService?: Pick<DesktopPlaybackSessionService, "createSession" | "closeSession">;
  desktopPlayerWindowService?: Pick<DesktopPlayerWindowService, "open" | "close" | "drag">;
  desktopPlayerControlService?: DesktopPlayerControlService;
  getMainWindow?: () => BrowserWindow | null;
}

export function registerIpcHandlers(options: RegisterIpcHandlersOptions = {}): void {
  ipcMain.handle("window:getState", () => getWindowState(options.getMainWindow?.()));
  ipcMain.handle("window:minimize", () => {
    options.getMainWindow?.()?.minimize();
  });
  ipcMain.handle("window:toggleMaximize", () => {
    const window = options.getMainWindow?.();
    if (!window) {
      return { maximized: false };
    }
    if (window.isMaximized()) {
      window.unmaximize();
    } else {
      window.maximize();
    }
    logger.info("Main window maximize state changed", { maximized: window.isMaximized() });
    return getWindowState(window);
  });
  ipcMain.handle("window:close", () => {
    logger.info("Main window close requested from frameless window controls");
    options.getMainWindow?.()?.close();
  });
  if (options.imageCacheService) {
    ipcMain.handle("images:resolveUrl", (_event, sourceUrl: string) => ({
      url: options.imageCacheService!.createElectronUrl(sourceUrl)
    }));
  }
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
      const savedItem = items.find((entry) => entry.id === item.id) ?? item;
      void animeFollowPreparationService.prepareInBackground(savedItem);
    }
    return items;
  });
  ipcMain.handle("myAnime:remove", (_event, itemId: string) => repository.removeMyAnime(itemId));
  ipcMain.handle("myAnime:listWatchProgress", () => repository.listMyAnimeWatchProgress());
  ipcMain.handle("myAnime:setWatchProgress", (_event, input: SetAnimeWatchProgressInput) =>
    repository.setAnimeWatchProgress(input)
  );
  ipcMain.handle("playback:reportProgress", (_event, input: ReportPlaybackProgressInput) =>
    playbackStatusService.handleTaskProgress(input)
  );
  ipcMain.handle("playback:saveCheckpoint", (_event, input: SavePlaybackCheckpointInput) =>
    playbackCheckpointService.save(input)
  );
  ipcMain.handle("animeCatalog:list", (_event, year?: number, month?: number) =>
    new AnimeDiscoveryService(repository).listCatalog(year, month)
  );
  ipcMain.handle("animeCatalog:search", (_event, keyword: string) =>
    new AnimeDiscoveryService(repository).searchCatalog(keyword)
  );
  ipcMain.handle("animeCatalog:collectMonth", (_event, query: AnimeDiscoveryQuery) =>
    new AnimeDiscoveryService(repository).collectMonth(query)
  );
  ipcMain.handle("animeCatalog:collectSeason", (_event, query: AnimeDiscoverySeasonQuery) =>
    new AnimeDiscoveryService(repository).collectSeason(query)
  );
  ipcMain.handle("animeDetail:get", (_event, animeId: string) => animeDetailService.getAnimeDetail(animeId));
  ipcMain.handle("animeDetail:refresh", (_event, animeId: string) => animeDetailService.refreshAnimeDetail(animeId));
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
  ipcMain.handle("downloads:refresh", () => downloadTaskControlService.refresh());
  ipcMain.handle("downloads:pause", (_event, taskId: string) => downloadTaskControlService.pause(taskId));
  ipcMain.handle("downloads:resume", (_event, taskId: string) => downloadTaskControlService.resume(taskId));
  ipcMain.handle("downloads:remove", (_event, taskId: string, deleteFiles: boolean) =>
    downloadTaskControlService.remove(taskId, deleteFiles)
  );
  ipcMain.handle("downloads:setFilePriority", (_event, taskId: string, fileIndexes: number[], priority: number) =>
    downloadTaskControlService.setFilePriority(taskId, fileIndexes, priority)
  );
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
    const torrentHttpClient = new MetadataHttpClient(settings.network.metadataProxy);
    const engine = createTorrentEngine(settings, {
      qbittorrentBaseUrl: qbittorrentManagedService.getRuntimeBaseUrl(settings),
      torrentHttpClient
    });
    const savePath = input.savePath?.trim() || settings.download.defaultDownloadDir;
    const task = await addTorrentAddressToEngine({
      engine,
      url,
      options: {
        savePath,
        paused: input.paused
      },
      torrentHttpClient,
      context: {
        source: "manual-url"
      }
    });

    const name = input.name?.trim() || getManualDownloadName(url);
    const metadata = enrichReleaseFromTitle({
      id: task.id,
      title: name,
      sourceId: "manual",
      sourceName: "手动添加",
      publishedAt: task.createdAt
    });
    return repository.upsertDownloadTask({
      ...task,
      name,
      resolution: metadata.resolution,
      declaredVideoCodec: metadata.declaredVideoCodec,
      normalizedVideoCodec: metadata.normalizedVideoCodec,
      bitDepth: metadata.bitDepth,
      subtitleLanguages: metadata.subtitleLanguages,
      subtitle: metadata.subtitle
    });
  });
  ipcMain.handle("downloads:addRelease", async (_event, input: AddReleaseDownloadInput) => {
    const [settings, knownFansubs] = await Promise.all([
      repository.getSettings(),
      repository.listFansubs(input.animeId ?? input.release.animeId)
    ]);
    const release = enrichReleaseFromTitle(input.release, knownFansubs);
    if (!release.magnetUrl && !release.torrentUrl) {
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
      fansubs.find((item) => item.id === fansubGroupId)?.name ?? release.fansubName;
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
    const torrentHttpClient = new MetadataHttpClient(settings.network.metadataProxy);
    const engine = createTorrentEngine(settings, {
      qbittorrentBaseUrl: qbittorrentManagedService.getRuntimeBaseUrl(settings),
      torrentHttpClient
    });
    const task = await addReleaseTorrentToEngine({
      engine,
      magnetUrl: release.magnetUrl,
      torrentUrl: release.torrentUrl,
      options: {
        savePath,
        paused: input.paused
      },
      torrentHttpClient,
      context: {
        source: "release",
        animeId,
        episodeId: episode?.id,
        episodeNo,
        releaseId: release.id
      }
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
      resolution: release.resolution,
      declaredVideoCodec: release.declaredVideoCodec,
      normalizedVideoCodec: release.normalizedVideoCodec,
      bitDepth: release.bitDepth,
      subtitleLanguages: release.subtitleLanguages,
      subtitle: release.subtitle,
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
  ipcMain.handle("sources:getSyncStatus", () => sourceSyncScheduler.getStatus());
  ipcMain.handle("sources:syncNow", () => sourceSyncScheduler.runNow({ force: true, trigger: "manual" }));
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
  ipcMain.handle("animeSourceBindings:reportMismatch", async (_event, input: ReportAnimeSourceCandidateMismatchInput) => {
    const settings = await repository.getSettings();
    return new AnimeSourceBindingService(
      repository,
      new MetadataHttpClient(settings.network.metadataProxy)
    ).reportMismatch(input);
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
      new MetadataHttpClient(settings.network.metadataProxy),
      repository
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
    const [sources, fansubs, settings, episodes, episodePreferences] = await Promise.all([
      repository.listSources(),
      repository.listFansubs(query.animeId),
      repository.getSettings(),
      repository.listEpisodes(query.animeId),
      repository.listEpisodePreferences(query.animeId)
    ]);
    const httpClient = new MetadataHttpClient(settings.network.metadataProxy);
    const bindingState = await new AnimeSourceBindingService(repository, httpClient).getState(query.animeId, false);
    const effectiveQuery = {
      ...query,
      cacheTtlMs: resolveAnimeReleaseCacheTtlMs(followedAnime.status, query.cacheTtlMs)
    };
    const result = await new ReleaseSourceService(sources, fansubs, httpClient, repository).searchAnime(
      followedAnime.anime,
      effectiveQuery,
      bindingState.bindings
    );
    const episodeFansubOverrides = createEpisodeFansubOverrideMap(episodes, episodePreferences);
    const sortedReleases = sortReleasesByRules(
      result.releases,
      (release) => ({
        anime: followedAnime,
        episodeNo: release.episodeNo,
        episodeFansubOverrideId: release.episodeNo === undefined
          ? undefined
          : episodeFansubOverrides.get(release.episodeNo)
      }),
      fansubs
    );
    await repository.observeAnimeFansubs(query.animeId, sortedReleases);
    logger.info("下载资源已按追番规则排序", {
      animeId: query.animeId,
      releaseCount: sortedReleases.length,
      topReleaseId: sortedReleases[0]?.id
    });
    return { ...result, releases: sortedReleases };
  });
  ipcMain.handle("releases:searchRssSubscription", (_event, query: RssSubscriptionReleaseQuery) =>
    searchRssSubscriptionReleases(query)
  );
  ipcMain.handle("settings:get", () => repository.getSettings());
  ipcMain.handle("settings:update", async (_event, patch: Partial<AppSettings>) => {
    const settings = await repository.updateSettings(patch);
    await options.onSettingsUpdated?.(settings);
    await automationScheduler.restart();
    await sourceSyncScheduler.restart();
    return settings;
  });
  ipcMain.handle("settings:resetDefaults", async () => {
    const settings = await repository.resetSettingsToDefaults();
    await options.onSettingsUpdated?.(settings);
    await automationScheduler.restart();
    await sourceSyncScheduler.restart();
    return settings;
  });
  ipcMain.handle("players:detect", async (_event, profiles?: PlayerProfile[]) => {
    const settings = await repository.getSettings();
    return new PlayerDetectionService().detect(Array.isArray(profiles) ? profiles : settings.players);
  });
  ipcMain.handle("players:selectExecutable", async (_event, input: SelectPlayerExecutableInput) => {
    const profileId = input?.profileId?.trim();
    if (!profileId) {
      throw new Error("播放器标识不能为空");
    }

    logger.info("Player executable selection opened", { profileId });
    const result = await dialog.showOpenDialog({
      title: "选择播放器可执行文件",
      defaultPath: input.currentPath?.trim() || undefined,
      properties: ["openFile"],
      filters: process.platform === "win32"
        ? [{ name: "Windows 可执行文件", extensions: ["exe"] }]
        : undefined
    });
    const selectedPath = result.canceled ? undefined : result.filePaths[0];
    logger.info("Player executable selection completed", { profileId, selected: Boolean(selectedPath) });
    return selectedPath;
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
  ipcMain.handle("downloads:getEmbeddedTorrentStatus", async () => {
    const settings = await repository.getSettings();
    return embeddedTorrentCoreService.refreshStatus(settings);
  });
  ipcMain.handle("downloads:startEmbeddedTorrent", async () => {
    const settings = await repository.getSettings();
    return embeddedTorrentCoreService.start(settings);
  });
  ipcMain.handle("downloads:stopEmbeddedTorrent", () => embeddedTorrentCoreService.stop());
  ipcMain.handle("downloads:restartEmbeddedTorrent", async () => {
    const settings = await repository.getSettings();
    return embeddedTorrentCoreService.restart(settings);
  });
  ipcMain.handle("media:list", () => repository.listMediaFiles());
  ipcMain.handle("media:scanDownload", async (_event, taskId: string) => {
    const task = await repository.getDownloadTask(taskId);
    if (!task) {
      throw new Error("下载任务不存在");
    }

    const settings = await repository.getSettings();
    const [ffprobePath, ...fallbackFfprobePaths] = resolveFfprobeCommands({
      configuredPath: settings.media.ffprobePath
    });
    const probeService = new FfprobeMediaProbeService({
      ffprobePath,
      fallbackFfprobePaths,
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
    await new PlayerLauncherService(settings, {
      onPlaybackProgress: async (progress) => {
        await playbackStatusService.handleProgress(progress);
      }
    }).play(filePath, profileId);
  });
  if (options.desktopPlaybackSessionService) {
    ipcMain.handle("media:createPlaybackSession", (event, input: DesktopPlaybackSessionInput) =>
      options.desktopPlaybackSessionService!.createSession(input, event.sender.id)
    );
    ipcMain.handle("media:closePlaybackSession", (event, sessionId: string) =>
      options.desktopPlaybackSessionService!.closeSession(sessionId, event.sender.id)
    );
  }
  if (options.desktopPlayerWindowService) {
    ipcMain.handle("media:openPlayerWindow", (_event, input: DesktopPlayerWindowInput) =>
      options.desktopPlayerWindowService!.open(input)
    );
    ipcMain.on("media:closePlayerWindow", (event) => {
      options.desktopPlayerWindowService!.close(event.sender.id);
    });
    ipcMain.on("media:dragPlayerWindow", (event, input: DesktopPlayerWindowDragInput) => {
      options.desktopPlayerWindowService!.drag(event.sender.id, input);
    });
  }
  ipcMain.handle("player:getCapabilities", (event) =>
    options.desktopPlayerControlService?.getCapabilities(event.sender.id)
      ?? createUnavailablePlayerCapabilities("libvlc", "electron", "libVLC 原生运行时尚未就绪")
  );
  ipcMain.handle("player:dispatch", (event, command: PlayerCommand) => {
    if (options.desktopPlayerControlService) {
      return options.desktopPlayerControlService.dispatch(command, event.sender.id);
    }
    return createPlayerRuntimeMissingResult(command);
  });
  ipcMain.handle("media:reveal", async (_event, filePath: string) => {
    const settings = await repository.getSettings();
    await new PlayerLauncherService(settings).reveal(filePath);
  });
  ipcMain.handle("platform:openExternal", (_event, url: string) => shell.openExternal(url));
  if (options.remoteGateway) {
    ipcMain.handle("remote:getStatus", () => options.remoteGateway?.getStatus());
    ipcMain.handle("remote:createPairingCode", () => options.remoteGateway?.createPairingCode());
    ipcMain.handle("remote:revokeDevice", (_event, deviceId: string) => options.remoteGateway?.revokeDevice(deviceId));
  }
}

/** 在原生播放器尚未接入时返回可展示的运行时错误。 */
function createPlayerRuntimeMissingResult(command: PlayerCommand | undefined): PlayerCommandResult {
  return {
    commandId: typeof command?.commandId === "string" ? command.commandId : "invalid-command",
    accepted: false,
    error: {
      code: "runtime-missing",
      message: "libVLC 原生运行时尚未就绪",
      recoverable: false,
      recoveryActions: ["close"]
    }
  };
}

/** 返回无边框主窗口可读取的最小窗口状态。 */
function getWindowState(window: BrowserWindow | null | undefined) {
  return { maximized: Boolean(window && !window.isDestroyed() && window.isMaximized()) };
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

/** 将单集字幕组覆盖转换为按集数查询的映射。 */
function createEpisodeFansubOverrideMap(
  episodes: Episode[],
  preferences: EpisodePreference[]
): Map<number, string> {
  const episodeNumbers = new Map(episodes.map((episode) => [episode.id, episode.episodeNo]));
  const overrides = new Map<number, string>();
  for (const preference of preferences) {
    const episodeNo = episodeNumbers.get(preference.episodeId);
    if (episodeNo !== undefined && preference.fansubGroupId) {
      overrides.set(episodeNo, preference.fansubGroupId);
    }
  }
  return overrides;
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
    subscriptionName: subscription.name,
    preferredSubtitleLanguages: resolveSubscriptionSubtitleLanguages(subscription, followedAnime)
  });
  try {
    const rssUrl = validateRssUrl(subscription.url);
    const sourceConfig = {
      id: `rss-subscription:${query.subscriptionId}`,
      name: subscription.name,
      kind: "rss" as const,
      enabled: true,
      rssUrl
    };
    const metadataHttpClient = new MetadataHttpClient(settings.network.metadataProxy);
    const source = new RssReleaseSource(
      sourceConfig,
      createSourceHttpClient(sourceConfig, metadataHttpClient)
    );
    const releases = await source.searchReleases({
      keyword: "",
      animeId: query.animeId,
      preferredResolution: query.preferredResolution,
      limit: query.limit
    });
    const knownFansubs = await repository.listFansubs(query.animeId);
    const searchTerms = buildAnimeReleaseSearchTerms(followedAnime.anime);
    const enrichedReleases = releases.map((release) => ({
      ...enrichReleaseFromTitle(release, knownFansubs),
      animeId: query.animeId
    }));
    const relevantReleases = enrichedReleases.filter((release) => {
      const titleMatched = isExactMikanSubscription(rssUrl, followedAnime) ||
        matchesAnimeReleaseTitle(release.title, searchTerms);
      return titleMatched && classifyAnimeRelease(release, followedAnime.anime) !== "mismatch";
    });
    const preferredSubtitleLanguages = resolveSubscriptionSubtitleLanguages(subscription, followedAnime);
    const normalizedReleases = sortRssSubscriptionReleases(relevantReleases, preferredSubtitleLanguages);
    await repository.observeAnimeFansubs(query.animeId, normalizedReleases);
    logger.info("RSS 订阅资源搜索完成", {
      animeId: query.animeId,
      subscriptionId: query.subscriptionId,
      releaseCount: relevantReleases.length,
      filteredCount: enrichedReleases.length - relevantReleases.length
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

/** 按订阅语言覆盖率和发布时间排列 RSS 资源，空偏好时保持时间优先。 */
function sortRssSubscriptionReleases(releases: Release[], preferredSubtitleLanguages: SubtitleLanguage[]): Release[] {
  return [...releases].sort((left, right) => {
    const leftRank = getSubtitleSortRank(left, preferredSubtitleLanguages);
    const rightRank = getSubtitleSortRank(right, preferredSubtitleLanguages);
    if (leftRank !== rightRank) {
      return leftRank - rightRank;
    }

    return (right.publishedAt ?? "").localeCompare(left.publishedAt ?? "");
  });
}

/** 计算 RSS 资源在当前多语言偏好下的排序等级。 */
function getSubtitleSortRank(release: Release, preferredSubtitleLanguages: SubtitleLanguage[]): number {
  if (!preferredSubtitleLanguages.length) {
    return 0;
  }
  return 1 - getSubtitleCoverage(release, preferredSubtitleLanguages);
}

/** RSS 未配置独立语言时继承追番的多语言偏好。 */
function resolveSubscriptionSubtitleLanguages(
  subscription: NonNullable<MyAnime["rssSubscriptions"]>[number],
  anime: MyAnime
): SubtitleLanguage[] {
  const subscriptionLanguages = resolveSubtitleLanguages(
    subscription.preferredSubtitleLanguages,
    subscription.preferredSubtitle
  );
  return subscriptionLanguages.length > 0
    ? subscriptionLanguages
    : resolveSubtitleLanguages(anime.preferredSubtitleLanguages, anime.preferredSubtitle);
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
  if (episode && episode.status !== "watched") {
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
