import type {
  Anime,
  AnimeSourceBinding,
  AnimeSourceExclusion,
  AppSettings,
  DailyReminderItem,
  DashboardData,
  DownloadStatus,
  DownloadTask,
  Episode,
  EpisodePreference,
  FansubGroup,
  MediaFile,
  MyAnime,
  NotificationRecord,
  Release,
  RequestCircuitState,
  ReleaseSourceConfig,
  ReleaseSourceSyncState
} from "@shared/domain";
import type {
  AnimeWatchProgress,
  PlaybackCheckpoint,
  ReleaseSearchResult,
  SetAnimeWatchProgressInput
} from "@shared/contracts";
import {
  isActiveDownloadStatus,
  isCompletedDownloadTask
} from "@shared/download-status";
import type { AppDataFile } from "@shared/persistence/app-data";

export { mergeSettings } from "@shared/settings";

export interface ReleaseSearchCacheEntry {
  expiresAt: string;
  result: ReleaseSearchResult;
}

/** 约束持久化资源缓存的来源、番剧和返回数量。 */
export interface CachedReleaseQuery {
  sourceIds?: string[];
  animeId?: string;
  limit?: number;
}

/** 定义主进程业务服务使用的应用数据访问能力。 */
export interface AppRepository {
  getDashboard(): Promise<DashboardData>;
  listMyAnime(): Promise<MyAnime[]>;
  listAnimeCatalog(): Promise<Anime[]>;
  getAnimeCatalogById(animeId: string): Promise<Anime | undefined>;
  listNotifications(): Promise<NotificationRecord[]>;
  getUnreadNotificationCount(): Promise<number>;
  addNotifications(records: NotificationRecord[]): Promise<NotificationRecord[]>;
  markNotificationRead(notificationId: string): Promise<NotificationRecord[]>;
  markAllNotificationsRead(): Promise<NotificationRecord[]>;
  clearNotifications(): Promise<NotificationRecord[]>;
  searchAnimeCatalog(keyword: string): Promise<Anime[]>;
  listAnimeCatalogByMonth(year: number, month: number): Promise<Anime[]>;
  upsertAnimeCatalog(items: Anime[]): Promise<{ items: Anime[]; addedCount: number; existingCount: number }>;
  replaceAnimeCatalogMonth(
    year: number,
    month: number,
    items: Anime[]
  ): Promise<{ items: Anime[]; addedCount: number; existingCount: number }>;
  clearAnimeCatalog(): Promise<void>;
  listAnimeSourceBindings(animeId: string): Promise<AnimeSourceBinding[]>;
  upsertAnimeSourceBinding(binding: AnimeSourceBinding): Promise<AnimeSourceBinding[]>;
  removeAnimeSourceBinding(animeId: string, sourceId: string): Promise<AnimeSourceBinding[]>;
  listAnimeSourceExclusions(animeId: string): Promise<AnimeSourceExclusion[]>;
  upsertAnimeSourceExclusion(exclusion: AnimeSourceExclusion): Promise<AnimeSourceExclusion[]>;
  removeAnimeSourceExclusion(animeId: string, sourceId: string, sourceAnimeId?: string): Promise<AnimeSourceExclusion[]>;
  listDownloads(): Promise<DownloadTask[]>;
  listEpisodes(animeId: string): Promise<Episode[]>;
  upsertEpisode(episode: Episode): Promise<Episode[]>;
  listMyAnimeWatchProgress(): Promise<AnimeWatchProgress[]>;
  setAnimeWatchProgress(input: SetAnimeWatchProgressInput): Promise<AnimeWatchProgress>;
  getPlaybackCheckpoint(taskId: string, fileIndex?: number): Promise<PlaybackCheckpoint | undefined>;
  upsertPlaybackCheckpoint(checkpoint: PlaybackCheckpoint): Promise<PlaybackCheckpoint>;
  listEpisodePreferences(animeId: string): Promise<EpisodePreference[]>;
  upsertEpisodePreference(preference: EpisodePreference): Promise<EpisodePreference[]>;
  removeEpisodePreference(episodeId: string): Promise<EpisodePreference[]>;
  getDownloadTask(taskId: string): Promise<DownloadTask | undefined>;
  upsertDownloadTask(task: DownloadTask): Promise<DownloadTask[]>;
  mergeDownloadTasksFromEngine(tasks: DownloadTask[]): Promise<DownloadTask[]>;
  updateDownloadStatus(taskId: string, status: DownloadStatus): Promise<DownloadTask[]>;
  removeDownloadTask(taskId: string): Promise<DownloadTask[]>;
  listMediaFiles(): Promise<MediaFile[]>;
  upsertMediaFiles(mediaFiles: MediaFile[]): Promise<MediaFile[]>;
  listFansubs(animeId?: string): Promise<FansubGroup[]>;
  observeAnimeFansubs(animeId: string, releases: Release[]): Promise<FansubGroup[]>;
  listSources(): Promise<ReleaseSourceConfig[]>;
  getSettings(): Promise<AppSettings>;
  updateSettings(patch: Partial<AppSettings>): Promise<AppSettings>;
  resetSettingsToDefaults(): Promise<AppSettings>;
  updateSourceEnabled(sourceId: string, enabled: boolean): Promise<ReleaseSourceConfig[]>;
  upsertSource(source: ReleaseSourceConfig): Promise<ReleaseSourceConfig[]>;
  listSourceSyncStates(): Promise<ReleaseSourceSyncState[]>;
  upsertSourceSyncState(state: ReleaseSourceSyncState): Promise<ReleaseSourceSyncState[]>;
  listRequestCircuitStates(): Promise<RequestCircuitState[]>;
  upsertRequestCircuitState(state: RequestCircuitState): Promise<RequestCircuitState[]>;
  listCachedReleases(query?: CachedReleaseQuery): Promise<Release[]>;
  upsertCachedReleases(releases: Release[]): Promise<number>;
  pruneCachedReleases(before: string): Promise<number>;
  getReleaseSearchCache(cacheKey: string): Promise<ReleaseSearchCacheEntry | undefined>;
  upsertReleaseSearchCache(cacheKey: string, entry: ReleaseSearchCacheEntry): Promise<void>;
  upsertMyAnime(item: MyAnime): Promise<MyAnime[]>;
  removeMyAnime(itemId: string): Promise<MyAnime[]>;
}

