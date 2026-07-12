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
  ReleaseSourceConfig
} from "../domain";

export const APP_DATA_VERSION = 5;

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
  dashboard: DashboardData;
  updatedAt: string;
}

export interface AppDataBackupMeta {
  fileName: string;
  createdAt: string;
  version: number;
}
