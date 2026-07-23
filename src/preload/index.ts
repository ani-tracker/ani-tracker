import { contextBridge, ipcRenderer } from "electron";
import type {
  Anime,
  AppSettings,
  Episode,
  EpisodePreference,
  MyAnime,
  NotificationRecord,
  PlayerProfile,
  ReleaseSourceConfig
} from "@shared/domain";
import type {
  AddDownloadUrlInput,
  AddReleaseDownloadInput,
  AnimeDetailResult,
  AppWindowState,
  AnimeReleaseQuery,
  AnimeDiscoveryQuery,
  AnimeDiscoverySeasonQuery,
  ConfirmAnimeSourceBindingInput,
  DesktopPlayerWindowInput,
  DesktopPlaybackSessionInput,
  EmbeddedTorrentCoreStatus,
  PlayerDetectionResult,
  ReportPlaybackProgressInput,
  RemoteGatewayStatus,
  RemotePairingChallenge,
  RemotePlaybackSession,
  ReportAnimeSourceCandidateMismatchInput,
  ReleaseQuery,
  RssSubscriptionReleaseQuery,
  SelectPlayerExecutableInput,
  SetAnimeWatchProgressInput,
  SourceSyncRunResult,
  SourceSyncSchedulerStatus
} from "@shared/contracts";
import type { ImageCacheResolveResult } from "@shared/contracts";
import type {
  PlayerCapabilities,
  PlayerCommand,
  PlayerCommandResult,
  PlayerSnapshot
} from "@shared/player-contract";