/** 按稳定标识合并下载引擎任务与本地关联信息。 */
export function findExistingDownloadTask(
  existingTasks: DownloadTask[],
  incoming: DownloadTask
): DownloadTask | undefined {
  if (incoming.correlationTag) {
    const correlationMatch = findUniqueDownloadTask(
      existingTasks,
      (task) => task.correlationTag === incoming.correlationTag && canUseWeakDownloadIdentity(task, incoming)
    );
    if (correlationMatch) {
      return correlationMatch;
    }
  }

  if (incoming.torrentHash) {
    const hashMatch = existingTasks.find((task) => task.torrentHash === incoming.torrentHash);
    if (hashMatch) {
      return hashMatch;
    }
  }

  const idMatch = existingTasks.find((task) => task.id === incoming.id);
  if (idMatch) {
    return idMatch;
  }

  const sameNameTasks = existingTasks.filter(
    (task) => task.name === incoming.name && canUseWeakDownloadIdentity(task, incoming)
  );
  if (incoming.episodeNo !== undefined) {
    const episodeMatch = findUniqueDownloadTask(
      sameNameTasks,
      (task) => task.episodeNo === incoming.episodeNo
    );
    if (episodeMatch) {
      return episodeMatch;
    }
  }

  return sameNameTasks.length === 1 ? sameNameTasks[0] : undefined;
}

/** 判断本地任务是否仍被下载引擎结果覆盖。 */
export function isEngineTaskCovered(engineTasks: DownloadTask[], existing: DownloadTask): boolean {
  return findExistingDownloadTask(engineTasks, existing) !== undefined;
}

/** 按条件查找唯一下载任务，避免非唯一弱标识串联不同种子。 */
function findUniqueDownloadTask(
  tasks: DownloadTask[],
  predicate: (task: DownloadTask) => boolean
): DownloadTask | undefined {
  const matches = tasks.filter(predicate);
  return matches.length === 1 ? matches[0] : undefined;
}

/** 仅允许尚未获得哈希的一侧使用标签或名称完成首次关联。 */
function canUseWeakDownloadIdentity(left: DownloadTask, right: DownloadTask): boolean {
  return !left.torrentHash || !right.torrentHash;
}

