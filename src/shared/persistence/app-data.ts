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
} from "../domain";

export const APP_DATA_VERSION = 19;

export interface AppDataFile {
  version: number;
  settings: AppSettings;
  animeCatalog: Anime[];
  myAnime: MyAnime[];
  episodes: Episode[];
  episodePreferences: EpisodePreference[];
  fansubGroups: FansubGroup[];
  sources: ReleaseSourceConfig[];
  downloads: DownloadTask[];
  mediaFiles: MediaFile[];
  notifications: NotificationRecord[];
  dashboard: DashboardData;
  updatedAt: string;
}

export interface AppDataBackupMeta {
  fileName: string;
  createdAt: string;
  version: number;
}