const api = {
  platform: process.platform,
  getWindowState: (): Promise<AppWindowState> => ipcRenderer.invoke("window:getState"),
  minimizeWindow: (): Promise<void> => ipcRenderer.invoke("window:minimize"),
  toggleMaximizeWindow: (): Promise<AppWindowState> => ipcRenderer.invoke("window:toggleMaximize"),
  closeWindow: (): Promise<void> => ipcRenderer.invoke("window:close"),
  onWindowStateChanged: (listener: (state: AppWindowState) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: AppWindowState) => listener(state);
    ipcRenderer.on("window:stateChanged", handler);
    return () => ipcRenderer.off("window:stateChanged", handler);
  },
  resolveCachedImageUrl: (sourceUrl: string): Promise<ImageCacheResolveResult> =>
    ipcRenderer.invoke("images:resolveUrl", sourceUrl),
  getDashboard: () => ipcRenderer.invoke("dashboard:get"),
  listNotifications: (): Promise<NotificationRecord[]> => ipcRenderer.invoke("notifications:list"),
  getUnreadNotificationCount: (): Promise<number> => ipcRenderer.invoke("notifications:unreadCount"),
  markNotificationRead: (notificationId: string): Promise<NotificationRecord[]> =>
    ipcRenderer.invoke("notifications:markRead", notificationId),
  markAllNotificationsRead: (): Promise<NotificationRecord[]> => ipcRenderer.invoke("notifications:markAllRead"),
  clearNotifications: (): Promise<NotificationRecord[]> => ipcRenderer.invoke("notifications:clear"),
  listMyAnime: () => ipcRenderer.invoke("myAnime:list"),
  upsertMyAnime: (item: MyAnime) => ipcRenderer.invoke("myAnime:upsert", item),
  removeMyAnime: (itemId: string) => ipcRenderer.invoke("myAnime:remove", itemId),
  listMyAnimeWatchProgress: () => ipcRenderer.invoke("myAnime:listWatchProgress"),
  setAnimeWatchProgress: (input: SetAnimeWatchProgressInput) =>
    ipcRenderer.invoke("myAnime:setWatchProgress", input),
  reportPlaybackProgress: (input: ReportPlaybackProgressInput): Promise<boolean> =>
    ipcRenderer.invoke("playback:reportProgress", input),
  listAnimeCatalog: (year?: number, month?: number): Promise<Anime[]> =>
    ipcRenderer.invoke("animeCatalog:list", year, month),
  searchAnimeCatalog: (keyword: string): Promise<Anime[]> => ipcRenderer.invoke("animeCatalog:search", keyword),
  collectAnimeMonth: (query: AnimeDiscoveryQuery) => ipcRenderer.invoke("animeCatalog:collectMonth", query),
  collectAnimeSeason: (query: AnimeDiscoverySeasonQuery) => ipcRenderer.invoke("animeCatalog:collectSeason", query),
  getAnimeDetail: (animeId: string): Promise<AnimeDetailResult> => ipcRenderer.invoke("animeDetail:get", animeId),
  refreshAnimeDetail: (animeId: string): Promise<AnimeDetailResult> =>
    ipcRenderer.invoke("animeDetail:refresh", animeId),
  listEpisodes: (animeId: string) => ipcRenderer.invoke("episodes:list", animeId),
  upsertEpisode: (episode: Episode) => ipcRenderer.invoke("episodes:upsert", episode),
  listEpisodePreferences: (animeId: string) => ipcRenderer.invoke("episodePreferences:list", animeId),
  upsertEpisodePreference: (preference: EpisodePreference) =>
    ipcRenderer.invoke("episodePreferences:upsert", preference),
  removeEpisodePreference: (episodeId: string) => ipcRenderer.invoke("episodePreferences:remove", episodeId),
  previewEpisodeReleases: (animeId: string, episodeId: string) =>
    ipcRenderer.invoke("automation:previewEpisodeReleases", animeId, episodeId),
  runAutomationOnce: () => ipcRenderer.invoke("automation:runOnce"),
  getAutomationSchedulerStatus: () => ipcRenderer.invoke("automation:getSchedulerStatus"),
  restartAutomationScheduler: () => ipcRenderer.invoke("automation:restartScheduler"),
  listDownloads: () => ipcRenderer.invoke("downloads:list"),
  refreshDownloads: () => ipcRenderer.invoke("downloads:refresh"),
  pauseDownload: (taskId: string) => ipcRenderer.invoke("downloads:pause", taskId),
  resumeDownload: (taskId: string) => ipcRenderer.invoke("downloads:resume", taskId),
  removeDownload: (taskId: string, deleteFiles: boolean) => ipcRenderer.invoke("downloads:remove", taskId, deleteFiles),
  setDownloadFilePriority: (taskId: string, fileIndexes: number[], priority: number) =>
    ipcRenderer.invoke("downloads:setFilePriority", taskId, fileIndexes, priority),
  addDownloadUrl: (input: AddDownloadUrlInput) => ipcRenderer.invoke("downloads:addUrl", input),
  addReleaseDownload: (input: AddReleaseDownloadInput) => ipcRenderer.invoke("downloads:addRelease", input),
  listFansubs: (animeId?: string) => ipcRenderer.invoke("fansubs:list", animeId),
  listSources: () => ipcRenderer.invoke("sources:list"),
  setSourceEnabled: (sourceId: string, enabled: boolean) => ipcRenderer.invoke("sources:setEnabled", sourceId, enabled),
  upsertSource: (source: ReleaseSourceConfig) => ipcRenderer.invoke("sources:upsert", source),
  getSourceSyncStatus: (): Promise<SourceSyncSchedulerStatus> => ipcRenderer.invoke("sources:getSyncStatus"),
  syncSourcesNow: (): Promise<SourceSyncRunResult> => ipcRenderer.invoke("sources:syncNow"),
  getAnimeSourceBindingState: (animeId: string, discoverCandidates = true) =>
    ipcRenderer.invoke("animeSourceBindings:getState", animeId, discoverCandidates),
  confirmAnimeSourceBinding: (input: ConfirmAnimeSourceBindingInput) =>
    ipcRenderer.invoke("animeSourceBindings:confirm", input),
  reportAnimeSourceCandidateMismatch: (input: ReportAnimeSourceCandidateMismatchInput): Promise<void> =>
    ipcRenderer.invoke("animeSourceBindings:reportMismatch", input),
  removeAnimeSourceBinding: (animeId: string, sourceId: string) =>
    ipcRenderer.invoke("animeSourceBindings:remove", animeId, sourceId),
  searchReleases: (query: ReleaseQuery) => ipcRenderer.invoke("releases:search", query),
  searchAnimeReleases: (query: AnimeReleaseQuery) => ipcRenderer.invoke("releases:searchAnime", query),
  searchRssSubscriptionReleases: (query: RssSubscriptionReleaseQuery) =>
    ipcRenderer.invoke("releases:searchRssSubscription", query),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  updateSettings: (patch: Partial<AppSettings>) => ipcRenderer.invoke("settings:update", patch),
  resetSettingsToDefaults: () => ipcRenderer.invoke("settings:resetDefaults"),
  detectPlayers: (profiles?: PlayerProfile[]): Promise<PlayerDetectionResult> =>
    ipcRenderer.invoke("players:detect", profiles),
  selectPlayerExecutable: (input: SelectPlayerExecutableInput): Promise<string | undefined> =>
    ipcRenderer.invoke("players:selectExecutable", input),
  testQbittorrent: () => ipcRenderer.invoke("downloads:testQbittorrent"),
  getQbittorrentManagedStatus: () => ipcRenderer.invoke("downloads:getQbittorrentManagedStatus"),
  startQbittorrentManaged: () => ipcRenderer.invoke("downloads:startQbittorrentManaged"),
  stopQbittorrentManaged: () => ipcRenderer.invoke("downloads:stopQbittorrentManaged"),
  getEmbeddedTorrentStatus: (): Promise<EmbeddedTorrentCoreStatus> =>
    ipcRenderer.invoke("downloads:getEmbeddedTorrentStatus"),
  startEmbeddedTorrent: (): Promise<EmbeddedTorrentCoreStatus> =>
    ipcRenderer.invoke("downloads:startEmbeddedTorrent"),
  stopEmbeddedTorrent: (): Promise<EmbeddedTorrentCoreStatus> =>
    ipcRenderer.invoke("downloads:stopEmbeddedTorrent"),
  restartEmbeddedTorrent: (): Promise<EmbeddedTorrentCoreStatus> =>
    ipcRenderer.invoke("downloads:restartEmbeddedTorrent"),
  listMediaFiles: () => ipcRenderer.invoke("media:list"),
  scanDownloadMedia: (taskId: string) => ipcRenderer.invoke("media:scanDownload", taskId),
  playMedia: (filePath: string, profileId?: string) => ipcRenderer.invoke("media:play", filePath, profileId),
  openDesktopPlayerWindow: (input: DesktopPlayerWindowInput): Promise<void> =>
    ipcRenderer.invoke("media:openPlayerWindow", input),
  closeDesktopPlayerWindow: (): void => ipcRenderer.send("media:closePlayerWindow"),
  createDesktopPlaybackSession: (input: DesktopPlaybackSessionInput): Promise<RemotePlaybackSession> =>
    ipcRenderer.invoke("media:createPlaybackSession", input),
  closeDesktopPlaybackSession: (sessionId: string): Promise<void> =>
    ipcRenderer.invoke("media:closePlaybackSession", sessionId),
  getDesktopPlayerCapabilities: (): Promise<PlayerCapabilities> =>
    ipcRenderer.invoke("player:getCapabilities"),
  dispatchDesktopPlayerCommand: (command: PlayerCommand): Promise<PlayerCommandResult> =>
    ipcRenderer.invoke("player:dispatch", command),
  onDesktopPlayerSnapshot: (listener: (snapshot: PlayerSnapshot) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: PlayerSnapshot) => listener(snapshot);
    ipcRenderer.on("player:snapshot", handler);
    return () => ipcRenderer.off("player:snapshot", handler);
  },
  revealMedia: (filePath: string) => ipcRenderer.invoke("media:reveal", filePath),
  openExternal: (url: string) => ipcRenderer.invoke("platform:openExternal", url),
  getRemoteGatewayStatus: (): Promise<RemoteGatewayStatus> => ipcRenderer.invoke("remote:getStatus"),
  createRemotePairingCode: (): Promise<RemotePairingChallenge> => ipcRenderer.invoke("remote:createPairingCode"),
  revokeRemoteDevice: (deviceId: string): Promise<RemoteGatewayStatus> => ipcRenderer.invoke("remote:revokeDevice", deviceId)
};

contextBridge.exposeInMainWorld("aniBridge", api);

export type AniBridge = typeof api;
