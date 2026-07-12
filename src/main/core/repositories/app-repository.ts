import type {
  Anime,
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
  ReleaseSourceConfig
} from "@shared/domain";
import type { AppDataFile } from "@shared/persistence/app-data";
import type { AppDataStore } from "../storage/app-data-store";

export class AppRepository {
  constructor(private readonly store: AppDataStore) {}

  async getDashboard(): Promise<DashboardData> {
    const data = await this.store.getData();
    const dailyReminder = buildDailyReminderSummary(data);

    return {
      ...data.dashboard,
      dailyReminder,
      todayEpisodes: dailyReminder.items.map(toEpisodeSummary),
      activeDownloads: data.downloads,
      recentCompleted: sortMediaFiles(data.mediaFiles).slice(0, 10),
      sourceHealth: data.dashboard.sourceHealth.map((source) => {
        const config = data.sources.find((item) => item.id === source.sourceId);
        return {
          ...source,
          status: config?.enabled === false ? "warning" : source.status
        };
      })
    };
  }

  async listMyAnime(): Promise<MyAnime[]> {
    return sortMyAnime((await this.store.getData()).myAnime);
  }

  async listAnimeCatalog(): Promise<Anime[]> {
    return sortAnimeCatalog((await this.store.getData()).animeCatalog);
  }

  async listNotifications(): Promise<NotificationRecord[]> {
    return sortNotifications((await this.store.getData()).notifications);
  }

  async getUnreadNotificationCount(): Promise<number> {
    return (await this.store.getData()).notifications.filter((item) => !item.readAt).length;
  }

  async addNotifications(records: NotificationRecord[]): Promise<NotificationRecord[]> {
    if (!records.length) {
      return this.listNotifications();
    }

    const data = await this.store.update((draft) => {
      draft.notifications.unshift(...records);
      draft.notifications = sortNotifications(draft.notifications).slice(0, 200);
    });

    return sortNotifications(data.notifications);
  }

  async markNotificationRead(notificationId: string): Promise<NotificationRecord[]> {
    const data = await this.store.update((draft) => {
      draft.notifications = draft.notifications.map((item) =>
        item.id === notificationId
          ? {
              ...item,
              readAt: item.readAt ?? new Date().toISOString()
            }
          : item
      );
    });

    return sortNotifications(data.notifications);
  }

  async markAllNotificationsRead(): Promise<NotificationRecord[]> {
    const now = new Date().toISOString();
    const data = await this.store.update((draft) => {
      draft.notifications = draft.notifications.map((item) => ({
        ...item,
        readAt: item.readAt ?? now
      }));
    });

    return sortNotifications(data.notifications);
  }

  async clearNotifications(): Promise<NotificationRecord[]> {
    const data = await this.store.update((draft) => {
      draft.notifications = [];
    });

    return data.notifications;
  }

  async searchAnimeCatalog(keyword: string): Promise<Anime[]> {
    const normalized = keyword.trim().toLowerCase();
    const items = await this.listAnimeCatalog();
    if (!normalized) {
      return items;
    }

    return items.filter((anime) =>
      [anime.title, anime.originalTitle, ...anime.aliases.map((alias) => alias.alias)]
        .filter(Boolean)
        .some((value) => value!.toLowerCase().includes(normalized))
    );
  }

  async listAnimeCatalogByMonth(year: number, month: number): Promise<Anime[]> {
    return sortAnimeCatalog(
      (await this.store.getData()).animeCatalog.filter(
        (anime) => anime.premiereYear === year && anime.premiereMonth === month
      )
    );
  }

  async upsertAnimeCatalog(items: Anime[]): Promise<{ items: Anime[]; addedCount: number; existingCount: number }> {
    let addedCount = 0;
    let existingCount = 0;
    const data = await this.store.update((draft) => {
      for (const item of items) {
        const index = draft.animeCatalog.findIndex((anime) => isSameAnime(anime, item));
        if (index >= 0) {
          draft.animeCatalog[index] = {
            ...draft.animeCatalog[index],
            ...item,
            aliases: mergeAliases(draft.animeCatalog[index].aliases, item.aliases),
            externalIds: {
              ...draft.animeCatalog[index].externalIds,
              ...item.externalIds
            }
          };
          existingCount += 1;
          continue;
        }

        draft.animeCatalog.push(item);
        addedCount += 1;
      }
    });

    return {
      items: sortAnimeCatalog(data.animeCatalog),
      addedCount,
      existingCount
    };
  }

  async listDownloads(): Promise<DownloadTask[]> {
    return (await this.store.getData()).downloads;
  }

  async listEpisodes(animeId: string): Promise<Episode[]> {
    return sortEpisodes((await this.store.getData()).episodes.filter((episode) => episode.animeId === animeId));
  }

