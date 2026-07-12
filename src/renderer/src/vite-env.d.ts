/// <reference types="vite/client" />

import type {
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
  AutomationRunResult,
  AutomationSchedulerStatus,
  EpisodeReleasePreview,
  MediaScanResult,
  ReleaseQuery,
  ReleaseSearchResult,
  TorrentConnectionTestResult
} from "@shared/contracts";

declare global {
  interface Window {
    aniBridge: {
      getDashboard: () => Promise<DashboardData>;
      listMyAnime: () => Promise<MyAnime[]>;
      upsertMyAnime: (item: MyAnime) => Promise<MyAnime[]>;
      removeMyAnime: (itemId: string) => Promise<MyAnime[]>;
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
      addReleaseDownload: (release: Release) => Promise<DownloadTask[]>;
      listFansubs: () => Promise<FansubGroup[]>;
      listSources: () => Promise<ReleaseSourceConfig[]>;
      setSourceEnabled: (sourceId: string, enabled: boolean) => Promise<ReleaseSourceConfig[]>;
      upsertSource: (source: ReleaseSourceConfig) => Promise<ReleaseSourceConfig[]>;
      searchReleases: (query: ReleaseQuery) => Promise<ReleaseSearchResult>;
      getSettings: () => Promise<AppSettings>;
      updateSettings: (patch: Partial<AppSettings>) => Promise<AppSettings>;
      testQbittorrent: () => Promise<TorrentConnectionTestResult>;
      listMediaFiles: () => Promise<MediaFile[]>;
      scanDownloadMedia: (taskId: string) => Promise<MediaScanResult>;
      playMedia: (filePath: string, profileId?: string) => Promise<void>;
      revealMedia: (filePath: string) => Promise<void>;
      openExternal: (url: string) => Promise<void>;
    };
  }
}
