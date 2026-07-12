import type {
  Anime,
  AppSettings,
  DashboardData,
  DownloadTask,
  Episode,
  EpisodePreference,
  FansubGroup,
  MediaFile,
  MyAnime,
  Release,
  ReleaseSourceConfig
} from "@shared/domain";
import type {
  AnimeDiscoveryQuery,
  AnimeDiscoveryResult,
  AutomationRunResult,
  AutomationSchedulerStatus,
  EpisodeReleasePreview,
  MediaScanResult,
  ReleaseQuery,
  ReleaseSearchResult,
  TorrentConnectionTestResult
} from "@shared/contracts";

function bridge() {
  if (!window.aniBridge) {
    throw new Error("Ani bridge is not available. Run the app inside Electron.");
  }

  return window.aniBridge;
}

export const appApi = {
  getDashboard: (): Promise<DashboardData> => bridge().getDashboard(),
  listMyAnime: (): Promise<MyAnime[]> => bridge().listMyAnime(),
  upsertMyAnime: (item: MyAnime): Promise<MyAnime[]> => bridge().upsertMyAnime(item),
  removeMyAnime: (itemId: string): Promise<MyAnime[]> => bridge().removeMyAnime(itemId),
  listAnimeCatalog: (year?: number, month?: number): Promise<Anime[]> => bridge().listAnimeCatalog(year, month),
  searchAnimeCatalog: (keyword: string): Promise<Anime[]> => bridge().searchAnimeCatalog(keyword),
  collectAnimeMonth: (query: AnimeDiscoveryQuery): Promise<AnimeDiscoveryResult> => bridge().collectAnimeMonth(query),
  listEpisodes: (animeId: string): Promise<Episode[]> => bridge().listEpisodes(animeId),
  upsertEpisode: (episode: Episode): Promise<Episode[]> => bridge().upsertEpisode(episode),
  listEpisodePreferences: (animeId: string): Promise<EpisodePreference[]> =>
    bridge().listEpisodePreferences(animeId),
  upsertEpisodePreference: (preference: EpisodePreference): Promise<EpisodePreference[]> =>
    bridge().upsertEpisodePreference(preference),
  removeEpisodePreference: (episodeId: string): Promise<EpisodePreference[]> =>
    bridge().removeEpisodePreference(episodeId),
  previewEpisodeReleases: (animeId: string, episodeId: string): Promise<EpisodeReleasePreview> =>
    bridge().previewEpisodeReleases(animeId, episodeId),
  runAutomationOnce: (): Promise<AutomationRunResult> => bridge().runAutomationOnce(),
  getAutomationSchedulerStatus: (): Promise<AutomationSchedulerStatus> => bridge().getAutomationSchedulerStatus(),
  restartAutomationScheduler: (): Promise<AutomationSchedulerStatus> => bridge().restartAutomationScheduler(),
  listDownloads: (): Promise<DownloadTask[]> => bridge().listDownloads(),
  refreshDownloads: (): Promise<DownloadTask[]> => bridge().refreshDownloads(),
  pauseDownload: (taskId: string): Promise<DownloadTask[]> => bridge().pauseDownload(taskId),
  resumeDownload: (taskId: string): Promise<DownloadTask[]> => bridge().resumeDownload(taskId),
  removeDownload: (taskId: string, deleteFiles: boolean): Promise<DownloadTask[]> =>
    bridge().removeDownload(taskId, deleteFiles),
  setDownloadFilePriority: (taskId: string, fileIndexes: number[], priority: number): Promise<DownloadTask[]> =>
    bridge().setDownloadFilePriority(taskId, fileIndexes, priority),
  addReleaseDownload: (release: Release): Promise<DownloadTask[]> => bridge().addReleaseDownload(release),
  listFansubs: (): Promise<FansubGroup[]> => bridge().listFansubs(),
  listSources: (): Promise<ReleaseSourceConfig[]> => bridge().listSources(),
  setSourceEnabled: (sourceId: string, enabled: boolean): Promise<ReleaseSourceConfig[]> =>
    bridge().setSourceEnabled(sourceId, enabled),
  upsertSource: (source: ReleaseSourceConfig): Promise<ReleaseSourceConfig[]> => bridge().upsertSource(source),
  searchReleases: (query: ReleaseQuery): Promise<ReleaseSearchResult> => bridge().searchReleases(query),
  getSettings: (): Promise<AppSettings> => bridge().getSettings(),
  updateSettings: (patch: Partial<AppSettings>): Promise<AppSettings> => bridge().updateSettings(patch),
  testQbittorrent: (): Promise<TorrentConnectionTestResult> => bridge().testQbittorrent(),
  listMediaFiles: (): Promise<MediaFile[]> => bridge().listMediaFiles(),
  scanDownloadMedia: (taskId: string): Promise<MediaScanResult> => bridge().scanDownloadMedia(taskId),
  playMedia: (filePath: string, profileId?: string): Promise<void> => bridge().playMedia(filePath, profileId),
  revealMedia: (filePath: string): Promise<void> => bridge().revealMedia(filePath)
};
