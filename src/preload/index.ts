import { contextBridge, ipcRenderer } from "electron";
import type {
  Anime,
  AppSettings,
  Episode,
  EpisodePreference,
  MyAnime,
  NotificationRecord,
  ReleaseSourceConfig
} from "@shared/domain";
import type {
  AddDownloadUrlInput,
  AddReleaseDownloadInput,
  AnimeReleaseQuery,
  AnimeDiscoveryQuery,
  ConfirmAnimeSourceBindingInput,
  ReleaseQuery,
  RssSubscriptionReleaseQuery
} from "@shared/contracts";

const api = {
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
  listAnimeCatalog: (year?: number, month?: number): Promise<Anime[]> =>
    ipcRenderer.invoke("animeCatalog:list", year, month),
  searchAnimeCatalog: (keyword: string): Promise<Anime[]> => ipcRenderer.invoke("animeCatalog:search", keyword),
  collectAnimeMonth: (query: AnimeDiscoveryQuery) => ipcRenderer.invoke("animeCatalog:collectMonth", query),
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
  getAnimeSourceBindingState: (animeId: string, discoverCandidates = true) =>
    ipcRenderer.invoke("animeSourceBindings:getState", animeId, discoverCandidates),
  confirmAnimeSourceBinding: (input: ConfirmAnimeSourceBindingInput) =>
    ipcRenderer.invoke("animeSourceBindings:confirm", input),
  removeAnimeSourceBinding: (animeId: string, sourceId: string) =>
    ipcRenderer.invoke("animeSourceBindings:remove", animeId, sourceId),
  searchReleases: (query: ReleaseQuery) => ipcRenderer.invoke("releases:search", query),
  searchAnimeReleases: (query: AnimeReleaseQuery) => ipcRenderer.invoke("releases:searchAnime", query),
  searchRssSubscriptionReleases: (query: RssSubscriptionReleaseQuery) =>
    ipcRenderer.invoke("releases:searchRssSubscription", query),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  updateSettings: (patch: Partial<AppSettings>) => ipcRenderer.invoke("settings:update", patch),
  resetSettingsToDefaults: () => ipcRenderer.invoke("settings:resetDefaults"),
  testQbittorrent: () => ipcRenderer.invoke("downloads:testQbittorrent"),
  getQbittorrentManagedStatus: () => ipcRenderer.invoke("downloads:getQbittorrentManagedStatus"),
  startQbittorrentManaged: () => ipcRenderer.invoke("downloads:startQbittorrentManaged"),
  stopQbittorrentManaged: () => ipcRenderer.invoke("downloads:stopQbittorrentManaged"),
  listMediaFiles: () => ipcRenderer.invoke("media:list"),
  scanDownloadMedia: (taskId: string) => ipcRenderer.invoke("media:scanDownload", taskId),
  playMedia: (filePath: string, profileId?: string) => ipcRenderer.invoke("media:play", filePath, profileId),
  revealMedia: (filePath: string) => ipcRenderer.invoke("media:reveal", filePath),
  openExternal: (url: string) => ipcRenderer.invoke("platform:openExternal", url)
};

contextBridge.exposeInMainWorld("aniBridge", api);

export type AniBridge = typeof api;