/** 下载引擎刷新后同步关联单集的生命周期状态。 */
export function syncEpisodeStatusesFromDownloads(data: AppDataFile): void {
  for (const episode of data.episodes) {
    if (episode.status === "watched") {
      continue;
    }

    const linkedDownloads = findEpisodeDownloadLinks(data.downloads, episode);
    if (linkedDownloads.length === 0) {
      if (episode.status === "downloading") {
        episode.status = "aired";
      }
      continue;
    }
    if (linkedDownloads.some(isCompletedEpisodeDownloadLink)) {
      episode.status = "downloaded";
      continue;
    }

    if (linkedDownloads.some(({ task }) => isActiveDownloadStatus(task.status))) {
      episode.status = "downloading";
      continue;
    }

    if (episode.status === "downloading") {
      episode.status = "aired";
    }
  }
}

/** 根据单集与下载关联生成当日追番摘要。 */
export function buildDailyReminderSummary(data: AppDataFile): DashboardData["dailyReminder"] {
  const todayKey = toLocalDateKey(new Date());
  const followedByAnimeId = new Map(data.myAnime.map((item) => [item.anime.id, item]));
  const fansubById = new Map(data.fansubGroups.map((item) => [item.id, item]));
  const items: DailyReminderItem[] = [];

  for (const episode of data.episodes) {
    if (!episode.airTime || toLocalDateKey(new Date(episode.airTime)) !== todayKey) {
      continue;
    }

    const followed = followedByAnimeId.get(episode.animeId);
    if (!followed) {
      continue;
    }

    const downloadLink = findEpisodeDownloadLinks(data.downloads, episode)[0];
    const download = downloadLink?.task;
    const fansub = followed.defaultFansubGroupId ? fansubById.get(followed.defaultFansubGroupId) : undefined;

    items.push({
      id: `daily-${episode.id}`,
      animeId: episode.animeId,
      animeTitle: followed.anime.title,
      episodeId: episode.id,
      episodeNo: episode.episodeNo,
      airTime: episode.airTime,
      status: resolveReminderStatus(episode, downloadLink),
      fansubName: fansub?.name,
      downloadTaskId: download?.id
    });
  }

  items.sort((left, right) => (left.airTime ?? "").localeCompare(right.airTime ?? ""));

  return {
    date: todayKey,
    total: items.length,
    upcoming: items.filter((item) => item.status === "upcoming").length,
    aired: items.filter((item) => item.status === "aired" || item.status === "matched").length,
    downloading: items.filter((item) => item.status === "downloading").length,
    downloaded: items.filter((item) => item.status === "downloaded" || item.status === "watched").length,
    items
  };
}

/** 从真实追番与已开播单集派生需要人工关注的默认字幕组等待项。 */
export function buildPendingActions(data: AppDataFile): DashboardData["pendingActions"] {
  const followedByAnimeId = new Map(data.myAnime.map((item) => [item.anime.id, item]));
  const now = Date.now();

  return data.episodes
    .filter((episode) => {
      const followed = followedByAnimeId.get(episode.animeId);
      if (!followed?.defaultFansubGroupId || episode.status !== "aired") {
        return false;
      }
      if (episode.airTime && new Date(episode.airTime).getTime() > now) {
        return false;
      }
      return !data.downloads.some((task) =>
        task.animeId === episode.animeId &&
        (task.episodeId === episode.id || task.episodeNo === episode.episodeNo) &&
        task.fansubGroupId === followed.defaultFansubGroupId
      );
    })
    .sort((left, right) => (right.airTime ?? "").localeCompare(left.airTime ?? "") || right.episodeNo - left.episodeNo)
    .slice(0, 8)
    .map((episode) => {
      const followed = followedByAnimeId.get(episode.animeId)!;
      return {
        id: `pending-default-fansub-${episode.id}`,
        title: `《${followed.anime.title}》第 ${episode.episodeNo} 集`,
        description: `《${followed.anime.title}》第 ${episode.episodeNo} 集已开播，但默认字幕组还没有发布资源。`,
        severity: "warning" as const,
        animeId: episode.animeId,
        episodeId: episode.id,
        episodeNo: episode.episodeNo
      };
    });
}

function resolveReminderStatus(episode: Episode, download?: EpisodeDownloadLink): DailyReminderItem["status"] {
  if (!download) {
    return episode.status;
  }

  if (isCompletedEpisodeDownloadLink(download)) {
    return "downloaded";
  }

  if (isActiveDownloadStatus(download.task.status)) {
    return "downloading";
  }

  return episode.status;
}

interface EpisodeDownloadLink {
  task: DownloadTask;
  file?: DownloadTask["files"][number];
}

