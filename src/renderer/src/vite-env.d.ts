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
  PlayerProfile,
  ReleaseSourceConfig
} from "@shared/domain";
import type {
  AddDownloadUrlInput,
  AddReleaseDownloadInput,
  AnimeDetailResult,
  AnimeWatchProgress,
  AppWindowState,
  AnimeReleaseQuery,
  AnimeSourceBindingState,
  AnimeDiscoveryQuery,
  AnimeDiscoveryResult,
  AnimeDiscoverySearchResult,
  AnimeDiscoverySeasonQuery,
  AnimeDiscoverySeasonResult,
  AutomationRunResult,
  AutomationSchedulerStatus,
  ConfirmAnimeSourceBindingInput,
  DesktopPlayerWindowDragInput,
  DesktopPlayerWindowInput,
  DesktopPlaybackSessionInput,
  DownloadServiceStatus,
  EmbeddedTorrentCoreStatus,
  EpisodeReleasePreview,
  MediaScanResult,
  PlaybackCheckpoint,
  PlayerDetectionResult,
  QbittorrentManagedStatus,
  ReportPlaybackProgressInput,
  RemoteGatewayStatus,
  RemotePairingChallenge,
  RemotePlaybackSession,
  ReportAnimeSourceCandidateMismatchInput,
  ReleaseQuery,
  ReleaseSearchResult,
  RssSubscriptionReleaseQuery,
  RssSubscriptionReleaseResult,
  SelectPlayerExecutableInput,
  SavePlaybackCheckpointInput,
  SetAnimeWatchProgressInput,
  SourceSyncRunResult,
  SourceSyncSchedulerStatus,
  TorrentConnectionTestResult
} from "@shared/contracts";
import type { ImageCacheResolveResult } from "@shared/contracts";
import type {
  PlayerCapabilities,
  PlayerCommand,
  PlayerCommandResult,
  PlayerSnapshot
} from "@shared/player-contract";

