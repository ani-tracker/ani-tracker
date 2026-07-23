import type {
  Anime,
  AnimeSourceBinding,
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
  ReleaseSearchResult,
  SetAnimeWatchProgressInput
} from "@shared/contracts";
import { normalizeAppearanceSettings } from "@shared/theme";
import { normalizeCandidateFansubNames } from "@shared/fansub-name-matcher";
import type { AppDataFile } from "@shared/persistence/app-data";

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
  listDownloads(): Promise<DownloadTask[]>;
  listEpisodes(animeId: string): Promise<Episode[]>;
  upsertEpisode(episode: Episode): Promise<Episode[]>;
  listMyAnimeWatchProgress(): Promise<AnimeWatchProgress[]>;
  setAnimeWatchProgress(input: SetAnimeWatchProgressInput): Promise<AnimeWatchProgress>;
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

    const linkedTasks = data.downloads.filter((task) => task.episodeId === episode.id);
    if (linkedTasks.length === 0) {
      if (episode.status === "downloading") {
        episode.status = "aired";
      }
      continue;
    }
    if (linkedTasks.some((task) => task.status === "completed" || task.status === "seeding")) {
      episode.status = "downloaded";
      continue;
    }

    if (linkedTasks.some((task) => isActiveDownloadStatus(task.status))) {
      episode.status = "downloading";
      continue;
    }

    if (episode.status === "downloading") {
      episode.status = "aired";
    }
  }
}

function isActiveDownloadStatus(status: DownloadStatus): boolean {
  return ["queued", "fetching_metadata", "downloading", "stalled", "paused", "checking", "moving"].includes(status);
}

/** 深度合并设置分组，避免局部更新覆盖同组其他字段。 */
export function mergeSettings(current: AppSettings, patch: Partial<AppSettings>): AppSettings {
  return {
    ...current,
    ...patch,
    appearance: normalizeAppearanceSettings({
      ...current.appearance,
      ...patch.appearance,
      customThemePacks: patch.appearance?.customThemePacks ?? current.appearance.customThemePacks
    }),
    download: {
      ...current.download,
      ...patch.download,
      embedded: {
        ...current.download.embedded,
        ...patch.download?.embedded
      },
      qbittorrent: {
        ...current.download.qbittorrent,
        ...patch.download?.qbittorrent,
        seedingLimits: {
          ...current.download.qbittorrent.seedingLimits,
          ...patch.download?.qbittorrent?.seedingLimits
        },
        managed: {
          ...current.download.qbittorrent.managed,
          ...patch.download?.qbittorrent?.managed
        }
      }
    },
    storage: {
      ...current.storage,
      ...patch.storage
    },
    automation: {
      ...current.automation,
      ...patch.automation,
      candidateFansubNames: normalizeCandidateFansubNames(
        patch.automation?.candidateFansubNames ?? current.automation.candidateFansubNames ?? []
      )
    },
    sourceSync: {
      enabled: patch.sourceSync?.enabled ?? current.sourceSync?.enabled ?? true,
      dailyTime: patch.sourceSync?.dailyTime ?? current.sourceSync?.dailyTime ?? "09:00"
    },
    media: {
      ...current.media,
      ...patch.media
    },
    desktop: {
      ...current.desktop,
      ...patch.desktop
    },
    network: {
      ...current.network,
      ...patch.network,
      metadataProxy: {
        ...current.network.metadataProxy,
        ...patch.network?.metadataProxy
      },
      remoteAccess: {
        ...current.network.remoteAccess,
        ...patch.network?.remoteAccess,
        port: normalizeRemoteAccessPort(patch.network?.remoteAccess?.port, current.network.remoteAccess.port)
      }
    },
    players: mergePlayerProfiles(current.players, patch.players)
  };
}

/** 按播放器标识合并平台默认项和用户路径，避免升级后缺少新增选项。 */
function mergePlayerProfiles(current: AppSettings["players"], patch?: AppSettings["players"]): AppSettings["players"] {
  if (!patch) {
    return current;
  }

  const patchById = new Map(patch.map((profile) => [profile.id, profile]));
  const merged = current.map((profile) => ({ ...profile, ...patchById.get(profile.id) }));
  const currentIds = new Set(current.map((profile) => profile.id));
  return [...merged, ...patch.filter((profile) => !currentIds.has(profile.id))];
}

/** 仅接受非特权有效端口，非法补丁保留当前配置。 */
function normalizeRemoteAccessPort(value: number | undefined, current: number): number {
  return value !== undefined && Number.isInteger(value) && value >= 1024 && value <= 65_535 ? value : current;
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

    const download = data.downloads.find((task) => task.animeId === episode.animeId && task.episodeId === episode.id);
    const fansub = followed.defaultFansubGroupId ? fansubById.get(followed.defaultFansubGroupId) : undefined;

    items.push({
      id: `daily-${episode.id}`,
      animeId: episode.animeId,
      animeTitle: followed.anime.title,
      episodeId: episode.id,
      episodeNo: episode.episodeNo,
      airTime: episode.airTime,
      status: resolveReminderStatus(episode, download),
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

function resolveReminderStatus(episode: Episode, download?: DownloadTask): DailyReminderItem["status"] {
  if (!download) {
    return episode.status;
  }

  if (download.status === "completed" || download.status === "seeding") {
    return "downloaded";
  }

  if (["queued", "fetching_metadata", "downloading", "stalled", "paused", "checking", "moving"].includes(download.status)) {
    return "downloading";
  }

  return episode.status;
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
