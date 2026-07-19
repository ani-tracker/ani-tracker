import type {
  Anime,
  DashboardData,
  DownloadTask,
  Episode,
  EpisodePreference,
  FansubGroup,
  MediaFile,
  MyAnime,
  NotificationRecord
} from "@shared/domain";
import type { AnimeDetailResult } from "@shared/contracts";

const HIDDEN_LOCAL_PATH = "本机路径已隐藏";
const WINDOWS_PATH_PATTERN = /(?:[a-zA-Z]:\\|\\\\)[^\s，。；、]+/g;
const UNIX_PATH_PATTERN = /(?:^|\s)\/(?:Users|home|var|private|Volumes|mnt|media)\/[^\s，。；、]+/g;
const URL_PATTERN = /\b(?:https?|ftp):\/\/[^\s，。；、]+/gi;

/** 远程端可读取的追番 DTO，不包含下载目录和 RSS 地址。 */
export type RemoteMyAnime = Omit<MyAnime, "downloadDir" | "rssSubscriptions">;

/** 远程端可读取的下载 DTO，不包含哈希、关联标签和真实保存路径。 */
export type RemoteDownloadTask = Omit<DownloadTask, "torrentHash" | "correlationTag" | "savePath"> & {
  savePath: string;
};

/** 远程端可读取的媒体 DTO，不包含真实文件路径。 */
export type RemoteMediaFile = Omit<MediaFile, "filePath"> & {
  filePath: string;
};

/** 远程端首页 DTO，对嵌套的下载和媒体记录强制脱敏。 */
export type RemoteDashboardData = Omit<DashboardData, "activeDownloads" | "recentCompleted"> & {
  activeDownloads: RemoteDownloadTask[];
  recentCompleted: RemoteMediaFile[];
};

export type RemoteAnimeDetailResult = Omit<AnimeDetailResult, "anime" | "myAnime" | "partialErrors"> & {
  anime: Anime;
  myAnime?: RemoteMyAnime;
  partialErrors: AnimeDetailResult["partialErrors"];
};

/** 将追番记录转换为远程安全 DTO。 */
export function sanitizeMyAnimeList(value: unknown): RemoteMyAnime[] {
  return requireArray<MyAnime>(value, "追番列表").map((item) => ({
    id: item.id,
    anime: sanitizeAnime(item.anime),
    status: item.status,
    defaultFansubGroupId: item.defaultFansubGroupId,
    autoDownload: item.autoDownload,
    preferredResolution: item.preferredResolution,
    preferredCodec: item.preferredCodec,
    preferredBitDepth: item.preferredBitDepth,
    preferredSubtitleLanguages: item.preferredSubtitleLanguages,
    preferredSubtitle: item.preferredSubtitle,
    addedAt: item.addedAt,
    updatedAt: item.updatedAt
  }));
}

/** 将下载记录转换为远程安全 DTO。 */
export function sanitizeDownloadList(value: unknown): RemoteDownloadTask[] {
  return requireArray<DownloadTask>(value, "下载列表").map(sanitizeDownloadTask);
}

/** 将首页看板转换为远程安全 DTO。 */
export function sanitizeDashboard(value: unknown): RemoteDashboardData {
  const dashboard = requireRecord<DashboardData>(value, "首页看板");
  return {
    dailyReminder: dashboard.dailyReminder,
    todayEpisodes: dashboard.todayEpisodes,
    pendingActions: dashboard.pendingActions,
    activeDownloads: requireArray<DownloadTask>(dashboard.activeDownloads, "首页下载列表").map(
      sanitizeDownloadTask
    ),
    recentCompleted: requireArray<MediaFile>(dashboard.recentCompleted, "最近完成列表").map(sanitizeMediaFile),
    weeklySchedule: dashboard.weeklySchedule,
    sourceHealth: dashboard.sourceHealth
  };
}

/** 将通知文本中的 URL 和本地路径替换为安全占位符。 */
export function sanitizeNotificationList(value: unknown): NotificationRecord[] {
  return requireArray<NotificationRecord>(value, "通知列表").map((item) => ({
    id: item.id,
    kind: item.kind,
    title: redactFreeText(item.title),
    body: redactFreeText(item.body),
    severity: item.severity,
    animeId: item.animeId,
    episodeId: item.episodeId,
    downloadTaskId: item.downloadTaskId,
    createdAt: item.createdAt,
    readAt: item.readAt
  }));
}

/** 将番剧目录转换为字段白名单 DTO。 */
export function sanitizeAnimeList(value: unknown): Anime[] {
  return requireArray<Anime>(value, "番剧目录").map(sanitizeAnime);
}

/** 将番剧详情转换为远程只读 DTO，并沿用目录字段白名单。 */
export function sanitizeAnimeDetailResult(value: unknown): RemoteAnimeDetailResult {
  const result = requireRecord<AnimeDetailResult>(value, "番剧详情");
  const myAnime = result.myAnime ? sanitizeMyAnimeList([result.myAnime])[0] : undefined;
  return {
    anime: sanitizeAnime(result.anime),
    myAnime,
    episodes: sanitizeEpisodeList(result.episodes),
    fansubGroups: sanitizeFansubList(result.fansubGroups),
    stale: Boolean(result.stale),
    partialErrors: requireArray<AnimeDetailResult["partialErrors"][number]>(result.partialErrors, "详情来源错误").map(
      (error) => ({ source: redactFreeText(error.source), message: redactFreeText(error.message) })
    )
  };
}