declare global {
  interface Window {
    aniBridge?: {
      platform: string;
      getWindowState: () => Promise<AppWindowState>;
      minimizeWindow: () => Promise<void>;
      toggleMaximizeWindow: () => Promise<AppWindowState>;
      closeWindow: () => Promise<void>;
      onWindowStateChanged: (listener: (state: AppWindowState) => void) => () => void;
      resolveCachedImageUrl: (sourceUrl: string) => Promise<ImageCacheResolveResult>;
      getDashboard: () => Promise<DashboardData>;
      listNotifications: () => Promise<NotificationRecord[]>;
      getUnreadNotificationCount: () => Promise<number>;
      markNotificationRead: (notificationId: string) => Promise<NotificationRecord[]>;
      markAllNotificationsRead: () => Promise<NotificationRecord[]>;
      clearNotifications: () => Promise<NotificationRecord[]>;
      listMyAnime: () => Promise<MyAnime[]>;
      upsertMyAnime: (item: MyAnime) => Promise<MyAnime[]>;
      removeMyAnime: (itemId: string) => Promise<MyAnime[]>;
      listMyAnimeWatchProgress: () => Promise<AnimeWatchProgress[]>;
      setAnimeWatchProgress: (input: SetAnimeWatchProgressInput) => Promise<AnimeWatchProgress>;
      reportPlaybackProgress: (input: ReportPlaybackProgressInput) => Promise<boolean>;
      savePlaybackCheckpoint: (input: SavePlaybackCheckpointInput) => Promise<PlaybackCheckpoint>;
      listAnimeCatalog: (year?: number, month?: number) => Promise<Anime[]>;
      searchAnimeCatalog: (keyword: string) => Promise<AnimeDiscoverySearchResult>;
      collectAnimeMonth: (query: AnimeDiscoveryQuery) => Promise<AnimeDiscoveryResult>;
      collectAnimeSeason: (query: AnimeDiscoverySeasonQuery) => Promise<AnimeDiscoverySeasonResult>;
      getAnimeDetail: (animeId: string) => Promise<AnimeDetailResult>;
      refreshAnimeDetail: (animeId: string) => Promise<AnimeDetailResult>;
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
      listFansubs: (animeId?: string) => Promise<FansubGroup[]>;
      listSources: () => Promise<ReleaseSourceConfig[]>;
      setSourceEnabled: (sourceId: string, enabled: boolean) => Promise<ReleaseSourceConfig[]>;
      upsertSource: (source: ReleaseSourceConfig) => Promise<ReleaseSourceConfig[]>;
      getSourceSyncStatus: () => Promise<SourceSyncSchedulerStatus>;
      syncSourcesNow: () => Promise<SourceSyncRunResult>;
      getAnimeSourceBindingState: (animeId: string, discoverCandidates?: boolean) => Promise<AnimeSourceBindingState>;
      confirmAnimeSourceBinding: (input: ConfirmAnimeSourceBindingInput) => Promise<AnimeSourceBindingState>;
      reportAnimeSourceCandidateMismatch: (input: ReportAnimeSourceCandidateMismatchInput) => Promise<void>;
      removeAnimeSourceBinding: (animeId: string, sourceId: string) => Promise<AnimeSourceBindingState>;
      searchReleases: (query: ReleaseQuery) => Promise<ReleaseSearchResult>;
      searchAnimeReleases: (query: AnimeReleaseQuery) => Promise<ReleaseSearchResult>;
      searchRssSubscriptionReleases: (query: RssSubscriptionReleaseQuery) => Promise<RssSubscriptionReleaseResult>;
      getSettings: () => Promise<AppSettings>;
      updateSettings: (patch: Partial<AppSettings>) => Promise<AppSettings>;
      resetSettingsToDefaults: () => Promise<AppSettings>;
      detectPlayers: (profiles?: PlayerProfile[]) => Promise<PlayerDetectionResult>;
      selectPlayerExecutable: (input: SelectPlayerExecutableInput) => Promise<string | undefined>;
      testQbittorrent: () => Promise<TorrentConnectionTestResult>;
      getDownloadServiceStatus: () => Promise<DownloadServiceStatus>;
      onDownloadServiceStatusChanged: (listener: () => void) => () => void;
      getQbittorrentManagedStatus: () => Promise<QbittorrentManagedStatus>;
      startQbittorrentManaged: () => Promise<QbittorrentManagedStatus>;
      stopQbittorrentManaged: () => Promise<QbittorrentManagedStatus>;
      getEmbeddedTorrentStatus: () => Promise<EmbeddedTorrentCoreStatus>;
      startEmbeddedTorrent: () => Promise<EmbeddedTorrentCoreStatus>;
      stopEmbeddedTorrent: () => Promise<EmbeddedTorrentCoreStatus>;
      restartEmbeddedTorrent: () => Promise<EmbeddedTorrentCoreStatus>;
      listMediaFiles: () => Promise<MediaFile[]>;
      scanDownloadMedia: (taskId: string) => Promise<MediaScanResult>;
      playMedia: (filePath: string, profileId?: string) => Promise<void>;
      openDesktopPlayerWindow: (input: DesktopPlayerWindowInput) => Promise<void>;
      closeDesktopPlayerWindow: () => void;
      dragDesktopPlayerWindow: (input: DesktopPlayerWindowDragInput) => void;
      createDesktopPlaybackSession: (input: DesktopPlaybackSessionInput) => Promise<RemotePlaybackSession>;
      closeDesktopPlaybackSession: (sessionId: string) => Promise<void>;
      getDesktopPlayerCapabilities: () => Promise<PlayerCapabilities>;
      dispatchDesktopPlayerCommand: (command: PlayerCommand) => Promise<PlayerCommandResult>;
      onDesktopPlayerSnapshot: (listener: (snapshot: PlayerSnapshot) => void) => () => void;
      revealMedia: (filePath: string) => Promise<void>;
      openExternal: (url: string) => Promise<void>;
      getRemoteGatewayStatus: () => Promise<RemoteGatewayStatus>;
      createRemotePairingCode: () => Promise<RemotePairingChallenge>;
      revokeRemoteDevice: (deviceId: string) => Promise<RemoteGatewayStatus>;
    };
  }
}

interface ImportMetaEnv {
  readonly VITE_ANI_REMOTE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