  async upsertEpisode(episode: Episode): Promise<Episode[]> {
    const data = await this.store.update((draft) => {
      const index = draft.episodes.findIndex((item) => item.id === episode.id);
      if (index >= 0) {
        draft.episodes[index] = episode;
        return;
      }

      draft.episodes.push(episode);
    });

    return sortEpisodes(data.episodes.filter((item) => item.animeId === episode.animeId));
  }

  async listEpisodePreferences(animeId: string): Promise<EpisodePreference[]> {
    return (await this.store.getData()).episodePreferences.filter((preference) => preference.animeId === animeId);
  }

  async upsertEpisodePreference(preference: EpisodePreference): Promise<EpisodePreference[]> {
    const data = await this.store.update((draft) => {
      const index = draft.episodePreferences.findIndex((item) => item.episodeId === preference.episodeId);
      if (index >= 0) {
        draft.episodePreferences[index] = preference;
        return;
      }

      draft.episodePreferences.push(preference);
    });

    return data.episodePreferences.filter((item) => item.animeId === preference.animeId);
  }

  async removeEpisodePreference(episodeId: string): Promise<EpisodePreference[]> {
    let animeId = "";
    const data = await this.store.update((draft) => {
      const preference = draft.episodePreferences.find((item) => item.episodeId === episodeId);
      animeId = preference?.animeId ?? draft.episodes.find((episode) => episode.id === episodeId)?.animeId ?? "";
      draft.episodePreferences = draft.episodePreferences.filter((item) => item.episodeId !== episodeId);
    });

    return animeId ? data.episodePreferences.filter((item) => item.animeId === animeId) : data.episodePreferences;
  }

  async getDownloadTask(taskId: string): Promise<DownloadTask | undefined> {
    return (await this.store.getData()).downloads.find((task) => task.id === taskId || task.torrentHash === taskId);
  }

  async upsertDownloadTask(task: DownloadTask): Promise<DownloadTask[]> {
    const data = await this.store.update((draft) => {
      const index = draft.downloads.findIndex((item) => item.id === task.id);
      if (index >= 0) {
        draft.downloads[index] = task;
        return;
      }

      draft.downloads.unshift(task);
      draft.dashboard.activeDownloads = draft.downloads;
    });

    return data.downloads;
  }

  async mergeDownloadTasksFromEngine(tasks: DownloadTask[]): Promise<DownloadTask[]> {
    const data = await this.store.update((draft) => {
      const merged = tasks.map((task) => {
        const existing = findExistingDownloadTask(draft.downloads, task);
        return existing
          ? {
              ...task,
              releaseId: existing.releaseId,
              animeId: existing.animeId,
              episodeId: existing.episodeId,
              createdAt: existing.createdAt,
              completedAt: task.completedAt ?? existing.completedAt
            }
          : task;
      });

      const inactiveLocalTasks = draft.downloads.filter((task) => !isEngineTaskCovered(merged, task));
      draft.downloads = [...merged, ...inactiveLocalTasks];
      draft.dashboard.activeDownloads = draft.downloads.filter((task) => !["completed", "seeding"].includes(task.status));
    });

    return data.downloads;
  }

  async updateDownloadStatus(taskId: string, status: DownloadStatus): Promise<DownloadTask[]> {
    const data = await this.store.update((draft) => {
      draft.downloads = draft.downloads.map((task) =>
        task.id === taskId || task.torrentHash === taskId
          ? {
              ...task,
              status
            }
          : task
      );
      draft.dashboard.activeDownloads = draft.downloads.filter((task) => !["completed", "seeding"].includes(task.status));
    });

    return data.downloads;
  }

  async removeDownloadTask(taskId: string): Promise<DownloadTask[]> {
    const data = await this.store.update((draft) => {
      draft.downloads = draft.downloads.filter((task) => task.id !== taskId && task.torrentHash !== taskId);
      draft.dashboard.activeDownloads = draft.downloads.filter((task) => !["completed", "seeding"].includes(task.status));
    });

    return data.downloads;
  }

  async listMediaFiles(): Promise<MediaFile[]> {
    return sortMediaFiles((await this.store.getData()).mediaFiles);
  }

  async upsertMediaFiles(mediaFiles: MediaFile[]): Promise<MediaFile[]> {
    const data = await this.store.update((draft) => {
      for (const mediaFile of mediaFiles) {
        const index = draft.mediaFiles.findIndex(
          (item) => item.id === mediaFile.id || item.filePath === mediaFile.filePath
        );

        if (index >= 0) {
          draft.mediaFiles[index] = mediaFile;
          continue;
        }

        draft.mediaFiles.unshift(mediaFile);
      }

      draft.dashboard.recentCompleted = sortMediaFiles(draft.mediaFiles).slice(0, 10);
    });

    return sortMediaFiles(data.mediaFiles);
  }

  async listFansubs(): Promise<FansubGroup[]> {
    return (await this.store.getData()).fansubGroups;
  }

