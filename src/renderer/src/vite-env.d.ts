/// <reference types="vite/client" />

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
  NotificationRecord,
  ReleaseSourceConfig
} from "@shared/domain";
import type {
  AddDownloadUrlInput,
  AddReleaseDownloadInput,
  AnimeDiscoveryQuery,
  AnimeDiscoveryResult,
  AutomationRunResult,
  AutomationSchedulerStatus,
  EpisodeReleasePreview,
  MediaScanResult,
  QbittorrentManagedStatus,
  ReleaseQuery,
  ReleaseSearchResult,
  TorrentConnectionTestResult
} from "@shared/contracts";

declare global {
  interface Window {
    aniBridge: {
      getDashboard: () => Promise<DashboardData>;
      listNotifications: () => Promise<NotificationRecord[]>;
      getUnreadNotificationCount: () => Promise<number>;
      markNotificationRead: (notificationId: string) => Promise<NotificationRecord[]>;
      markAllNotificationsRead: () => Promise<NotificationRecord[]>;
      clearNotifications: () => Promise<NotificationRecord[]>;
      listMyAnime: () => Promise<MyAnime[]>;
      upsertMyAnime: (item: MyAnime) => Promise<MyAnime[]>;
      removeMyAnime: (itemId: string) => Promise<MyAnime[]>;
      listAnimeCatalog: (year?: number, month?: number) => Promise<Anime[]>;
      searchAnimeCatalog: (keyword: string) => Promise<Anime[]>;
      collectAnimeMonth: (query: AnimeDiscoveryQuery) => Promise<AnimeDiscoveryResult>;
      listEpisodes: (animeId: string) => Promise<Episode[]>;
      upsertEpisode: (episode: Episode) => Promise<Episode[]>;
      listEpisodePreferences: (animeId: string) => Promise<EpisodePreference[]>;
      upsertEpisodePreference: (preference: EpisodePreference) => Promise<EpisodePreference[]>;
      removeEpisodePreference: (episodeId: string) => Promise<EpisodePreference[]>;
      previewEpisodeReleases: (animeId: string, episodeId: string) => Promise<EpisodeReleasePreview>;
      runAutomationOnce: () => Promise<AutomationRunResult>;
      getAutomationSchedulerStatus: () => Promise<AutomationSchedulerStatus>;
      restartAutomationScheduler: () => Promise<AutomationSchedulerStatus>;
      listDownloads: () => Promise<DownloadTask[]>;
      refreshDownloads: () => Promise<DownloadTask[]>;
      pauseDownload: (taskId: string) => Promise<DownloadTask[]>;
      resumeDownload: (taskId: string) => Promise<DownloadTask[]>;
      removeDownload: (taskId: string, deleteFiles: boolean) => Promise<DownloadTask[]>;
      setDownloadFilePriority: (taskId: string, fileIndexes: number[], priority: number) => Promise<DownloadTask[]>;
      addDownloadUrl: (input: AddDownloadUrlInput) => Promise<DownloadTask[]>;
      addReleaseDownload: (input: AddReleaseDownloadInput) => Promise<DownloadTask[]>;
      listFansubs: () => Promise<FansubGroup[]>;
      listSources: () => Promise<ReleaseSourceConfig[]>;
      setSourceEnabled: (sourceId: string, enabled: boolean) => Promise<ReleaseSourceConfig[]>;
      upsertSource: (source: ReleaseSourceConfig) => Promise<ReleaseSourceConfig[]>;
      searchReleases: (query: ReleaseQuery) => Promise<ReleaseSearchResult>;
      getSettings: () => Promise<AppSettings>;
      updateSettings: (patch: Partial<AppSettings>) => Promise<AppSettings>;
      resetSettingsToDefaults: () => Promise<AppSettings>;
      testQbittorrent: () => Promise<TorrentConnectionTestResult>;
      getQbittorrentManagedStatus: () => Promise<QbittorrentManagedStatus>;
      startQbittorrentManaged: () => Promise<QbittorrentManagedStatus>;
      stopQbittorrentManaged: () => Promise<QbittorrentManagedStatus>;
      listMediaFiles: () => Promise<MediaFile[]>;
      scanDownloadMedia: (taskId: string) => Promise<MediaScanResult>;
      playMedia: (filePath: string, profileId?: string) => Promise<void>;
      revealMedia: (filePath: string) => Promise<void>;
      openExternal: (url: string) => Promise<void>;
    };
  }
}
