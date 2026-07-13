import type {
  Anime,
  AppSettings,
  DownloadTask,
  Episode,
  FansubGroup,
  MediaFile,
  Release,
  ReleaseSourceConfig,
  Season,
  TorrentFile
} from "./domain";

export interface AnimeSearchQuery {
  keyword: string;
  includeAliases?: boolean;
}

export interface AnimeDiscoveryQuery {
  year: number;
  month: number;
  forceRefresh?: boolean;
}

export interface AnimeDiscoveryResult {
  query: AnimeDiscoveryQuery;
  items: Anime[];
  addedCount: number;
  existingCount: number;
  source: string;
  errors: string[];
}

export interface ReleaseQuery {
  keyword: string;
  animeId?: string;
  episodeNo?: number;
  fansubGroupId?: string;
  preferredResolution?: string;
  limit?: number;
}

export interface ReleaseSearchResult {
  query: ReleaseQuery;
  releases: Release[];
  searchedSourceIds: string[];
  errors: Array<{
    sourceId: string;
    message: string;
  }>;
}

export interface AddDownloadUrlInput {
  url: string;
  name?: string;
  savePath?: string;
  paused?: boolean;
}

export interface AddReleaseDownloadInput {
  release: Release;
  animeId?: string;
  episodeId?: string;
  episodeNo?: number;
  fansubGroupId?: string;
  savePath?: string;
  paused?: boolean;
}

export interface AddTorrentOptions {
  savePath: string;
  selectedFileIndexes?: number[];
  category?: string;
  paused?: boolean;
}

export interface TorrentConnectionTestResult {
  ok: boolean;
  message: string;
  taskCount?: number;
}

export interface QbittorrentManagedStatus {
  enabled: boolean;
  autoStart: boolean;
  running: boolean;
  webUiUrl: string;
  platform: string;
  arch: string;
  binaryPath?: string;
  profileDir?: string;
  pid?: number;
  lastStartedAt?: string;
  lastStoppedAt?: string;
  lastError?: string;
}

export interface MediaExtractInput {
  release?: Release;
  filePath?: string;
  fileName?: string;
}

export interface MediaProbeContext {
  animeId?: string;
  episodeId?: string;
  downloadTaskId?: string;
  release?: Release;
  size?: number;
  downloadedAt?: string;
}

export interface PartialMediaInfo {
  container?: MediaFile["container"];
  declaredVideoCodec?: string;
  detectedVideoCodec?: string;
  normalizedVideoCodec?: MediaFile["normalizedVideoCodec"];
  resolution?: string;
  bitDepth?: number;
  audioCodecs?: string[];
  subtitleTracks?: string[];
  durationSeconds?: number;
  confidence: number;
  source: string;
}

export interface MediaScanResult {
  taskId: string;
  mediaFiles: MediaFile[];
  skippedFiles: Array<{
    name: string;
    reason: string;
  }>;
  errors: Array<{
    filePath: string;
    message: string;
  }>;
}

export interface EpisodeReleaseCandidate {
  release: Release;
  score: number;
  reasons: string[];
}

export interface EpisodeReleasePreview {
  animeId: string;
  episodeId: string;
  searchedTerms: string[];
  candidates: EpisodeReleaseCandidate[];
  errors: ReleaseSearchResult["errors"];
}

export interface AutomationRunResult {
  startedAt: string;
  finishedAt: string;
  checkedEpisodes: number;
  downloaded: Array<{
    animeId: string;
    animeTitle: string;
    episodeId: string;
    episodeNo: number;
    releaseId: string;
    releaseTitle: string;
    downloadTaskId: string;
  }>;
  skipped: Array<{
    animeId: string;
    animeTitle: string;
    episodeId?: string;
    episodeNo?: number;
    reason: string;
  }>;
  errors: Array<{
    animeId?: string;
    animeTitle?: string;
    episodeId?: string;
    episodeNo?: number;
    message: string;
  }>;
}

export interface AutomationSchedulerStatus {
  enabled: boolean;
  running: boolean;
  inFlight: boolean;
  intervalMinutes: number;
  nextRunAt?: string;
  manualCooldownUntil?: string;
  lastRunAt?: string;
  lastResult?: AutomationRunResult;
  lastError?: string;
}

export interface MetadataProvider {
  searchAnime(query: AnimeSearchQuery): Promise<Anime[]>;
  getSeasonAnime(year: number, season: Season): Promise<Anime[]>;
  getAnimeDetail(id: string): Promise<Anime>;
}

export interface ReleaseSource {
  config: ReleaseSourceConfig;
  searchReleases(query: ReleaseQuery): Promise<Release[]>;
  listLatestByFansub(groupId: string): Promise<Release[]>;
  listLatestByAnime(animeId: string): Promise<Release[]>;
}

export interface TorrentEngine {
  addMagnet(magnetUrl: string, options: AddTorrentOptions): Promise<DownloadTask>;
  addTorrentFile(filePath: string, options: AddTorrentOptions): Promise<DownloadTask>;
  listTasks(): Promise<DownloadTask[]>;
  getTask(taskId: string): Promise<DownloadTask>;
  getFiles(taskId: string): Promise<TorrentFile[]>;
  setFilePriority(taskId: string, fileIndexes: number[], priority: number): Promise<void>;
  pause(taskId: string): Promise<void>;
  resume(taskId: string): Promise<void>;
  remove(taskId: string, deleteFiles: boolean): Promise<void>;
}

export interface MediaInfoExtractor {
  name: string;
  extract(input: MediaExtractInput): Promise<PartialMediaInfo | null>;
}

export interface MediaProbeService {
  probe(filePath: string, context?: MediaProbeContext): Promise<MediaFile>;
  extractFromChain(input: MediaExtractInput): Promise<PartialMediaInfo>;
}

export interface PlayerService {
  play(filePath: string, profileId?: string): Promise<void>;
  reveal(filePath: string): Promise<void>;
}

export interface PlatformService {
  getDefaultDownloadDir(): Promise<string>;
  getAppDataDir(): Promise<string>;
  openFolder(path: string): Promise<void>;
  revealFile(path: string): Promise<void>;
}

export interface NotificationService {
  notify(title: string, body: string): Promise<void>;
}

export interface SettingsService {
  getSettings(): Promise<AppSettings>;
  updateSettings(settings: Partial<AppSettings>): Promise<AppSettings>;
  resetSettingsToDefaults(): Promise<AppSettings>;
}

export interface FansubService {
  listGroups(): Promise<FansubGroup[]>;
  upsertGroup(group: FansubGroup): Promise<FansubGroup>;
}