  async listSources(): Promise<ReleaseSourceConfig[]> {
    return (await this.store.getData()).sources;
  }

  async getSettings(): Promise<AppSettings> {
    return (await this.store.getData()).settings;
  }

  async updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
    const data = await this.store.update((draft) => {
      draft.settings = mergeSettings(draft.settings, patch);
    });

    return data.settings;
  }

  async updateSourceEnabled(sourceId: string, enabled: boolean): Promise<ReleaseSourceConfig[]> {
    const data = await this.store.update((draft) => {
      draft.sources = draft.sources.map((source) => (source.id === sourceId ? { ...source, enabled } : source));
    });

    return data.sources;
  }

  async upsertSource(source: ReleaseSourceConfig): Promise<ReleaseSourceConfig[]> {
    const data = await this.store.update((draft) => {
      const index = draft.sources.findIndex((item) => item.id === source.id);
      if (index >= 0) {
        draft.sources[index] = source;
        return;
      }

      draft.sources.unshift(source);
    });

    return data.sources;
  }

  async upsertMyAnime(item: MyAnime): Promise<MyAnime[]> {
    const data = await this.store.update((draft) => {
      const index = draft.myAnime.findIndex((anime) => anime.id === item.id);

      if (index >= 0) {
        draft.myAnime[index] = {
          ...item,
          updatedAt: new Date().toISOString()
        };
        return;
      }

      draft.myAnime.push({
        ...item,
        addedAt: item.addedAt || new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
    });

    return sortMyAnime(data.myAnime);
  }

  async removeMyAnime(itemId: string): Promise<MyAnime[]> {
    const data = await this.store.update((draft) => {
      const removing = draft.myAnime.find((item) => item.id === itemId);
      draft.myAnime = draft.myAnime.filter((item) => item.id !== itemId);
      if (removing) {
        draft.episodes = draft.episodes.filter((episode) => episode.animeId !== removing.anime.id);
        draft.episodePreferences = draft.episodePreferences.filter(
          (preference) => preference.animeId !== removing.anime.id
        );
      }
    });

    return sortMyAnime(data.myAnime);
  }

  async replaceData(data: AppDataFile): Promise<AppDataFile> {
    return this.store.update((draft) => {
      Object.assign(draft, data);
    });
  }
}

function findExistingDownloadTask(existingTasks: DownloadTask[], incoming: DownloadTask): DownloadTask | undefined {
  return existingTasks.find((task) => {
    if (incoming.torrentHash && task.torrentHash === incoming.torrentHash) {
      return true;
    }

    if (task.id === incoming.id) {
      return true;
    }

    return task.name === incoming.name;
  });
}

function isEngineTaskCovered(engineTasks: DownloadTask[], existing: DownloadTask): boolean {
  return engineTasks.some((task) => {
    if (existing.torrentHash && task.torrentHash === existing.torrentHash) {
      return true;
    }

    return task.id === existing.id || task.name === existing.name;
  });
}

function mergeSettings(current: AppSettings, patch: Partial<AppSettings>): AppSettings {
  return {
    ...current,
    ...patch,
    download: {
      ...current.download,
      ...patch.download
    },
    storage: {
      ...current.storage,
      ...patch.storage
    },
    automation: {
      ...current.automation,
      ...patch.automation
    },
    media: {
      ...current.media,
      ...patch.media
    },
    desktop: {
      ...current.desktop,
      ...patch.desktop
    },
    players: patch.players ?? current.players
  };
}

function buildDailyReminderSummary(data: AppDataFile): DashboardData["dailyReminder"] {
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

function toEpisodeSummary(item: DailyReminderItem): DashboardData["todayEpisodes"][number] {
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

function sortMediaFiles(mediaFiles: MediaFile[]): MediaFile[] {
  return [...mediaFiles].sort((a, b) => {
    const left = a.probedAt ?? a.downloadedAt ?? "";
    const right = b.probedAt ?? b.downloadedAt ?? "";
    return right.localeCompare(left);
  });
}

function sortNotifications(notifications: NotificationRecord[]): NotificationRecord[] {
  return [...notifications].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function sortAnimeCatalog(items: Anime[]): Anime[] {
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

function sortEpisodes(episodes: Episode[]): Episode[] {
  return [...episodes].sort((a, b) => a.episodeNo - b.episodeNo);
}

function isSameAnime(left: Anime, right: Anime): boolean {
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

function mergeAliases(left: Anime["aliases"], right: Anime["aliases"]): Anime["aliases"] {
  const aliases = [...left];
  for (const alias of right) {
    if (!aliases.some((item) => item.alias.toLowerCase() === alias.alias.toLowerCase())) {
      aliases.push(alias);
    }
  }

  return aliases;
}

function sortMyAnime(items: MyAnime[]): MyAnime[] {
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