/** 将字幕组列表转换为字段白名单 DTO。 */
export function sanitizeFansubList(value: unknown): FansubGroup[] {
  return requireArray<FansubGroup>(value, "字幕组列表").map((item) => ({
    id: item.id,
    name: item.name,
    aliases: [...item.aliases],
    sourceIds: [...item.sourceIds]
  }));
}

/** 将单集列表转换为字段白名单 DTO。 */
export function sanitizeEpisodeList(value: unknown): Episode[] {
  return requireArray<Episode>(value, "单集列表").map((item) => ({
    id: item.id,
    animeId: item.animeId,
    episodeNo: item.episodeNo,
    title: item.title,
    airTime: item.airTime,
    status: item.status
  }));
}

/** 将单集偏好转换为字段白名单 DTO。 */
export function sanitizeEpisodePreferenceList(value: unknown): EpisodePreference[] {
  return requireArray<EpisodePreference>(value, "单集偏好列表").map((item) => ({
    id: item.id,
    animeId: item.animeId,
    episodeId: item.episodeId,
    fansubGroupId: item.fansubGroupId,
    releaseId: item.releaseId,
    isManualOverride: item.isManualOverride
  }));
}

/** 校验并返回远程只读计数结果。 */
export function sanitizeCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("未读数量返回格式无效");
  }
  return value;
}

function sanitizeAnime(item: Anime): Anime {
  return {
    id: item.id,
    title: item.title,
    originalTitle: item.originalTitle,
    aliases: item.aliases.map((alias) => ({
      id: alias.id,
      animeId: alias.animeId,
      alias: alias.alias,
      language: alias.language,
      priority: alias.priority
    })),
    premiereDate: item.premiereDate,
    premiereYear: item.premiereYear,
    premiereMonth: item.premiereMonth,
    season: item.season,
    summary: item.summary,
    coverUrl: item.coverUrl,
    rating: item.rating
      ? {
          score: item.rating.score,
          count: item.rating.count,
          source: item.rating.source
        }
      : undefined,
    externalIds: { ...item.externalIds },
    detail: item.detail
      ? {
          ...item.detail,
          genres: item.detail.genres ? [...item.detail.genres] : undefined,
          studios: item.detail.studios ? [...item.detail.studios] : undefined,
          staff: item.detail.staff?.map((credit) => ({ ...credit })),
          metadataSources: item.detail.metadataSources ? [...item.detail.metadataSources] : undefined
        }
      : undefined
  };
}

function sanitizeDownloadTask(item: DownloadTask): RemoteDownloadTask {
  return {
    id: item.id,
    releaseId: item.releaseId,
    animeId: item.animeId,
    episodeId: item.episodeId,
    animeTitle: item.animeTitle,
    episodeNo: item.episodeNo,
    fansubGroupId: item.fansubGroupId,
    fansubName: item.fansubName,
    resolution: item.resolution,
    declaredVideoCodec: item.declaredVideoCodec,
    normalizedVideoCodec: item.normalizedVideoCodec,
    bitDepth: item.bitDepth,
    subtitleLanguages: item.subtitleLanguages,
    subtitle: item.subtitle,
    engine: item.engine,
    name: item.name,
    status: item.status,
    progress: item.progress,
    downloadSpeed: item.downloadSpeed,
    uploadSpeed: item.uploadSpeed,
    etaSeconds: item.etaSeconds,
    savePath: HIDDEN_LOCAL_PATH,
    files: item.files.map((file) => ({
      id: file.id,
      index: file.index,
      name: file.name,
      size: file.size,
      progress: file.progress,
      priority: file.priority,
      selected: file.selected
    })),
    createdAt: item.createdAt,
    completedAt: item.completedAt
  };
}

function sanitizeMediaFile(item: MediaFile): RemoteMediaFile {
  return {
    id: item.id,
    animeId: item.animeId,
    episodeId: item.episodeId,
    downloadTaskId: item.downloadTaskId,
    filePath: HIDDEN_LOCAL_PATH,
    fileName: item.fileName,
    size: item.size,
    container: item.container,
    declaredVideoCodec: item.declaredVideoCodec,
    detectedVideoCodec: item.detectedVideoCodec,
    normalizedVideoCodec: item.normalizedVideoCodec,
    resolution: item.resolution,
    bitDepth: item.bitDepth,
    audioCodecs: [...item.audioCodecs],
    subtitleTracks: [...item.subtitleTracks],
    durationSeconds: item.durationSeconds,
    downloadedAt: item.downloadedAt,
    probedAt: item.probedAt
  };
}

function redactFreeText(value: string): string {
  return value
    .replace(URL_PATTERN, "[链接已隐藏]")
    .replace(WINDOWS_PATH_PATTERN, "[本机路径已隐藏]")
    .replace(UNIX_PATH_PATTERN, (match) => `${match.startsWith(" ") ? " " : ""}[本机路径已隐藏]`);
}

function requireArray<T>(value: unknown, label: string): T[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label}返回格式无效`);
  }
  return value as T[];
}

function requireRecord<T extends object>(value: unknown, label: string): T {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label}返回格式无效`);
  }
  return value as T;
}