/** 查找任务级或合集文件级的单集下载关联。 */
function findEpisodeDownloadLinks(downloads: DownloadTask[], episode: Episode): EpisodeDownloadLink[] {
  return downloads.flatMap((task) => {
    if (task.animeId !== episode.animeId) {
      return [];
    }
    if (task.episodeId === episode.id || task.episodeNo === episode.episodeNo) {
      return [{ task }];
    }
    return task.files
      .filter((file) => file.selected && (file.episodeId === episode.id || file.episodeNo === episode.episodeNo))
      .map((file) => ({ task, file }));
  });
}

/** 合集中的单个文件完成后即可将对应单集标记为已下载。 */
function isCompletedEpisodeDownloadLink(link: EpisodeDownloadLink): boolean {
  return isCompletedDownloadTask(link.task) || (link.file?.progress ?? 0) >= 1;
}

/** 将每日提醒条目转换为首页单集摘要。 */
export function toEpisodeSummary(item: DailyReminderItem): DashboardData["todayEpisodes"][number] {
  return {
    id: item.id,
    animeTitle: item.animeTitle,
    episodeNo: item.episodeNo,
    airTime: formatLocalTime(item.airTime),
    status: item.status,
    fansubName: item.fansubName,
    downloadTaskId: item.downloadTaskId
  };
}

function toLocalDateKey(date: Date): string {
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return [date.getFullYear(), padDatePart(date.getMonth() + 1), padDatePart(date.getDate())].join("-");
}

function formatLocalTime(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }

  return `${padDatePart(date.getHours())}:${padDatePart(date.getMinutes())}`;
}

function padDatePart(value: number): string {
  return value.toString().padStart(2, "0");
}

/** 按最近探测或下载时间倒序排列媒体文件。 */
export function sortMediaFiles(mediaFiles: MediaFile[]): MediaFile[] {
  return [...mediaFiles].sort((a, b) => {
    const left = a.probedAt ?? a.downloadedAt ?? "";
    const right = b.probedAt ?? b.downloadedAt ?? "";
    return right.localeCompare(left);
  });
}

/** 按创建时间倒序排列通知。 */
export function sortNotifications(notifications: NotificationRecord[]): NotificationRecord[] {
  return [...notifications].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** 按季度和标题排列番剧目录。 */
export function sortAnimeCatalog(items: Anime[]): Anime[] {
  return [...items].sort((a, b) => {
    if (a.premiereYear !== b.premiereYear) {
      return b.premiereYear - a.premiereYear;
    }
    if (a.premiereMonth !== b.premiereMonth) {
      return b.premiereMonth - a.premiereMonth;
    }
    return a.title.localeCompare(b.title);
  });
}

/** 按集数升序排列单集。 */
export function sortEpisodes(episodes: Episode[]): Episode[] {
  return [...episodes].sort((a, b) => a.episodeNo - b.episodeNo);
}

/** 根据 ID、外部 ID 或标题判断番剧是否相同。 */
export function isSameAnime(left: Anime, right: Anime): boolean {
  if (left.id === right.id) {
    return true;
  }

  const sharedExternalId = Object.entries(right.externalIds).some(([key, value]) => left.externalIds[key] === value);
  if (sharedExternalId) {
    return true;
  }

  return [left.title, left.originalTitle].filter(Boolean).some((leftTitle) =>
    [right.title, right.originalTitle].filter(Boolean).some((rightTitle) => leftTitle === rightTitle)
  );
}

/** 合并番剧别名并忽略大小写重复项。 */
export function mergeAliases(left: Anime["aliases"], right: Anime["aliases"]): Anime["aliases"] {
  const aliases = [...left];
  for (const alias of right) {
    if (!aliases.some((item) => item.alias.toLowerCase() === alias.alias.toLowerCase())) {
      aliases.push(alias);
    }
  }

  return aliases;
}

/** 按季度和标题排列追番列表。 */
export function sortMyAnime(items: MyAnime[]): MyAnime[] {
  return [...items].sort((a, b) => {
    if (a.anime.premiereYear !== b.anime.premiereYear) {
      return b.anime.premiereYear - a.anime.premiereYear;
    }

    if (a.anime.premiereMonth !== b.anime.premiereMonth) {
      return b.anime.premiereMonth - a.anime.premiereMonth;
    }

    return a.anime.title.localeCompare(b.anime.title);
  });
}
