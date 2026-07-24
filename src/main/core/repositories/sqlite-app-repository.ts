import type Database from "better-sqlite3";
import * as BetterSqlite3Module from "better-sqlite3";
import type {
  Anime,
  AnimeSourceBinding,
  AnimeSourceExclusion,
  AppSettings,
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
  ReleaseSourceSyncState,
  TorrentFile
} from "@shared/domain";
import type {
  AnimeWatchProgress,
  PlaybackCheckpoint,
  ReleaseSearchResult,
  SetAnimeWatchProgressInput
} from "@shared/contracts";
import { mergeAnimeDetailMetadata, normalizeAnimeDetailMetadata } from "@shared/anime-detail";
import { normalizeMyAnimeAutoDownload } from "@shared/my-anime-policy";
import { isActiveDownloadTask, isCompletedDownloadTask } from "@shared/download-status";
import type { AppDataFile } from "@shared/persistence/app-data";
import { APP_DATA_VERSION } from "@shared/persistence/app-data";
import {
  normalizeSubtitleLanguages,
  resolveSubtitleLanguages,
  toLegacySubtitlePreference
} from "@shared/release-metadata";
import { logger } from "../logger";
import {
  inferDownloadTaskEpisodeNo,
  inferTorrentFileEpisodeNo,
  isMultiEpisodeDownloadTask
} from "../downloads/download-episode-resolver";
import { mergeAnimeMetadataBatches } from "../metadata/metadata-provider";
import { enrichReleaseFromTitle, normalizeFansubName, parseReleaseTitle } from "../releases/release-title-parser";
import { defaultSourceConfigs } from "../sources/default-source-configs";
import { createDefaultSettingsProvider, type DefaultSettingsProvider } from "../platform/default-settings-provider";
import { createSeedData } from "../storage/seed-data";
import { SQLITE_SCHEMA, SQLITE_SCHEMA_VERSION } from "../storage/sqlite-schema";
import type { AppRepository, CachedReleaseQuery, ReleaseSearchCacheEntry } from "./app-repository";
import {
  buildDailyReminderSummary,
  buildPendingActions,
  findExistingDownloadTask,
  isEngineTaskCovered,
  isSameAnime,
  mergeAliases,
  mergeSettings,
  sortAnimeCatalog,
  sortEpisodes,
  sortMediaFiles,
  sortMyAnime,
  sortNotifications,
  syncEpisodeStatusesFromDownloads,
  toEpisodeSummary
} from "./app-repository";

type SqliteValue = string | number | bigint | Buffer | null;
type SqliteParams = Record<string, SqliteValue>;
type SqliteRow = Record<string, SqliteValue>;
const DatabaseConstructor = (
  (BetterSqlite3Module as unknown as { default?: typeof BetterSqlite3Module }).default ?? BetterSqlite3Module
) as unknown as new (filename: string, options?: Database.Options) => Database.Database;

export interface SqliteAppRepositoryOptions {
  settingsProvider?: DefaultSettingsProvider;
}

export class SqliteAppRepository implements AppRepository {
  private readonly database: Database.Database;
  private readonly settingsProvider: DefaultSettingsProvider;

  constructor(
    private readonly databasePath: string,
    options: SqliteAppRepositoryOptions = {}
  ) {
    this.settingsProvider = options.settingsProvider ?? createDefaultSettingsProvider();
    this.database = new DatabaseConstructor(databasePath);
    try {
      this.initialize();
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  /** 关闭 SQLite 连接并释放原生资源。 */
  close(): void {
    if (this.database.open) {
      try {
        this.database.pragma("wal_checkpoint(TRUNCATE)");
      } finally {
        this.database.close();
      }
    }
  }

  /** 判断数据库是否已包含应用数据。 */
  hasAppData(): boolean {
    return this.getMeta("app_data_version") !== undefined;
  }

  /** 读取数据库当前应用数据版本。 */
  getAppDataVersion(): number | undefined {
    const value = this.getMeta("app_data_version");
    return value === undefined ? undefined : Number(value);
  }

  /** 空库首次启动时在单事务中写入初始数据。 */
  initializeWithSeed(data: AppDataFile): boolean {
    if (this.hasAppData()) {
      return false;
    }

    this.transaction(() => {
      this.clearAllData();
      this.writeSnapshot(data);
    });
    this.maintainStoredData();
    logger.info("SQLite repository seeded", { path: this.databasePath, counts: getSnapshotCounts(data) });
    return true;
  }

  async getDashboard(): Promise<DashboardData> {
    const data = this.readSnapshot();
    const dailyReminder = buildDailyReminderSummary(data);
    return {
      ...data.dashboard,
      dailyReminder,
      todayEpisodes: dailyReminder.items.map(toEpisodeSummary),
      pendingActions: buildPendingActions(data),
      activeDownloads: data.downloads.filter(isActiveDownloadTask),
      recentCompleted: sortMediaFiles(data.mediaFiles).slice(0, 10),
      sourceHealth: data.dashboard.sourceHealth.map((source) => ({
        ...source,
        status: data.sources.find((item) => item.id === source.sourceId)?.enabled === false ? "warning" : source.status
      }))
    };
  }

  async listMyAnime(): Promise<MyAnime[]> {
    const animeById = new Map((await this.listAnimeCatalog()).map((anime) => [anime.id, anime]));
    const rssSubscriptionsByMyAnime = this.readRssSubscriptionsByMyAnime();
    return sortMyAnime(
      this.all("SELECT * FROM my_anime").flatMap((row) => {
        const anime = animeById.get(asString(row.anime_id));
        return anime ? [mapMyAnime(row, anime, rssSubscriptionsByMyAnime.get(asString(row.id)) ?? [])] : [];
      })
    );
  }

  /** 读取番剧已缓存或确认的来源映射。 */
  async listAnimeSourceBindings(animeId: string): Promise<AnimeSourceBinding[]> {
    return this.all(
      "SELECT * FROM anime_source_binding WHERE anime_id = @animeId ORDER BY source_id",
      { animeId }
    ).map(mapAnimeSourceBinding);
  }

  /** 保存番剧来源映射，同一番剧每个来源仅保留一项。 */
  async upsertAnimeSourceBinding(binding: AnimeSourceBinding): Promise<AnimeSourceBinding[]> {
    this.run(
      `INSERT INTO anime_source_binding (
        id, anime_id, source_id, source_anime_id, source_anime_title, source_url,
        match_method, confidence, confirmed, created_at, updated_at
      ) VALUES (
        @id, @animeId, @sourceId, @sourceAnimeId, @sourceAnimeTitle, @sourceUrl,
        @matchMethod, @confidence, @confirmed, @createdAt, @updatedAt
      ) ON CONFLICT(anime_id, source_id) DO UPDATE SET
        id = excluded.id, source_anime_id = excluded.source_anime_id,
        source_anime_title = excluded.source_anime_title, source_url = excluded.source_url,
        match_method = excluded.match_method, confidence = excluded.confidence,
        confirmed = excluded.confirmed, updated_at = excluded.updated_at`,
      {
        id: binding.id,
        animeId: binding.animeId,
        sourceId: binding.sourceId,
        sourceAnimeId: binding.sourceAnimeId,
        sourceAnimeTitle: binding.sourceAnimeTitle ?? null,
        sourceUrl: binding.sourceUrl ?? null,
        matchMethod: binding.matchMethod,
        confidence: binding.confidence,
        confirmed: toInteger(binding.confirmed),
        createdAt: binding.createdAt,
        updatedAt: binding.updatedAt
      }
    );
    logger.info("Anime source binding saved", {
      animeId: binding.animeId,
      sourceId: binding.sourceId,
      sourceAnimeId: binding.sourceAnimeId,
      confirmed: binding.confirmed
    });
    return this.listAnimeSourceBindings(binding.animeId);
  }

  /** 删除番剧指定来源的映射。 */
  async removeAnimeSourceBinding(animeId: string, sourceId: string): Promise<AnimeSourceBinding[]> {
    this.run(
      "DELETE FROM anime_source_binding WHERE anime_id = @animeId AND source_id = @sourceId",
      { animeId, sourceId }
    );
    logger.info("Anime source binding removed", { animeId, sourceId });
    return this.listAnimeSourceBindings(animeId);
  }

  /** 读取番剧已确认的单候选和整来源排除记录。 */
  async listAnimeSourceExclusions(animeId: string): Promise<AnimeSourceExclusion[]> {
    return this.all(
      "SELECT * FROM anime_source_exclusion WHERE anime_id = @animeId ORDER BY source_id, source_anime_id",
      { animeId }
    ).map(mapAnimeSourceExclusion);
  }

  /** 保存番剧来源排除记录，同一候选或整来源只保留一项。 */
  async upsertAnimeSourceExclusion(exclusion: AnimeSourceExclusion): Promise<AnimeSourceExclusion[]> {
    this.run(
      `INSERT INTO anime_source_exclusion (
        id, anime_id, source_id, scope, source_anime_id, source_anime_title, created_at, updated_at
      ) VALUES (
        @id, @animeId, @sourceId, @scope, @sourceAnimeId, @sourceAnimeTitle, @createdAt, @updatedAt
      ) ON CONFLICT(anime_id, source_id, source_anime_id) DO UPDATE SET
        id = excluded.id, scope = excluded.scope, source_anime_title = excluded.source_anime_title,
        updated_at = excluded.updated_at`,
      {
        id: exclusion.id,
        animeId: exclusion.animeId,
        sourceId: exclusion.sourceId,
        scope: exclusion.scope,
        sourceAnimeId: exclusion.sourceAnimeId ?? "",
        sourceAnimeTitle: exclusion.sourceAnimeTitle ?? null,
        createdAt: exclusion.createdAt,
        updatedAt: exclusion.updatedAt
      }
    );
    logger.info("Anime source exclusion saved", {
      animeId: exclusion.animeId,
      sourceId: exclusion.sourceId,
      scope: exclusion.scope,
      sourceAnimeId: exclusion.sourceAnimeId
    });
    return this.listAnimeSourceExclusions(exclusion.animeId);
  }

  /** 删除单候选或整来源排除记录，空候选 ID 表示整来源。 */
  async removeAnimeSourceExclusion(
    animeId: string,
    sourceId: string,
    sourceAnimeId?: string
  ): Promise<AnimeSourceExclusion[]> {
    this.run(
      `DELETE FROM anime_source_exclusion
       WHERE anime_id = @animeId AND source_id = @sourceId AND source_anime_id = @sourceAnimeId`,
      { animeId, sourceId, sourceAnimeId: sourceAnimeId ?? "" }
    );
    logger.info("Anime source exclusion removed", { animeId, sourceId, sourceAnimeId });
    return this.listAnimeSourceExclusions(animeId);
  }

  async listAnimeCatalog(): Promise<Anime[]> {
    const aliases = this.all("SELECT * FROM anime_alias ORDER BY priority DESC").map(mapAnimeAlias);
    const aliasesByAnime = new Map<string, Anime["aliases"]>();
    for (const alias of aliases) {
      const items = aliasesByAnime.get(alias.animeId) ?? [];
      items.push(alias);
      aliasesByAnime.set(alias.animeId, items);
    }
    return sortAnimeCatalog(
      this.all("SELECT * FROM anime_catalog").map((row) => mapAnime(row, aliasesByAnime.get(asString(row.id)) ?? []))
    );
  }

  /** 按目录标识读取单部番剧及其别名。 */
  async getAnimeCatalogById(animeId: string): Promise<Anime | undefined> {
    const row = this.get("SELECT * FROM anime_catalog WHERE id = @animeId", { animeId });
    if (!row) return undefined;
    const aliases = this.all(
      "SELECT * FROM anime_alias WHERE anime_id = @animeId ORDER BY priority DESC",
      { animeId }
    ).map(mapAnimeAlias);
    return mapAnime(row, aliases);
  }

  async listNotifications(): Promise<NotificationRecord[]> {
    return sortNotifications(this.all("SELECT * FROM notification ORDER BY created_at DESC").map(mapNotification));
  }

  async getUnreadNotificationCount(): Promise<number> {
    return Number(this.get("SELECT COUNT(*) AS count FROM notification WHERE read_at IS NULL")?.count ?? 0);
  }

  async addNotifications(records: NotificationRecord[]): Promise<NotificationRecord[]> {
    if (!records.length) return this.listNotifications();
    this.transaction(() => {
      for (const record of records) this.upsertNotification(record);
      this.run(`DELETE FROM notification WHERE id NOT IN (
        SELECT id FROM notification ORDER BY created_at DESC LIMIT 200
      )`);
    });
    return this.listNotifications();
  }

  async markNotificationRead(notificationId: string): Promise<NotificationRecord[]> {
    this.run("UPDATE notification SET read_at = COALESCE(read_at, @readAt) WHERE id = @id", {
      id: notificationId,
      readAt: nowIso()
    });
    return this.listNotifications();
  }

  async markAllNotificationsRead(): Promise<NotificationRecord[]> {
    this.run("UPDATE notification SET read_at = COALESCE(read_at, @readAt)", { readAt: nowIso() });
    return this.listNotifications();
  }

  async clearNotifications(): Promise<NotificationRecord[]> {
    this.run("DELETE FROM notification");
    return [];
  }

  async searchAnimeCatalog(keyword: string): Promise<Anime[]> {
    const normalized = keyword.trim().toLocaleLowerCase();
    const items = await this.listAnimeCatalog();
    if (!normalized) return items;
    return items.filter((anime) =>
      [anime.title, anime.originalTitle, ...anime.aliases.map((alias) => alias.alias)]
        .filter(Boolean)
        .some((value) => value!.toLocaleLowerCase().includes(normalized))
    );
  }

  async listAnimeCatalogByMonth(year: number, month: number): Promise<Anime[]> {
    return (await this.listAnimeCatalog()).filter(
      (anime) => anime.premiereYear === year && anime.premiereMonth === month
    );
  }

  async upsertAnimeCatalog(items: Anime[]): Promise<{ items: Anime[]; addedCount: number; existingCount: number }> {
    return this.persistAnimeCatalog(items);
  }

  /** 采集成功后在单个事务中替换目标月份，其他月份和被业务引用的记录保持不变。 */
  async replaceAnimeCatalogMonth(
    year: number,
    month: number,
    items: Anime[]
  ): Promise<{ items: Anime[]; addedCount: number; existingCount: number }> {
    return this.persistAnimeCatalog(items, { year, month });
  }

  async clearAnimeCatalog(): Promise<void> {
    const count = Number(this.get("SELECT COUNT(*) AS count FROM anime_catalog")?.count ?? 0);
    this.run(`DELETE FROM anime_catalog
      WHERE id NOT IN (SELECT anime_id FROM my_anime)
        AND id NOT IN (SELECT anime_id FROM episode)
        AND id NOT IN (SELECT anime_id FROM download_task WHERE anime_id IS NOT NULL)
        AND id NOT IN (SELECT anime_id FROM media_file)`);
    const remaining = Number(this.get("SELECT COUNT(*) AS count FROM anime_catalog")?.count ?? 0);
    logger.info("Anime catalog cache cleared", { clearedCount: count - remaining, retainedReferencedCount: remaining });
  }

  async listDownloads(): Promise<DownloadTask[]> {
    const files = this.all("SELECT * FROM torrent_file ORDER BY file_index").map(mapTorrentFile);
    const filesByTask = new Map<string, TorrentFile[]>();
    for (const entry of files) {
      const items = filesByTask.get(entry.downloadTaskId) ?? [];
      items.push(entry.file);
      filesByTask.set(entry.downloadTaskId, items);
    }
    return this.all("SELECT * FROM download_task ORDER BY created_at DESC").map((row) =>
      mapDownload(row, filesByTask.get(asString(row.id)) ?? [])
    );
  }

  async listEpisodes(animeId: string): Promise<Episode[]> {
    return sortEpisodes(
      this.all("SELECT * FROM episode WHERE anime_id = @animeId ORDER BY episode_no", { animeId }).map(mapEpisode)
    );
  }

  async upsertEpisode(episode: Episode): Promise<Episode[]> {
    this.upsertEpisodeRow(episode);
    return this.listEpisodes(episode.animeId);
  }

  /** 汇总全部追番的连续观看进度，优先采用元数据中的总集数。 */
  async listMyAnimeWatchProgress(): Promise<AnimeWatchProgress[]> {
    const items = await this.listMyAnime();
    return Promise.all(items.map(async (item) => this.getAnimeWatchProgress(item, await this.listEpisodes(item.anime.id))));
  }

  /** 在单个事务内补齐单集并批量调整已看状态。 */
  async setAnimeWatchProgress(input: SetAnimeWatchProgressInput): Promise<AnimeWatchProgress> {
    const watchedEpisodeCount = normalizeWatchProgress(input.watchedEpisodeCount);
    const item = (await this.listMyAnime()).find((entry) => entry.anime.id === input.animeId);
    if (!item) {
      throw new Error("追番不存在");
    }

    const episodes = await this.listEpisodes(input.animeId);
    const episodeByNumber = new Map(
      episodes
        .filter((episode) => Number.isSafeInteger(episode.episodeNo) && episode.episodeNo > 0)
        .map((episode) => [episode.episodeNo, episode])
    );
    this.transaction(() => {
      for (let episodeNo = 1; episodeNo <= watchedEpisodeCount; episodeNo += 1) {
        const episode = episodeByNumber.get(episodeNo) ?? {
          id: createDownloadEpisodeId(input.animeId, episodeNo),
          animeId: input.animeId,
          episodeNo,
          status: "aired" as const
        };
        this.upsertEpisodeRow({ ...episode, status: "watched" });
      }

      for (const episode of episodes) {
        if (episode.episodeNo > watchedEpisodeCount && episode.status === "watched") {
          this.upsertEpisodeRow({
            ...episode,
            status: this.resolveEpisodeStatusAfterUnwatch(episode)
          });
        }
      }
      this.run("UPDATE my_anime SET updated_at = @updatedAt WHERE anime_id = @animeId", {
        animeId: input.animeId,
        updatedAt: nowIso()
      });
    });
    const progress = this.getAnimeWatchProgress(item, await this.listEpisodes(input.animeId));
    logger.info("Anime watch progress updated", { ...progress });
    return progress;
  }

  /** 读取指定下载文件最近一次可靠的播放位置。 */
  async getPlaybackCheckpoint(taskId: string, fileIndex?: number): Promise<PlaybackCheckpoint | undefined> {
    const row = this.get(
      "SELECT * FROM playback_checkpoint WHERE task_id = @taskId AND file_index = @fileIndex",
      { taskId, fileIndex: normalizeCheckpointFileIndex(fileIndex) }
    );
    return row ? mapPlaybackCheckpoint(row) : undefined;
  }

  /** 原子覆盖指定下载文件的播放位置和幂等观看标记。 */
  async upsertPlaybackCheckpoint(checkpoint: PlaybackCheckpoint): Promise<PlaybackCheckpoint> {
    this.run(
      `INSERT INTO playback_checkpoint (
        task_id, file_index, position_seconds, duration_seconds, completed, watched_reported, updated_at
      ) VALUES (
        @taskId, @fileIndex, @positionSeconds, @durationSeconds, @completed, @watchedReported, @updatedAt
      ) ON CONFLICT(task_id, file_index) DO UPDATE SET
        position_seconds = excluded.position_seconds,
        duration_seconds = excluded.duration_seconds,
        completed = excluded.completed,
        watched_reported = excluded.watched_reported,
        updated_at = excluded.updated_at`,
      {
        taskId: checkpoint.taskId,
        fileIndex: normalizeCheckpointFileIndex(checkpoint.fileIndex),
        positionSeconds: checkpoint.positionSeconds,
        durationSeconds: checkpoint.durationSeconds,
        completed: toInteger(checkpoint.completed),
        watchedReported: toInteger(checkpoint.watchedReported),
        updatedAt: checkpoint.updatedAt
      }
    );
    return checkpoint;
  }

  async listEpisodePreferences(animeId: string): Promise<EpisodePreference[]> {
    return this.all("SELECT * FROM episode_preference WHERE anime_id = @animeId", { animeId }).map(mapEpisodePreference);
  }

  async upsertEpisodePreference(preference: EpisodePreference): Promise<EpisodePreference[]> {
    this.run(
      `INSERT INTO episode_preference (
        id, anime_id, episode_id, fansub_group_id, release_id, is_manual_override, updated_at
      ) VALUES (
        @id, @animeId, @episodeId, @fansubGroupId, @releaseId, @isManualOverride, @updatedAt
      ) ON CONFLICT(episode_id) DO UPDATE SET
        id = excluded.id, anime_id = excluded.anime_id, fansub_group_id = excluded.fansub_group_id,
        release_id = excluded.release_id, is_manual_override = excluded.is_manual_override,
        updated_at = excluded.updated_at`,
      {
        id: preference.id,
        animeId: preference.animeId,
        episodeId: preference.episodeId,
        fansubGroupId: preference.fansubGroupId ?? null,
        releaseId: preference.releaseId ?? null,
        isManualOverride: toInteger(preference.isManualOverride),
        updatedAt: nowIso()
      }
    );
    return this.listEpisodePreferences(preference.animeId);
  }

  async removeEpisodePreference(episodeId: string): Promise<EpisodePreference[]> {
    const row = this.get("SELECT anime_id FROM episode_preference WHERE episode_id = @episodeId", { episodeId });
    this.run("DELETE FROM episode_preference WHERE episode_id = @episodeId", { episodeId });
    return row ? this.listEpisodePreferences(asString(row.anime_id)) : [];
  }

  async getDownloadTask(taskId: string): Promise<DownloadTask | undefined> {
    const task = (await this.listDownloads()).find((item) => item.id === taskId || item.torrentHash === taskId);
    return task;
  }

  async upsertDownloadTask(task: DownloadTask): Promise<DownloadTask[]> {
    this.transaction(() => this.upsertDownload(this.normalizeDownloadAssociations(task)));
    await this.syncEpisodesFromCurrentDownloads();
    return this.listDownloads();
  }

  async mergeDownloadTasksFromEngine(tasks: DownloadTask[]): Promise<DownloadTask[]> {
    const current = await this.listDownloads();
    const merged = tasks.map((task) => {
      const inferredEpisodeNo = inferDownloadTaskEpisodeNo(task);
      const multiEpisode = isMultiEpisodeDownloadTask(task);
      const engineTask = multiEpisode
        ? { ...task, episodeId: undefined, episodeNo: undefined }
        : inferredEpisodeNo === undefined
          ? task
          : { ...task, episodeNo: inferredEpisodeNo };
      const existing = findExistingDownloadTask(current, engineTask);
      if (existing && inferredEpisodeNo !== undefined && existing.episodeNo !== inferredEpisodeNo) {
        logger.info("Download task episode corrected from torrent files", {
          taskId: task.id,
          torrentHash: task.torrentHash,
          previousEpisodeNo: existing.episodeNo,
          inferredEpisodeNo
        });
      }
      return existing
        ? {
            ...engineTask,
            releaseId: existing.releaseId,
            animeId: existing.animeId,
            episodeId: multiEpisode ? undefined : existing.episodeId,
            animeTitle: existing.animeTitle,
            episodeNo: multiEpisode ? undefined : inferredEpisodeNo ?? existing.episodeNo,
            fansubGroupId: existing.fansubGroupId,
            fansubName: existing.fansubName,
            resolution: existing.resolution,
            declaredVideoCodec: existing.declaredVideoCodec,
            normalizedVideoCodec: existing.normalizedVideoCodec,
            bitDepth: existing.bitDepth,
            subtitleLanguages: existing.subtitleLanguages,
            subtitle: existing.subtitle,
            correlationTag: task.correlationTag ?? existing.correlationTag,
            files: mergeTorrentFileEpisodeLinks(engineTask.files, existing.files),
            createdAt: existing.createdAt,
            completedAt: task.completedAt ?? existing.completedAt
          }
        : engineTask;
    });
    const inactive = current.filter((task) => !isEngineTaskCovered(merged, task));
    await this.replaceDownloadsAndSyncEpisodes([...merged, ...inactive]);
    return this.listDownloads();
  }

  async updateDownloadStatus(taskId: string, status: DownloadStatus): Promise<DownloadTask[]> {
    this.run(
      "UPDATE download_task SET status = @status, updated_at = @updatedAt WHERE id = @taskId OR torrent_hash = @taskId",
      { taskId, status, updatedAt: nowIso() }
    );
    await this.syncEpisodesFromCurrentDownloads();
    return this.listDownloads();
  }

  async removeDownloadTask(taskId: string): Promise<DownloadTask[]> {
    this.run("DELETE FROM download_task WHERE id = @taskId OR torrent_hash = @taskId", { taskId });
    await this.syncEpisodesFromCurrentDownloads();
    return this.listDownloads();
  }

  async listMediaFiles(): Promise<MediaFile[]> {
    return sortMediaFiles(this.all("SELECT * FROM media_file").map(mapMediaFile));
  }

  async upsertMediaFiles(mediaFiles: MediaFile[]): Promise<MediaFile[]> {
    this.transaction(() => {
      for (const mediaFile of mediaFiles) this.upsertMediaFile(mediaFile);
    });
    return this.listMediaFiles();
  }

  async listFansubs(animeId?: string): Promise<FansubGroup[]> {
    if (!animeId) {
      return this.all("SELECT * FROM fansub_group ORDER BY name").map(mapFansub);
    }

    return this.all(
      `SELECT fansub_group.*
       FROM fansub_group
       INNER JOIN anime_fansub_group ON anime_fansub_group.fansub_group_id = fansub_group.id
       WHERE anime_fansub_group.anime_id = @animeId
       ORDER BY anime_fansub_group.last_seen_at DESC, fansub_group.name`,
      { animeId }
    ).map(mapFansub);
  }

  /** 合并资源中识别到的字幕组，并记录其所属番剧。 */
  async observeAnimeFansubs(animeId: string, releases: Release[]): Promise<FansubGroup[]> {
    const discovered = collectDiscoveredFansubs(releases);
    if (!discovered.length) {
      return this.listFansubs(animeId);
    }

    const existingById = new Map((await this.listFansubs()).map((group) => [group.id, group]));
    const timestamp = nowIso();
    this.transaction(() => {
      for (const candidate of discovered) {
        const existing = existingById.get(candidate.id);
        const merged: FansubGroup = {
          id: candidate.id,
          name: existing?.name ?? candidate.name,
          aliases: uniqueStrings([
            ...(existing?.aliases ?? []),
            ...candidate.aliases,
            ...(existing && existing.name !== candidate.name ? [candidate.name] : [])
          ]),
          sourceIds: uniqueStrings([...(existing?.sourceIds ?? []), ...candidate.sourceIds])
        };
        this.upsertFansub(merged);
        this.linkAnimeFansub(animeId, merged.id, timestamp);
      }
    });
    logger.info("Anime fansub groups observed", {
      animeId,
      groupIds: discovered.map((group) => group.id)
    });
    return this.listFansubs(animeId);
  }

  async listSources(): Promise<ReleaseSourceConfig[]> {
    const current = this.all("SELECT * FROM release_source ORDER BY name").map(mapSource);
    const missing = defaultSourceConfigs.filter((source) => !current.some((item) => item.id === source.id));
    if (missing.length) {
      this.transaction(() => missing.forEach((source) => this.upsertSourceRow(source)));
      logger.info("Default release sources added to SQLite", { sourceIds: missing.map((source) => source.id) });
      return this.all("SELECT * FROM release_source ORDER BY name").map(mapSource);
    }
    return current;
  }

  async getSettings(): Promise<AppSettings> {
    const value = this.getState<AppSettings>("settings");
    const defaults = this.settingsProvider.getSettings();
    return value ? mergeSettings(defaults, value) : defaults;
  }

  async updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
    const settings = mergeSettings(await this.getSettings(), patch);
    this.setState("settings", settings, "app_settings");
    return settings;
  }

  async resetSettingsToDefaults(): Promise<AppSettings> {
    const settings = this.settingsProvider.getSettings();
    this.setState("settings", settings, "app_settings");
    logger.info("App settings reset to current platform defaults", {
      defaultDownloadDir: settings.download.defaultDownloadDir,
      userDataDir: settings.storage.userDataDir
    });
    return settings;
  }

  async updateSourceEnabled(sourceId: string, enabled: boolean): Promise<ReleaseSourceConfig[]> {
    await this.listSources();
    this.run("UPDATE release_source SET enabled = @enabled, updated_at = @updatedAt WHERE id = @sourceId", {
      sourceId,
      enabled: toInteger(enabled),
      updatedAt: nowIso()
    });
    return this.listSources();
  }

  async upsertSource(source: ReleaseSourceConfig): Promise<ReleaseSourceConfig[]> {
    this.upsertSourceRow(source);
    return this.listSources();
  }

  /** 读取所有下载源的持久化请求与增量同步状态。 */
  async listSourceSyncStates(): Promise<ReleaseSourceSyncState[]> {
    return this.all("SELECT * FROM release_source_sync_state ORDER BY source_id").map(mapSourceSyncState);
  }

  /** 保存下载源请求退避和每日同步游标。 */
  async upsertSourceSyncState(state: ReleaseSourceSyncState): Promise<ReleaseSourceSyncState[]> {
    this.upsertSourceSyncStateRow(state);
    return this.listSourceSyncStates();
  }

  /** 读取所有业务作用域共享的网络熔断状态。 */
  async listRequestCircuitStates(): Promise<RequestCircuitState[]> {
    return this.all("SELECT * FROM request_circuit_state ORDER BY circuit_key").map(mapRequestCircuitState);
  }

  /** 保存通用网络熔断状态。 */
  async upsertRequestCircuitState(state: RequestCircuitState): Promise<RequestCircuitState[]> {
    this.upsertRequestCircuitStateRow(state);
    return this.listRequestCircuitStates();
  }

  /** 按来源和本地番剧标识读取最近采集的资源缓存。 */
  async listCachedReleases(query: CachedReleaseQuery = {}): Promise<Release[]> {
    const normalizedLimit = Math.max(1, Math.min(10_000, Math.round(query.limit ?? 2_000)));
    const conditions: string[] = [];
    const params: SqliteParams = { limit: normalizedLimit };

    if (query.sourceIds) {
      const uniqueSourceIds = [...new Set(query.sourceIds.filter(Boolean))];
      if (!uniqueSourceIds.length) {
        return [];
      }
      const placeholders = uniqueSourceIds.map((sourceId, index) => {
        const key = `sourceId${index}`;
        params[key] = sourceId;
        return `@${key}`;
      });
      conditions.push(`source_id IN (${placeholders.join(", ")})`);
    }

    if (query.animeId !== undefined) {
      const animeId = query.animeId.trim();
      if (!animeId) {
        return [];
      }
      params.animeId = animeId;
      conditions.push("anime_id = @animeId");
    }

    const whereClause = conditions.length ? ` WHERE ${conditions.join(" AND ")}` : "";
    return this.all(
      `SELECT * FROM release${whereClause} ORDER BY published_at DESC LIMIT @limit`,
      params
    ).map(mapRelease);
  }

  /** 按资源稳定 ID 增量写入缓存，并返回首次出现的资源数量。 */
  async upsertCachedReleases(releases: Release[]): Promise<number> {
    const unique = [...new Map(releases.map((release) => [release.id, release])).values()];
    if (!unique.length) {
      return 0;
    }
    const existing = new Set<string>();
    for (const release of unique) {
      if (this.get("SELECT id FROM release WHERE id = @id", { id: release.id })) {
        existing.add(release.id);
      }
    }
    this.transaction(() => unique.forEach((release) => this.upsertReleaseRow(release)));
    return unique.length - existing.size;
  }

  /** 清理过期资源缓存，限制每日增量同步的长期占用。 */
  async pruneCachedReleases(before: string): Promise<number> {
    return this.run("DELETE FROM release WHERE published_at < @before", { before }).changes;
  }

  /** 读取未过期的资源查询结果，损坏或过期记录会被自动清理。 */
  async getReleaseSearchCache(cacheKey: string): Promise<ReleaseSearchCacheEntry | undefined> {
    const row = this.get(
      "SELECT result_json, expires_at FROM release_search_cache WHERE cache_key = @cacheKey",
      { cacheKey }
    );
    if (!row) {
      return undefined;
    }

    const expiresAt = asString(row.expires_at);
    const expiresAtMs = Date.parse(expiresAt);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
      this.run("DELETE FROM release_search_cache WHERE cache_key = @cacheKey", { cacheKey });
      return undefined;
    }

    try {
      return {
        expiresAt,
        result: fromJson<ReleaseSearchResult>(asString(row.result_json))
      };
    } catch (error) {
      this.run("DELETE FROM release_search_cache WHERE cache_key = @cacheKey", { cacheKey });
      logger.warn("SQLite 资源查询缓存损坏，已清理", {
        message: error instanceof Error ? error.message : String(error)
      });
      return undefined;
    }
  }

  /** 保存资源查询结果，使缓存有效期可跨应用重启。 */
  async upsertReleaseSearchCache(cacheKey: string, entry: ReleaseSearchCacheEntry): Promise<void> {
    const updatedAt = nowIso();
    this.transaction(() => {
      this.run("DELETE FROM release_search_cache WHERE expires_at <= @updatedAt", { updatedAt });
      this.run(
        `INSERT INTO release_search_cache (cache_key, result_json, expires_at, updated_at)
         VALUES (@cacheKey, @resultJson, @expiresAt, @updatedAt)
         ON CONFLICT(cache_key) DO UPDATE SET
           result_json = excluded.result_json,
           expires_at = excluded.expires_at,
           updated_at = excluded.updated_at`,
        {
          cacheKey,
          resultJson: toJson(entry.result),
          expiresAt: entry.expiresAt,
          updatedAt
        }
      );
    });
  }

  async upsertMyAnime(item: MyAnime): Promise<MyAnime[]> {
    const normalized = normalizeMyAnimeAutoDownload(item);
    const saved: MyAnime = { ...normalized, addedAt: normalized.addedAt || nowIso(), updatedAt: nowIso() };
    this.transaction(() => {
      this.upsertAnime(saved.anime);
      this.upsertMyAnimeRow(saved);
    });
    return this.listMyAnime();
  }

  async removeMyAnime(itemId: string): Promise<MyAnime[]> {
    const row = this.get("SELECT anime_id FROM my_anime WHERE id = @itemId", { itemId });
    this.transaction(() => {
      this.run("DELETE FROM my_anime WHERE id = @itemId", { itemId });
      if (row) this.run("DELETE FROM episode WHERE anime_id = @animeId", { animeId: asString(row.anime_id) });
    });
    return this.listMyAnime();
  }

  /** 初始化 SQLite pragma、表结构和版本元数据。 */
  private initialize(): void {
    this.database.pragma("journal_mode = WAL");
    this.database.pragma("foreign_keys = ON");
    this.database.pragma("busy_timeout = 5000");
    this.database.exec(SQLITE_SCHEMA);
    const currentSchemaVersion = Number(this.getMeta("schema_version") ?? 0);
    if (currentSchemaVersion > SQLITE_SCHEMA_VERSION) {
      throw new Error(`SQLite schema version ${currentSchemaVersion} is newer than supported ${SQLITE_SCHEMA_VERSION}`);
    }
    this.migrateSchema(currentSchemaVersion);
    this.setMeta("schema_version", String(SQLITE_SCHEMA_VERSION));
    const currentAppDataVersion = this.getAppDataVersion();
    if (currentAppDataVersion !== undefined) {
      if (currentAppDataVersion > APP_DATA_VERSION) {
        throw new Error(`App data version ${currentAppDataVersion} is newer than supported ${APP_DATA_VERSION}`);
      }
      if (currentAppDataVersion < APP_DATA_VERSION) {
        this.transaction(() => {
          this.migrateAppData(currentAppDataVersion);
          this.setMeta("app_data_version", String(APP_DATA_VERSION));
        });
        logger.info("SQLite app data version migrated", {
          fromVersion: currentAppDataVersion,
          toVersion: APP_DATA_VERSION
        });
      }
      this.maintainStoredData();
    }
    logger.info("SQLite repository initialized", { path: this.databasePath, schemaVersion: SQLITE_SCHEMA_VERSION });
  }

  /** 按应用数据版本执行一次性业务数据迁移。 */
  private migrateAppData(currentAppDataVersion: number): void {
    if (currentAppDataVersion < 22) {
      const removedSourceCount = this.run("DELETE FROM release_source WHERE id = @sourceId", {
        sourceId: "prowlarr"
      }).changes;
      this.run("DELETE FROM request_circuit_state WHERE circuit_key = @circuitKey", {
        circuitKey: "release-source:prowlarr"
      });
      this.run("DELETE FROM release_search_cache");
      this.run("UPDATE release_source SET use_proxy = 0, updated_at = @updatedAt WHERE id = @sourceId", {
        sourceId: "anibt",
        updatedAt: nowIso()
      });
      logger.info("SQLite 默认下载源迁移完成", {
        fromVersion: currentAppDataVersion,
        toVersion: 22,
        removedSourceCount
      });
    }
  }

  /** 维护历史与首启数据中的字幕组引用及下载集数元数据。 */
  private maintainStoredData(): void {
    this.run("DELETE FROM release_search_cache WHERE expires_at <= @now", { now: nowIso() });
    this.mergeDuplicateFansubGroups();
    this.normalizeFansubGroupData();
    this.repairStoredDownloadEpisodeMetadata();
    this.repairStoredDownloadReleaseMetadata();
  }

  /** 补齐已存在 SQLite 数据库缺少的新列。 */
  private migrateSchema(currentSchemaVersion: number): void {
    if (currentSchemaVersion < 2) {
      this.ensureColumn("anime_catalog", "rating_score", "rating_score REAL");
      this.ensureColumn("anime_catalog", "rating_count", "rating_count INTEGER");
      this.ensureColumn("anime_catalog", "rating_source", "rating_source TEXT");
    }

    if (currentSchemaVersion < 3) {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS my_anime_rss_subscription (
          id TEXT PRIMARY KEY,
          my_anime_id TEXT NOT NULL REFERENCES my_anime(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          url TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_my_anime_rss_subscription_my_anime
          ON my_anime_rss_subscription (my_anime_id);
      `);
    }

    if (currentSchemaVersion < 4) {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS anime_source_binding (
          id TEXT PRIMARY KEY,
          anime_id TEXT NOT NULL REFERENCES anime_catalog(id) ON DELETE CASCADE,
          source_id TEXT NOT NULL REFERENCES release_source(id) ON DELETE CASCADE,
          source_anime_id TEXT NOT NULL,
          source_anime_title TEXT,
          source_url TEXT,
          match_method TEXT NOT NULL,
          confidence REAL NOT NULL DEFAULT 0,
          confirmed INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(anime_id, source_id)
        );

        CREATE INDEX IF NOT EXISTS idx_anime_source_binding_source
          ON anime_source_binding (source_id, source_anime_id);
      `);
    }

    if (currentSchemaVersion < 5) {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS anime_fansub_group (
          anime_id TEXT NOT NULL REFERENCES anime_catalog(id) ON DELETE CASCADE,
          fansub_group_id TEXT NOT NULL REFERENCES fansub_group(id) ON DELETE CASCADE,
          first_seen_at TEXT NOT NULL,
          last_seen_at TEXT NOT NULL,
          PRIMARY KEY (anime_id, fansub_group_id)
        );

        CREATE INDEX IF NOT EXISTS idx_anime_fansub_group_anime
          ON anime_fansub_group (anime_id, last_seen_at DESC);

        INSERT OR IGNORE INTO anime_fansub_group (anime_id, fansub_group_id, first_seen_at, last_seen_at)
        SELECT anime_id, default_fansub_group_id, updated_at, updated_at
        FROM my_anime
        WHERE default_fansub_group_id IS NOT NULL;

        INSERT OR IGNORE INTO anime_fansub_group (anime_id, fansub_group_id, first_seen_at, last_seen_at)
        SELECT anime_id, fansub_group_id, updated_at, updated_at
        FROM episode_preference
        WHERE fansub_group_id IS NOT NULL;

        INSERT OR IGNORE INTO anime_fansub_group (anime_id, fansub_group_id, first_seen_at, last_seen_at)
        SELECT anime_id, fansub_group_id, created_at, updated_at
        FROM download_task
        WHERE anime_id IS NOT NULL AND fansub_group_id IS NOT NULL
          AND fansub_group_id IN (SELECT id FROM fansub_group);
      `);
    }

    if (currentSchemaVersion < 6) {
      this.ensureColumn("my_anime_rss_subscription", "preferred_subtitle", "preferred_subtitle TEXT");
    }

    if (currentSchemaVersion < 7) {
      this.ensureColumn("my_anime_rss_subscription", "refresh_interval_minutes", "refresh_interval_minutes INTEGER");
      this.ensureColumn("my_anime_rss_subscription", "last_fetched_at", "last_fetched_at TEXT");
    }

    if (currentSchemaVersion < 9) {
      this.ensureReleaseMetadataColumns();
      logger.info("SQLite 下载技术信息列修复完成", {
        fromVersion: currentSchemaVersion,
        toVersion: SQLITE_SCHEMA_VERSION
      });
    }

    if (currentSchemaVersion < 10) {
      this.ensureColumn("release_source", "use_proxy", "use_proxy INTEGER NOT NULL DEFAULT 0");
      this.ensureColumn("release_source", "request_interval_ms", "request_interval_ms INTEGER NOT NULL DEFAULT 1000");
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS release_source_sync_state (
          source_id TEXT PRIMARY KEY REFERENCES release_source(id) ON DELETE CASCADE,
          request_host TEXT,
          last_request_at TEXT,
          request_failure_count INTEGER NOT NULL DEFAULT 0,
          backoff_until TEXT,
          last_sync_attempt_at TEXT,
          last_successful_sync_at TEXT,
          last_sync_error TEXT,
          etag TEXT,
          last_modified TEXT,
          updated_at TEXT NOT NULL
        );

        UPDATE release_source
        SET use_proxy = 1, request_interval_ms = 1500
        WHERE id IN ('mikan', 'dmhy', 'mikan-site', 'anibt', 'acgnx');

        UPDATE release_source
        SET use_proxy = 0, request_interval_ms = 250
        WHERE id = 'prowlarr';
      `);
      logger.info("SQLite 下载源网络策略迁移完成", {
        fromVersion: currentSchemaVersion,
        toVersion: SQLITE_SCHEMA_VERSION
      });
    }

    if (currentSchemaVersion < 11) {
      this.ensureColumn("release_source_sync_state", "request_host", "request_host TEXT");
    }

    if (currentSchemaVersion < 12) {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS release_search_cache (
          cache_key TEXT PRIMARY KEY,
          result_json TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_release_search_cache_expires_at
          ON release_search_cache (expires_at);
      `);
    }

    if (currentSchemaVersion < 13) {
      this.ensureColumn("anime_catalog", "detail_json", "detail_json TEXT NOT NULL DEFAULT '{}'");
    }

    if (currentSchemaVersion < 14) {
      this.database.exec(`
        INSERT OR IGNORE INTO request_circuit_state (
          circuit_key, circuit_group, request_host, last_request_at, failure_count, backoff_until, updated_at
        )
        SELECT
          'release-source:' || source_id,
          'release-source',
          request_host,
          last_request_at,
          request_failure_count,
          backoff_until,
          updated_at
        FROM release_source_sync_state
        WHERE request_host IS NOT NULL
          OR last_request_at IS NOT NULL
          OR request_failure_count > 0
          OR backoff_until IS NOT NULL;

        UPDATE release_source_sync_state
        SET request_host = NULL,
            last_request_at = NULL,
            request_failure_count = 0,
            backoff_until = NULL;
      `);
      logger.info("SQLite 通用网络熔断状态迁移完成", {
        fromVersion: currentSchemaVersion,
        toVersion: SQLITE_SCHEMA_VERSION
      });
    }

    if (currentSchemaVersion < 15) {
      const removedReleaseCount = this.run("DELETE FROM release WHERE anime_id IS NOT NULL").changes;
      const removedSearchCacheCount = this.run("DELETE FROM release_search_cache").changes;
      logger.info("SQLite 番剧资源缓存关联迁移完成", {
        fromVersion: currentSchemaVersion,
        toVersion: SQLITE_SCHEMA_VERSION,
        removedReleaseCount,
        removedSearchCacheCount
      });
    }

    if (currentSchemaVersion < 16) {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS playback_checkpoint (
          task_id TEXT NOT NULL REFERENCES download_task(id) ON DELETE CASCADE,
          file_index INTEGER NOT NULL DEFAULT -1,
          position_seconds REAL NOT NULL DEFAULT 0,
          duration_seconds REAL NOT NULL DEFAULT 0,
          completed INTEGER NOT NULL DEFAULT 0,
          watched_reported INTEGER NOT NULL DEFAULT 0,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (task_id, file_index)
        );

        CREATE INDEX IF NOT EXISTS idx_playback_checkpoint_updated_at
          ON playback_checkpoint (updated_at DESC);
      `);
      logger.info("SQLite 播放续播记录迁移完成", {
        fromVersion: currentSchemaVersion,
        toVersion: SQLITE_SCHEMA_VERSION
      });
    }

    if (currentSchemaVersion < 17) {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS anime_source_exclusion (
          id TEXT PRIMARY KEY,
          anime_id TEXT NOT NULL REFERENCES anime_catalog(id) ON DELETE CASCADE,
          source_id TEXT NOT NULL REFERENCES release_source(id) ON DELETE CASCADE,
          scope TEXT NOT NULL CHECK(scope IN ('candidate', 'source')),
          source_anime_id TEXT NOT NULL DEFAULT '',
          source_anime_title TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(anime_id, source_id, source_anime_id)
        );

        CREATE INDEX IF NOT EXISTS idx_anime_source_exclusion_lookup
          ON anime_source_exclusion (anime_id, source_id, scope);
      `);
      logger.info("SQLite 来源候选排除记录迁移完成", {
        fromVersion: currentSchemaVersion,
        toVersion: SQLITE_SCHEMA_VERSION
      });
    }

    if (currentSchemaVersion < 18) {
      this.ensureColumn("torrent_file", "episode_id", "episode_id TEXT");
      this.ensureColumn("torrent_file", "episode_no", "episode_no REAL");
      logger.info("SQLite 种子文件单集关联迁移完成", {
        fromVersion: currentSchemaVersion,
        toVersion: SQLITE_SCHEMA_VERSION
      });
    }

    if (currentSchemaVersion < 8) {
      this.database.exec(`
        UPDATE my_anime
        SET preferred_subtitle_languages_json = CASE preferred_subtitle
          WHEN 'chs' THEN '["chs"]'
          WHEN 'cht' THEN '["cht"]'
          WHEN 'jpn' THEN '["jpn"]'
          WHEN 'eng' THEN '["eng"]'
          WHEN 'multi' THEN '["chs","cht"]'
          ELSE '[]'
        END
        WHERE preferred_subtitle_languages_json = '[]' AND preferred_subtitle IS NOT NULL;

        UPDATE my_anime_rss_subscription
        SET preferred_subtitle_languages_json = CASE preferred_subtitle
          WHEN 'chs' THEN '["chs"]'
          WHEN 'cht' THEN '["cht"]'
          WHEN 'jpn' THEN '["jpn"]'
          WHEN 'eng' THEN '["eng"]'
          WHEN 'multi' THEN '["chs","cht"]'
          ELSE '[]'
        END
        WHERE preferred_subtitle_languages_json = '[]' AND preferred_subtitle IS NOT NULL;

        UPDATE release
        SET subtitle_languages_json = CASE subtitle
          WHEN 'chs' THEN '["chs"]'
          WHEN 'cht' THEN '["cht"]'
          WHEN 'jpn' THEN '["jpn"]'
          WHEN 'eng' THEN '["eng"]'
          WHEN 'multi' THEN '["chs","cht"]'
          ELSE '[]'
        END
        WHERE subtitle_languages_json = '[]' AND subtitle IS NOT NULL;
      `);
    }
  }

  /** 将首次启动快照写入各业务表。 */
  private writeSnapshot(data: AppDataFile): void {
    data.animeCatalog.forEach((anime) => this.upsertAnime(anime));
    data.fansubGroups.forEach((fansub) => this.upsertFansub(fansub));
    data.sources.forEach((source) => this.upsertSourceRow(source));
    (data.sourceSyncStates ?? []).forEach((state) => {
      this.upsertSourceSyncStateRow(state);
      if (state.requestHost || state.lastRequestAt || state.requestFailureCount > 0 || state.backoffUntil) {
        this.upsertRequestCircuitStateRow({
          key: `release-source:${state.sourceId}`,
          group: "release-source",
          requestHost: state.requestHost,
          lastRequestAt: state.lastRequestAt,
          failureCount: state.requestFailureCount,
          backoffUntil: state.backoffUntil
        });
      }
    });
    (data.requestCircuitStates ?? []).forEach((state) => this.upsertRequestCircuitStateRow(state));
    data.myAnime.forEach((item) => this.upsertMyAnimeRow(item));
    data.episodes.forEach((episode) => this.upsertEpisodeRow(episode));
    data.episodePreferences.forEach((preference) => this.upsertEpisodePreferenceRow(preference));
    data.downloads.forEach((download) => this.upsertDownload(download));
    data.mediaFiles.forEach((mediaFile) => this.upsertMediaFile(mediaFile));
    data.notifications.forEach((notification) => this.upsertNotification(notification));
    this.setState("settings", data.settings, "app_settings");
    this.setState("dashboard", stripDerivedDashboard(data.dashboard), "app_state");
    this.setMeta("app_data_version", String(APP_DATA_VERSION));
    this.setMeta("app_data_updated_at", data.updatedAt);
  }

  private readSnapshot(): AppDataFile {
    let settings = this.getState<AppSettings>("settings");
    let dashboard = this.getState<DashboardData>("dashboard");
    if (!settings || !dashboard) {
      const defaults = createSeedData(this.settingsProvider);
      settings ??= defaults.settings;
      dashboard ??= defaults.dashboard;
    }
    const animeCatalog = this.readAnimeCatalogSync();
    const myAnime = this.readMyAnimeSync(animeCatalog);
    const downloads = this.readDownloadsSync();
    const mediaFiles = sortMediaFiles(this.all("SELECT * FROM media_file").map(mapMediaFile));
    return {
      version: this.getAppDataVersion() ?? APP_DATA_VERSION,
      settings,
      animeCatalog,
      myAnime,
      episodes: this.all("SELECT * FROM episode ORDER BY anime_id, episode_no").map(mapEpisode),
      episodePreferences: this.all("SELECT * FROM episode_preference").map(mapEpisodePreference),
      fansubGroups: this.all("SELECT * FROM fansub_group ORDER BY name").map(mapFansub),
      sources: this.all("SELECT * FROM release_source ORDER BY name").map(mapSource),
      sourceSyncStates: this.all("SELECT * FROM release_source_sync_state ORDER BY source_id").map(mapSourceSyncState),
      requestCircuitStates: this.all("SELECT * FROM request_circuit_state ORDER BY circuit_key").map(mapRequestCircuitState),
      downloads,
      mediaFiles,
      notifications: sortNotifications(this.all("SELECT * FROM notification").map(mapNotification)),
      dashboard: { ...dashboard, activeDownloads: downloads, recentCompleted: mediaFiles.slice(0, 10) },
      updatedAt: this.getMeta("app_data_updated_at") ?? nowIso()
    };
  }

  private readAnimeCatalogSync(): Anime[] {
    const aliases = this.all("SELECT * FROM anime_alias ORDER BY priority DESC").map(mapAnimeAlias);
    const aliasesByAnime = new Map<string, Anime["aliases"]>();
    for (const alias of aliases) {
      const items = aliasesByAnime.get(alias.animeId) ?? [];
      items.push(alias);
      aliasesByAnime.set(alias.animeId, items);
    }
    return sortAnimeCatalog(
      this.all("SELECT * FROM anime_catalog").map((row) => mapAnime(row, aliasesByAnime.get(asString(row.id)) ?? []))
    );
  }

  private readMyAnimeSync(catalog: Anime[]): MyAnime[] {
    const animeById = new Map(catalog.map((anime) => [anime.id, anime]));
    const rssSubscriptionsByMyAnime = this.readRssSubscriptionsByMyAnime();
    return sortMyAnime(
      this.all("SELECT * FROM my_anime").flatMap((row) => {
        const anime = animeById.get(asString(row.anime_id));
        return anime ? [mapMyAnime(row, anime, rssSubscriptionsByMyAnime.get(asString(row.id)) ?? [])] : [];
      })
    );
  }

  /** 按追番记录读取 RSS 订阅配置。 */
  private readRssSubscriptionsByMyAnime(): Map<string, MyAnime["rssSubscriptions"]> {
    const groups = new Map<string, NonNullable<MyAnime["rssSubscriptions"]>>();
    for (const row of this.all("SELECT * FROM my_anime_rss_subscription ORDER BY created_at, name")) {
      const myAnimeId = asString(row.my_anime_id);
      const items = groups.get(myAnimeId) ?? [];
      items.push({
        id: asString(row.id),
        myAnimeId,
        name: asString(row.name),
        url: asString(row.url),
        enabled: toBoolean(row.enabled),
        preferredSubtitleLanguages: resolveSubtitleLanguages(
          fromJson(asString(row.preferred_subtitle_languages_json)),
          optionalString(row.preferred_subtitle) as MyAnime["preferredSubtitle"]
        ),
        preferredSubtitle: optionalString(row.preferred_subtitle) as MyAnime["preferredSubtitle"],
        refreshIntervalMinutes: optionalNumber(row.refresh_interval_minutes),
        lastFetchedAt: optionalString(row.last_fetched_at),
        createdAt: asString(row.created_at),
        updatedAt: asString(row.updated_at)
      });
      groups.set(myAnimeId, items);
    }
    return groups;
  }

  private readDownloadsSync(): DownloadTask[] {
    const filesByTask = new Map<string, TorrentFile[]>();
    for (const entry of this.all("SELECT * FROM torrent_file ORDER BY file_index").map(mapTorrentFile)) {
      const items = filesByTask.get(entry.downloadTaskId) ?? [];
      items.push(entry.file);
      filesByTask.set(entry.downloadTaskId, items);
    }
    return this.all("SELECT * FROM download_task ORDER BY created_at DESC").map((row) =>
      mapDownload(row, filesByTask.get(asString(row.id)) ?? [])
    );
  }

  private clearAllData(): void {
    for (const table of [
      "notification", "playback_checkpoint", "media_file", "torrent_file", "download_task", "episode_preference", "episode",
      "request_circuit_state", "release_search_cache", "anime_source_exclusion", "anime_source_binding", "my_anime_rss_subscription", "my_anime", "anime_fansub_group", "anime_alias", "release", "anime_catalog", "fansub_group",
      "release_source", "app_settings", "app_state", "app_meta"
    ]) {
      this.database.exec(`DELETE FROM ${table}`);
    }
    this.setMeta("schema_version", String(SQLITE_SCHEMA_VERSION));
  }

  /** 合并并持久化目录；传入月份时先移除该月未引用缓存，再原子提交。 */
  private async persistAnimeCatalog(
    items: Anime[],
    replaceMonth?: { year: number; month: number }
  ): Promise<{ items: Anime[]; addedCount: number; existingCount: number }> {
    const currentCatalog = await this.listAnimeCatalog();
    const referencedAnimeIds = this.readReferencedAnimeIds();
    const followedAnimeIds = new Set(
      this.all("SELECT anime_id FROM my_anime").map((row) => asString(row.anime_id))
    );
    const catalog = replaceMonth
      ? currentCatalog.filter((anime) =>
          anime.premiereYear !== replaceMonth.year ||
          anime.premiereMonth !== replaceMonth.month ||
          referencedAnimeIds.has(anime.id)
        )
      : [...currentCatalog];
    let addedCount = 0;
    let existingCount = 0;

    for (const item of items) {
      const index = catalog.findIndex((anime) => isSameAnime(anime, item));
      if (index >= 0) {
        const existing = catalog[index];
        catalog[index] = {
          ...existing,
          ...item,
          id: existing.id,
          rating: followedAnimeIds.has(existing.id) ? (existing.rating ?? item.rating) : item.rating,
          detail: mergeAnimeDetailMetadata(existing.detail, item.detail),
          aliases: mergeAliases(existing.aliases, item.aliases).map((alias) => ({
            ...alias,
            animeId: existing.id
          })),
          externalIds: { ...existing.externalIds, ...item.externalIds }
        };
        existingCount += 1;
      } else {
        catalog.push(item);
        addedCount += 1;
      }
    }

    const deduped = mergeAnimeMetadataBatches([{ source: "catalog", items: catalog }]);
    const keepIds = new Set([...deduped.map((anime) => anime.id), ...referencedAnimeIds]);
    const deleteIds = this.all("SELECT id FROM anime_catalog")
      .map((row) => asString(row.id))
      .filter((id) => !keepIds.has(id));

    this.transaction(() => {
      for (const id of deleteIds) {
        this.run("DELETE FROM anime_catalog WHERE id = @id", { id });
      }
      for (const anime of deduped) {
        this.upsertAnime(anime);
      }
    });

    if (replaceMonth) {
      logger.info("Anime catalog month replaced", {
        year: replaceMonth.year,
        month: replaceMonth.month,
        removedCount: deleteIds.length,
        collectedCount: items.length,
        retainedReferencedCount: referencedAnimeIds.size
      });
    }

    return {
      items: await this.listAnimeCatalog(),
      addedCount,
      existingCount
    };
  }

  /** 读取不能随目录缓存清理的番剧标识。 */
  private readReferencedAnimeIds(): Set<string> {
    return new Set(
      this.all(
        `SELECT anime_id AS id FROM my_anime
         UNION SELECT anime_id AS id FROM episode
         UNION SELECT anime_id AS id FROM download_task WHERE anime_id IS NOT NULL
         UNION SELECT anime_id AS id FROM media_file WHERE anime_id IS NOT NULL`
      ).map((row) => asString(row.id))
    );
  }

  private upsertAnime(anime: Anime): void {
    const normalizedAliases = normalizeAnimeAliasesForPersistence(anime);
    if (normalizedAliases.changed) {
      logger.warn("Anime aliases normalized before SQLite write", {
        animeId: anime.id,
        inputCount: anime.aliases.length,
        persistedCount: normalizedAliases.aliases.length,
        duplicateIds: normalizedAliases.duplicateIds
      });
    }
    const timestamp = nowIso();
    this.run(
      `INSERT INTO anime_catalog (
        id, title, original_title, premiere_date, premiere_year, premiere_month, season, summary,
        cover_url, rating_score, rating_count, rating_source, external_ids_json, detail_json, created_at, updated_at
      ) VALUES (
        @id, @title, @originalTitle, @premiereDate, @premiereYear, @premiereMonth, @season, @summary,
        @coverUrl, @ratingScore, @ratingCount, @ratingSource, @externalIdsJson, @detailJson, @createdAt, @updatedAt
      ) ON CONFLICT(id) DO UPDATE SET
        title = excluded.title, original_title = excluded.original_title, premiere_date = excluded.premiere_date,
        premiere_year = excluded.premiere_year, premiere_month = excluded.premiere_month, season = excluded.season,
        summary = excluded.summary, cover_url = excluded.cover_url, rating_score = excluded.rating_score,
        rating_count = excluded.rating_count, rating_source = excluded.rating_source,
        external_ids_json = excluded.external_ids_json, detail_json = excluded.detail_json,
        updated_at = excluded.updated_at`,
      {
        id: anime.id, title: anime.title, originalTitle: anime.originalTitle ?? null,
        premiereDate: anime.premiereDate ?? null, premiereYear: anime.premiereYear,
        premiereMonth: anime.premiereMonth, season: anime.season ?? null, summary: anime.summary ?? null,
        coverUrl: anime.coverUrl ?? null, ratingScore: anime.rating?.score ?? null,
        ratingCount: anime.rating?.count ?? null, ratingSource: anime.rating?.source ?? null,
        externalIdsJson: toJson(anime.externalIds),
        detailJson: toJson(normalizeAnimeDetailMetadata(anime.detail) ?? {}),
        createdAt: timestamp, updatedAt: timestamp
      }
    );
    this.run("DELETE FROM anime_alias WHERE anime_id = @animeId", { animeId: anime.id });
    for (const alias of normalizedAliases.aliases) {
      this.run(
        `INSERT INTO anime_alias (id, anime_id, alias, language, priority)
         VALUES (@id, @animeId, @alias, @language, @priority)`,
        { id: alias.id, animeId: anime.id, alias: alias.alias, language: alias.language, priority: alias.priority }
      );
    }
  }

  private upsertFansub(fansub: FansubGroup): void {
    const timestamp = nowIso();
    this.run(
      `INSERT INTO fansub_group (id, name, aliases_json, source_ids_json, created_at, updated_at)
       VALUES (@id, @name, @aliasesJson, @sourceIdsJson, @createdAt, @updatedAt)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, aliases_json = excluded.aliases_json,
       source_ids_json = excluded.source_ids_json, updated_at = excluded.updated_at`,
      { id: fansub.id, name: fansub.name, aliasesJson: toJson(fansub.aliases), sourceIdsJson: toJson(fansub.sourceIds), createdAt: timestamp, updatedAt: timestamp }
    );
  }

  /** 记录某部番剧曾出现过的字幕组，并刷新最近发现时间。 */
  private linkAnimeFansub(animeId: string, fansubGroupId: string, timestamp = nowIso()): void {
    this.run(
      `INSERT INTO anime_fansub_group (anime_id, fansub_group_id, first_seen_at, last_seen_at)
       VALUES (@animeId, @fansubGroupId, @timestamp, @timestamp)
       ON CONFLICT(anime_id, fansub_group_id) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
      { animeId, fansubGroupId, timestamp }
    );
  }

  private upsertMyAnimeRow(item: MyAnime): void {
    const preferredSubtitleLanguages = resolveSubtitleLanguages(
      item.preferredSubtitleLanguages,
      item.preferredSubtitle
    );
    const preferredSubtitle = toLegacySubtitlePreference(preferredSubtitleLanguages);
    this.run(
      `INSERT INTO my_anime (
        id, anime_id, status, default_fansub_group_id, auto_download, download_dir,
        preferred_resolution, preferred_codec, preferred_subtitle, preferred_subtitle_languages_json,
        preferred_bit_depth, added_at, updated_at
      ) VALUES (
        @id, @animeId, @status, @defaultFansubGroupId, @autoDownload, @downloadDir,
        @preferredResolution, @preferredCodec, @preferredSubtitle, @preferredSubtitleLanguagesJson,
        @preferredBitDepth, @addedAt, @updatedAt
      ) ON CONFLICT(id) DO UPDATE SET
        anime_id = excluded.anime_id, status = excluded.status,
        default_fansub_group_id = excluded.default_fansub_group_id, auto_download = excluded.auto_download,
        download_dir = excluded.download_dir, preferred_resolution = excluded.preferred_resolution,
        preferred_codec = excluded.preferred_codec, preferred_subtitle = excluded.preferred_subtitle,
        preferred_subtitle_languages_json = excluded.preferred_subtitle_languages_json,
        preferred_bit_depth = excluded.preferred_bit_depth,
        updated_at = excluded.updated_at`,
      {
        id: item.id, animeId: item.anime.id, status: item.status,
        defaultFansubGroupId: item.defaultFansubGroupId ?? null, autoDownload: toInteger(item.autoDownload),
        downloadDir: item.downloadDir ?? null, preferredResolution: item.preferredResolution ?? null,
        preferredCodec: item.preferredCodec ?? null, preferredSubtitle: preferredSubtitle ?? null,
        preferredSubtitleLanguagesJson: toJson(preferredSubtitleLanguages),
        preferredBitDepth: item.preferredBitDepth ?? null,
        addedAt: item.addedAt, updatedAt: item.updatedAt
      }
    );
    if (item.defaultFansubGroupId) {
      this.linkAnimeFansub(item.anime.id, item.defaultFansubGroupId, item.updatedAt || nowIso());
    }
    this.replaceMyAnimeRssSubscriptions(item);
  }

  /** 用当前追番草稿同步 RSS 订阅配置。 */
  private replaceMyAnimeRssSubscriptions(item: MyAnime): void {
    this.run("DELETE FROM my_anime_rss_subscription WHERE my_anime_id = @myAnimeId", { myAnimeId: item.id });
    for (const subscription of item.rssSubscriptions ?? []) {
      const timestamp = nowIso();
      const preferredSubtitleLanguages = resolveSubtitleLanguages(
        subscription.preferredSubtitleLanguages,
        subscription.preferredSubtitle
      );
      const preferredSubtitle = toLegacySubtitlePreference(preferredSubtitleLanguages);
      this.run(
        `INSERT INTO my_anime_rss_subscription (
          id, my_anime_id, name, url, enabled, preferred_subtitle, preferred_subtitle_languages_json,
          refresh_interval_minutes, last_fetched_at, created_at, updated_at
        ) VALUES (
          @id, @myAnimeId, @name, @url, @enabled, @preferredSubtitle, @preferredSubtitleLanguagesJson,
          @refreshIntervalMinutes, @lastFetchedAt, @createdAt, @updatedAt
        )`,
        {
          id: subscription.id,
          myAnimeId: item.id,
          name: subscription.name,
          url: subscription.url,
          enabled: toInteger(subscription.enabled),
          preferredSubtitle: preferredSubtitle ?? null,
          preferredSubtitleLanguagesJson: toJson(preferredSubtitleLanguages),
          refreshIntervalMinutes: subscription.refreshIntervalMinutes ?? null,
          lastFetchedAt: subscription.lastFetchedAt ?? null,
          createdAt: subscription.createdAt || timestamp,
          updatedAt: subscription.updatedAt || timestamp
        }
      );
    }
  }

  private upsertEpisodeRow(episode: Episode): void {
    const timestamp = nowIso();
    this.run(
      `INSERT INTO episode (id, anime_id, episode_no, title, air_time, status, created_at, updated_at)
       VALUES (@id, @animeId, @episodeNo, @title, @airTime, @status, @createdAt, @updatedAt)
       ON CONFLICT(id) DO UPDATE SET anime_id = excluded.anime_id, episode_no = excluded.episode_no,
       title = excluded.title, air_time = excluded.air_time, status = excluded.status, updated_at = excluded.updated_at`,
      { id: episode.id, animeId: episode.animeId, episodeNo: episode.episodeNo, title: episode.title ?? null,
        airTime: episode.airTime ?? null, status: episode.status, createdAt: timestamp, updatedAt: timestamp }
    );
  }

  private upsertEpisodePreferenceRow(preference: EpisodePreference): void {
    this.run(
      `INSERT INTO episode_preference (id, anime_id, episode_id, fansub_group_id, release_id, is_manual_override, updated_at)
       VALUES (@id, @animeId, @episodeId, @fansubGroupId, @releaseId, @isManualOverride, @updatedAt)
       ON CONFLICT(episode_id) DO UPDATE SET id = excluded.id, anime_id = excluded.anime_id,
       fansub_group_id = excluded.fansub_group_id, release_id = excluded.release_id,
       is_manual_override = excluded.is_manual_override, updated_at = excluded.updated_at`,
      { id: preference.id, animeId: preference.animeId, episodeId: preference.episodeId,
        fansubGroupId: preference.fansubGroupId ?? null, releaseId: preference.releaseId ?? null,
        isManualOverride: toInteger(preference.isManualOverride), updatedAt: nowIso() }
    );
    if (preference.fansubGroupId) {
      this.linkAnimeFansub(preference.animeId, preference.fansubGroupId);
    }
  }

  private upsertSourceRow(source: ReleaseSourceConfig): void {
    const timestamp = nowIso();
    this.run(
      `INSERT INTO release_source (
        id, name, kind, enabled, use_proxy, request_interval_ms, base_url, api_key, rss_url, tags_json, created_at, updated_at
       ) VALUES (
        @id, @name, @kind, @enabled, @useProxy, @requestIntervalMs, @baseUrl, @apiKey, @rssUrl, @tagsJson, @createdAt, @updatedAt
       )
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, kind = excluded.kind, enabled = excluded.enabled,
       use_proxy = excluded.use_proxy, request_interval_ms = excluded.request_interval_ms,
       base_url = excluded.base_url, api_key = excluded.api_key, rss_url = excluded.rss_url,
       tags_json = excluded.tags_json, updated_at = excluded.updated_at`,
      { id: source.id, name: source.name, kind: source.kind, enabled: toInteger(source.enabled),
        useProxy: toInteger(source.useProxy ?? false), requestIntervalMs: normalizeSourceRequestInterval(source.requestIntervalMs),
        baseUrl: source.baseUrl ?? null, apiKey: source.apiKey ?? null, rssUrl: source.rssUrl ?? null,
        tagsJson: toJson(source.tags ?? []), createdAt: timestamp, updatedAt: timestamp }
    );
  }

  private upsertSourceSyncStateRow(state: ReleaseSourceSyncState): void {
    this.run(
      `INSERT INTO release_source_sync_state (
        source_id, request_host, last_request_at, request_failure_count, backoff_until, last_sync_attempt_at,
        last_successful_sync_at, last_sync_error, etag, last_modified, updated_at
      ) VALUES (
        @sourceId, @requestHost, @lastRequestAt, @requestFailureCount, @backoffUntil, @lastSyncAttemptAt,
        @lastSuccessfulSyncAt, @lastSyncError, @etag, @lastModified, @updatedAt
      ) ON CONFLICT(source_id) DO UPDATE SET
        request_host = excluded.request_host,
        last_request_at = excluded.last_request_at,
        request_failure_count = excluded.request_failure_count,
        backoff_until = excluded.backoff_until,
        last_sync_attempt_at = excluded.last_sync_attempt_at,
        last_successful_sync_at = excluded.last_successful_sync_at,
        last_sync_error = excluded.last_sync_error,
        etag = excluded.etag,
        last_modified = excluded.last_modified,
        updated_at = excluded.updated_at`,
      {
        sourceId: state.sourceId,
        requestHost: state.requestHost ?? null,
        lastRequestAt: state.lastRequestAt ?? null,
        requestFailureCount: Math.max(0, Math.round(state.requestFailureCount)),
        backoffUntil: state.backoffUntil ?? null,
        lastSyncAttemptAt: state.lastSyncAttemptAt ?? null,
        lastSuccessfulSyncAt: state.lastSuccessfulSyncAt ?? null,
        lastSyncError: state.lastSyncError ?? null,
        etag: state.etag ?? null,
        lastModified: state.lastModified ?? null,
        updatedAt: nowIso()
      }
    );
  }

  private upsertRequestCircuitStateRow(state: RequestCircuitState): void {
    this.run(
      `INSERT INTO request_circuit_state (
        circuit_key, circuit_group, request_host, last_request_at, failure_count, backoff_until, updated_at
      ) VALUES (
        @key, @group, @requestHost, @lastRequestAt, @failureCount, @backoffUntil, @updatedAt
      ) ON CONFLICT(circuit_key) DO UPDATE SET
        circuit_group = excluded.circuit_group,
        request_host = excluded.request_host,
        last_request_at = excluded.last_request_at,
        failure_count = excluded.failure_count,
        backoff_until = excluded.backoff_until,
        updated_at = excluded.updated_at`,
      {
        key: state.key,
        group: state.group,
        requestHost: state.requestHost ?? null,
        lastRequestAt: state.lastRequestAt ?? null,
        failureCount: Math.max(0, Math.round(state.failureCount)),
        backoffUntil: state.backoffUntil ?? null,
        updatedAt: nowIso()
      }
    );
  }

  private upsertReleaseRow(release: Release): void {
    const animeId = release.animeId && this.get("SELECT id FROM anime_catalog WHERE id = @id", { id: release.animeId })
      ? release.animeId
      : null;
    const fansubGroupId = release.fansubGroupId && this.get("SELECT id FROM fansub_group WHERE id = @id", { id: release.fansubGroupId })
      ? release.fansubGroupId
      : null;
    this.run(
      `INSERT INTO release (
        id, title, anime_id, episode_no, fansub_group_id, source_id, source_name, magnet_url, torrent_url,
        info_hash, size, resolution, declared_video_codec, normalized_video_codec, bit_depth, subtitle,
        subtitle_languages_json, published_at, seeders, raw_json
      ) VALUES (
        @id, @title, @animeId, @episodeNo, @fansubGroupId, @sourceId, @sourceName, @magnetUrl, @torrentUrl,
        @infoHash, @size, @resolution, @declaredVideoCodec, @normalizedVideoCodec, @bitDepth, @subtitle,
        @subtitleLanguagesJson, @publishedAt, @seeders, @rawJson
      ) ON CONFLICT(id) DO UPDATE SET
        title = excluded.title, anime_id = COALESCE(excluded.anime_id, release.anime_id), episode_no = excluded.episode_no,
        fansub_group_id = excluded.fansub_group_id, source_name = excluded.source_name,
        magnet_url = excluded.magnet_url, torrent_url = excluded.torrent_url, info_hash = excluded.info_hash,
        size = excluded.size, resolution = excluded.resolution, declared_video_codec = excluded.declared_video_codec,
        normalized_video_codec = excluded.normalized_video_codec, bit_depth = excluded.bit_depth,
        subtitle = excluded.subtitle, subtitle_languages_json = excluded.subtitle_languages_json,
        published_at = excluded.published_at, seeders = excluded.seeders, raw_json = excluded.raw_json`,
      {
        id: release.id,
        title: release.title,
        animeId,
        episodeNo: release.episodeNo ?? null,
        fansubGroupId,
        sourceId: release.sourceId,
        sourceName: release.sourceName,
        magnetUrl: release.magnetUrl ?? null,
        torrentUrl: release.torrentUrl ?? null,
        infoHash: release.infoHash ?? null,
        size: release.size ?? null,
        resolution: release.resolution ?? null,
        declaredVideoCodec: release.declaredVideoCodec ?? null,
        normalizedVideoCodec: release.normalizedVideoCodec ?? null,
        bitDepth: release.bitDepth ?? null,
        subtitle: release.subtitle ?? null,
        subtitleLanguagesJson: toJson(resolveSubtitleLanguages(release.subtitleLanguages, release.subtitle)),
        publishedAt: release.publishedAt,
        seeders: release.seeders ?? null,
        rawJson: toJson(release)
      }
    );
  }

  private upsertDownload(task: DownloadTask): void {
    this.run(
      `INSERT INTO download_task (
        id, release_id, anime_id, episode_id, anime_title, episode_no, fansub_group_id, fansub_name,
        resolution, declared_video_codec, normalized_video_codec, bit_depth, subtitle_languages_json, subtitle,
        correlation_tag, engine, torrent_hash, name, status, progress, download_speed, upload_speed,
        eta_seconds, save_path, created_at, completed_at, updated_at
      ) VALUES (
        @id, @releaseId, @animeId, @episodeId, @animeTitle, @episodeNo, @fansubGroupId, @fansubName,
        @resolution, @declaredVideoCodec, @normalizedVideoCodec, @bitDepth, @subtitleLanguagesJson, @subtitle,
        @correlationTag, @engine, @torrentHash, @name, @status, @progress, @downloadSpeed, @uploadSpeed,
        @etaSeconds, @savePath, @createdAt, @completedAt, @updatedAt
      ) ON CONFLICT(id) DO UPDATE SET
        release_id = excluded.release_id, anime_id = excluded.anime_id, episode_id = excluded.episode_id,
        anime_title = excluded.anime_title, episode_no = excluded.episode_no,
        fansub_group_id = excluded.fansub_group_id, fansub_name = excluded.fansub_name,
        resolution = excluded.resolution, declared_video_codec = excluded.declared_video_codec,
        normalized_video_codec = excluded.normalized_video_codec, bit_depth = excluded.bit_depth,
        subtitle_languages_json = excluded.subtitle_languages_json, subtitle = excluded.subtitle,
        correlation_tag = excluded.correlation_tag, engine = excluded.engine, torrent_hash = excluded.torrent_hash,
        name = excluded.name, status = excluded.status, progress = excluded.progress,
        download_speed = excluded.download_speed, upload_speed = excluded.upload_speed,
        eta_seconds = excluded.eta_seconds, save_path = excluded.save_path,
        completed_at = excluded.completed_at, updated_at = excluded.updated_at`,
      {
        id: task.id, releaseId: task.releaseId ?? null, animeId: task.animeId ?? null,
        episodeId: task.episodeId ?? null, animeTitle: task.animeTitle ?? null, episodeNo: task.episodeNo ?? null,
        fansubGroupId: task.fansubGroupId ?? null, fansubName: task.fansubName ?? null,
        resolution: task.resolution ?? null, declaredVideoCodec: task.declaredVideoCodec ?? null,
        normalizedVideoCodec: task.normalizedVideoCodec ?? null, bitDepth: task.bitDepth ?? null,
        subtitleLanguagesJson: toJson(normalizeSubtitleLanguages(task.subtitleLanguages)),
        subtitle: task.subtitle ?? toLegacySubtitlePreference(task.subtitleLanguages) ?? null,
        correlationTag: task.correlationTag ?? null, engine: task.engine, torrentHash: task.torrentHash ?? null,
        name: task.name, status: task.status, progress: task.progress, downloadSpeed: task.downloadSpeed,
        uploadSpeed: task.uploadSpeed, etaSeconds: task.etaSeconds ?? null, savePath: task.savePath,
        createdAt: task.createdAt, completedAt: task.completedAt ?? null, updatedAt: nowIso()
      }
    );
    this.run("DELETE FROM torrent_file WHERE download_task_id = @taskId", { taskId: task.id });
    for (const file of task.files) {
      this.run(
        `INSERT INTO torrent_file (
          id, download_task_id, file_index, name, episode_id, episode_no, size, progress, priority, selected
        ) VALUES (
          @id, @taskId, @fileIndex, @name, @episodeId, @episodeNo, @size, @progress, @priority, @selected
        )`,
        { id: file.id, taskId: task.id, fileIndex: file.index, name: file.name,
          episodeId: file.episodeId ?? null, episodeNo: file.episodeNo ?? null, size: file.size,
          progress: file.progress, priority: file.priority, selected: toInteger(file.selected) }
      );
    }
  }

  private upsertMediaFile(mediaFile: MediaFile): void {
    this.run("DELETE FROM media_file WHERE file_path = @filePath AND id <> @id", {
      filePath: mediaFile.filePath,
      id: mediaFile.id
    });
    this.run(
      `INSERT INTO media_file (
        id, anime_id, episode_id, download_task_id, file_path, file_name, size, container,
        declared_video_codec, detected_video_codec, normalized_video_codec, resolution, bit_depth,
        audio_codecs_json, subtitle_tracks_json, duration_seconds, downloaded_at, probed_at
      ) VALUES (
        @id, @animeId, @episodeId, @downloadTaskId, @filePath, @fileName, @size, @container,
        @declaredVideoCodec, @detectedVideoCodec, @normalizedVideoCodec, @resolution, @bitDepth,
        @audioCodecsJson, @subtitleTracksJson, @durationSeconds, @downloadedAt, @probedAt
      ) ON CONFLICT(id) DO UPDATE SET
        anime_id = excluded.anime_id, episode_id = excluded.episode_id, download_task_id = excluded.download_task_id,
        file_path = excluded.file_path, file_name = excluded.file_name, size = excluded.size,
        container = excluded.container, declared_video_codec = excluded.declared_video_codec,
        detected_video_codec = excluded.detected_video_codec, normalized_video_codec = excluded.normalized_video_codec,
        resolution = excluded.resolution, bit_depth = excluded.bit_depth,
        audio_codecs_json = excluded.audio_codecs_json, subtitle_tracks_json = excluded.subtitle_tracks_json,
        duration_seconds = excluded.duration_seconds, downloaded_at = excluded.downloaded_at, probed_at = excluded.probed_at`,
      {
        id: mediaFile.id, animeId: mediaFile.animeId, episodeId: mediaFile.episodeId ?? null,
        downloadTaskId: mediaFile.downloadTaskId ?? null, filePath: mediaFile.filePath, fileName: mediaFile.fileName,
        size: mediaFile.size, container: mediaFile.container ?? null,
        declaredVideoCodec: mediaFile.declaredVideoCodec ?? null, detectedVideoCodec: mediaFile.detectedVideoCodec ?? null,
        normalizedVideoCodec: mediaFile.normalizedVideoCodec, resolution: mediaFile.resolution ?? null,
        bitDepth: mediaFile.bitDepth ?? null, audioCodecsJson: toJson(mediaFile.audioCodecs),
        subtitleTracksJson: toJson(mediaFile.subtitleTracks), durationSeconds: mediaFile.durationSeconds ?? null,
        downloadedAt: mediaFile.downloadedAt ?? null, probedAt: mediaFile.probedAt ?? null
      }
    );
  }

  private upsertNotification(record: NotificationRecord): void {
    this.run(
      `INSERT INTO notification (
        id, kind, title, body, severity, anime_id, episode_id, download_task_id, created_at, read_at
      ) VALUES (
        @id, @kind, @title, @body, @severity, @animeId, @episodeId, @downloadTaskId, @createdAt, @readAt
      ) ON CONFLICT(id) DO UPDATE SET
        kind = excluded.kind, title = excluded.title, body = excluded.body, severity = excluded.severity,
        anime_id = excluded.anime_id, episode_id = excluded.episode_id,
        download_task_id = excluded.download_task_id, created_at = excluded.created_at, read_at = excluded.read_at`,
      { id: record.id, kind: record.kind, title: record.title, body: record.body, severity: record.severity,
        animeId: record.animeId ?? null, episodeId: record.episodeId ?? null,
        downloadTaskId: record.downloadTaskId ?? null, createdAt: record.createdAt, readAt: record.readAt ?? null }
    );
  }

  private async replaceDownloadsAndSyncEpisodes(downloads: DownloadTask[]): Promise<void> {
    this.transaction(() => {
      const normalizedDownloads = downloads.map((task) => this.normalizeDownloadAssociations(task));
      normalizedDownloads.forEach((task) => this.upsertDownload(task));
      const keepIds = new Set(normalizedDownloads.map((task) => task.id));
      for (const row of this.all("SELECT id FROM download_task")) {
        const id = asString(row.id);
        if (!keepIds.has(id)) {
          this.run("DELETE FROM download_task WHERE id = @id", { id });
        }
      }
    });
    await this.syncEpisodesFromCurrentDownloads();
  }

  /** 启动时根据已保存的视频文件名修复历史下载任务的错误集数关联。 */
  private repairStoredDownloadEpisodeMetadata(): void {
    const current = this.readDownloadsSync();
    let repairedCount = 0;

    this.transaction(() => {
      for (const task of current) {
        const inferredEpisodeNo = inferDownloadTaskEpisodeNo(task);
        const normalized = this.normalizeDownloadAssociations(
          inferredEpisodeNo === undefined ? task : { ...task, episodeNo: inferredEpisodeNo }
        );
        if (downloadAssociationSignature(task) === downloadAssociationSignature(normalized)) {
          continue;
        }

        this.upsertDownload(normalized);
        repairedCount += 1;
      }
    });

    if (repairedCount > 0) {
      const snapshot = this.readSnapshot();
      syncEpisodeStatusesFromDownloads(snapshot);
      this.transaction(() => snapshot.episodes.forEach((episode) => this.upsertEpisodeRow(episode)));
      logger.info("Stored download episode metadata repaired", { repairedCount });
    }
  }

  /** 启动时从历史任务标题补齐编码、位深和字幕语言快照。 */
  private repairStoredDownloadReleaseMetadata(): void {
    const current = this.readDownloadsSync();
    let repairedCount = 0;

    this.transaction(() => {
      for (const task of current) {
        const release = enrichReleaseFromTitle({
          id: task.releaseId ?? task.id,
          title: task.name,
          sourceId: task.engine,
          sourceName: task.engine,
          publishedAt: task.createdAt,
          resolution: task.resolution,
          declaredVideoCodec: task.declaredVideoCodec,
          normalizedVideoCodec: task.normalizedVideoCodec,
          bitDepth: task.bitDepth,
          subtitleLanguages: task.subtitleLanguages,
          subtitle: task.subtitle
        });
        const normalized: DownloadTask = {
          ...task,
          resolution: release.resolution,
          declaredVideoCodec: release.declaredVideoCodec,
          normalizedVideoCodec: release.normalizedVideoCodec,
          bitDepth: release.bitDepth,
          subtitleLanguages: release.subtitleLanguages,
          subtitle: release.subtitle
        };
        const changed = task.resolution !== normalized.resolution ||
          task.declaredVideoCodec !== normalized.declaredVideoCodec ||
          task.normalizedVideoCodec !== normalized.normalizedVideoCodec ||
          task.bitDepth !== normalized.bitDepth ||
          task.subtitle !== normalized.subtitle ||
          toJson(task.subtitleLanguages ?? []) !== toJson(normalized.subtitleLanguages ?? []);
        if (!changed) {
          continue;
        }

        this.upsertDownload(normalized);
        repairedCount += 1;
      }
    });

    if (repairedCount > 0) {
      logger.info("Stored download release metadata repaired", { repairedCount });
    }
  }

  /** 规范单集任务和合集文件关联，合集任务本身不绑定某一集。 */
  private normalizeDownloadAssociations(task: DownloadTask): DownloadTask {
    const animeId = task.animeId;
    if (!animeId) {
      return task;
    }

    const multiEpisode = isMultiEpisodeDownloadTask(task);
    const normalizedTask = multiEpisode
      ? { ...task, episodeId: undefined, episodeNo: undefined }
      : this.normalizeDownloadEpisodeLink(task);
    if (!multiEpisode || task.files.length === 0) {
      return normalizedTask;
    }

    const parsedTask = parseReleaseTitle(task.name);
    const inferredEpisodeNumbers = task.files
      .map((file) => inferTorrentFileEpisodeNo(task, file))
      .filter((episodeNo): episodeNo is number => episodeNo !== undefined);
    const canCreateMissingEpisodes = Boolean(parsedTask.episodeRange) ||
      isContiguousEpisodeSequence(inferredEpisodeNumbers);
    let linkedFileCount = 0;
    const files = task.files.map((file) => {
      const inferredEpisodeNo = inferTorrentFileEpisodeNo(task, file);
      const storedEpisodeNo = file.episodeNo;
      const storedEpisodeInRange = storedEpisodeNo !== undefined && (!parsedTask.episodeRange || (
        storedEpisodeNo >= parsedTask.episodeRange.start && storedEpisodeNo <= parsedTask.episodeRange.end
      ));
      const episodeNo = inferredEpisodeNo ?? (storedEpisodeInRange ? storedEpisodeNo : undefined);
      if (episodeNo === undefined) {
        return { ...file, episodeId: undefined, episodeNo: undefined };
      }

      let episodeByNumber = this.get(
        "SELECT id FROM episode WHERE anime_id = @animeId AND episode_no = @episodeNo",
        { animeId, episodeNo }
      );
      if (!episodeByNumber && canCreateMissingEpisodes) {
        const episodeId = createDownloadEpisodeId(animeId, episodeNo);
        this.upsertEpisodeRow({
          id: episodeId,
          animeId,
          episodeNo,
          status: resolveEpisodeStatusFromDownload(task)
        });
        episodeByNumber = { id: episodeId };
      }
      if (!episodeByNumber) {
        return { ...file, episodeId: undefined, episodeNo: undefined };
      }

      linkedFileCount += 1;
      return { ...file, episodeId: asString(episodeByNumber.id), episodeNo };
    });

    if (downloadAssociationSignature(task) !== downloadAssociationSignature({ ...normalizedTask, files })) {
      logger.info("Download collection files linked to episodes", {
        taskId: task.id,
        animeId: task.animeId,
        linkedFileCount,
        totalFileCount: task.files.length
      });
    }
    return { ...normalizedTask, files };
  }

  /** 根据番剧和集数修正下载任务的单集关联，缺失单集时自动补建。 */
  private normalizeDownloadEpisodeLink(task: DownloadTask): DownloadTask {
    if (!task.animeId || task.episodeNo === undefined) {
      return task;
    }

    const episodeByNumber = this.get(
      "SELECT id FROM episode WHERE anime_id = @animeId AND episode_no = @episodeNo",
      { animeId: task.animeId, episodeNo: task.episodeNo }
    );
    if (episodeByNumber) {
      const episodeId = asString(episodeByNumber.id);
      if (task.episodeId !== episodeId) {
        logger.info("Download task episode link repaired", {
          taskId: task.id,
          animeId: task.animeId,
          previousEpisodeId: task.episodeId,
          episodeId,
          episodeNo: task.episodeNo
        });
      }
      return { ...task, episodeId };
    }

    const episodeId = createDownloadEpisodeId(task.animeId, task.episodeNo);
    this.upsertEpisodeRow({
      id: episodeId,
      animeId: task.animeId,
      episodeNo: task.episodeNo,
      status: resolveEpisodeStatusFromDownload(task)
    });
    logger.info("Episode created from download task metadata", {
      taskId: task.id,
      animeId: task.animeId,
      episodeId,
      episodeNo: task.episodeNo
    });
    return { ...task, episodeId };
  }

  /** 根据单集状态和番剧元数据生成稳定的观看进度摘要。 */
  private getAnimeWatchProgress(item: MyAnime, episodes: Episode[]): AnimeWatchProgress {
    const knownEpisodeCount = episodes.reduce(
      (maximum, episode) => Number.isSafeInteger(episode.episodeNo) && episode.episodeNo > 0
        ? Math.max(maximum, episode.episodeNo)
        : maximum,
      0
    );
    const watchedEpisodeCount = episodes.reduce(
      (maximum, episode) => episode.status === "watched" && Number.isSafeInteger(episode.episodeNo) && episode.episodeNo > 0
        ? Math.max(maximum, episode.episodeNo)
        : maximum,
      0
    );
    const metadataEpisodeCount = Number.isSafeInteger(item.anime.detail?.episodeCount) && item.anime.detail!.episodeCount! > 0
      ? item.anime.detail!.episodeCount!
      : 0;
    return {
      animeId: item.anime.id,
      watchedEpisodeCount,
      totalEpisodeCount: Math.max(metadataEpisodeCount, knownEpisodeCount, watchedEpisodeCount)
    };
  }

  /** 取消已看时根据关联下载和放送时间恢复单集生命周期状态。 */
  private resolveEpisodeStatusAfterUnwatch(episode: Episode): Episode["status"] {
    const downloads = this.all(
      `SELECT download_task.status, download_task.progress, torrent_file.progress AS file_progress
       FROM download_task
       LEFT JOIN torrent_file
         ON torrent_file.download_task_id = download_task.id
        AND torrent_file.selected = 1
        AND (torrent_file.episode_id = @episodeId OR torrent_file.episode_no = @episodeNo)
       WHERE download_task.anime_id = @animeId
         AND (
           download_task.episode_id = @episodeId
           OR download_task.episode_no = @episodeNo
           OR torrent_file.id IS NOT NULL
         )`,
      { animeId: episode.animeId, episodeId: episode.id, episodeNo: episode.episodeNo }
    ).map((row) => ({
      status: asString(row.status) as DownloadStatus,
      progress: Math.max(Number(row.progress), optionalNumber(row.file_progress) ?? 0)
    }));
    if (downloads.some(isCompletedDownloadTask)) {
      return "downloaded";
    }
    if (downloads.some(isActiveDownloadTask)) {
      return "downloading";
    }
    if (episode.airTime && new Date(episode.airTime).getTime() > Date.now()) {
      return "upcoming";
    }
    return "aired";
  }

  private async syncEpisodesFromCurrentDownloads(): Promise<void> {
    const snapshot = this.readSnapshot();
    syncEpisodeStatusesFromDownloads(snapshot);
    this.transaction(() => snapshot.episodes.forEach((episode) => this.upsertEpisodeRow(episode)));
  }

  /** 按规范名称合并历史重复字幕组，并重写所有关联引用。 */
  private mergeDuplicateFansubGroups(): void {
    const groups = this.all("SELECT * FROM fansub_group ORDER BY created_at, id").map(mapFansub);
    const clusters = buildFansubMergeClusters(groups).filter((cluster) => cluster.length > 1);
    if (clusters.length === 0) {
      return;
    }

    let mergedCount = 0;
    this.transaction(() => {
      for (const cluster of clusters) {
        const canonical = selectCanonicalFansub(cluster);
        const duplicates = cluster.filter((group) => group.id !== canonical.id);
        const merged: FansubGroup = {
          ...canonical,
          aliases: uniqueStrings(cluster.flatMap((group) => [
            ...group.aliases,
            ...(group.id === canonical.id ? [] : [group.name])
          ])).filter((alias) => normalizeFansubDisplayName(alias) !== normalizeFansubDisplayName(canonical.name)),
          sourceIds: uniqueStrings(cluster.flatMap((group) => group.sourceIds))
        };
        this.upsertFansub(merged);

        for (const duplicate of duplicates) {
          this.replaceFansubReferences(duplicate.id, canonical.id, canonical.name);
          this.run("DELETE FROM fansub_group WHERE id = @duplicateId", { duplicateId: duplicate.id });
          mergedCount += 1;
        }
      }
    });
    logger.info("Duplicate fansub groups merged", { clusterCount: clusters.length, mergedCount });
  }

  /** 将一个重复字幕组的业务引用迁移到规范字幕组。 */
  private replaceFansubReferences(duplicateId: string, canonicalId: string, canonicalName: string): void {
    const links = this.all(
      "SELECT anime_id, first_seen_at, last_seen_at FROM anime_fansub_group WHERE fansub_group_id = @duplicateId",
      { duplicateId }
    );
    for (const link of links) {
      const animeId = asString(link.anime_id);
      const existing = this.get(
        "SELECT first_seen_at, last_seen_at FROM anime_fansub_group WHERE anime_id = @animeId AND fansub_group_id = @canonicalId",
        { animeId, canonicalId }
      );
      if (existing) {
        this.run(
          `UPDATE anime_fansub_group
           SET first_seen_at = @firstSeenAt, last_seen_at = @lastSeenAt
           WHERE anime_id = @animeId AND fansub_group_id = @canonicalId`,
          {
            animeId,
            canonicalId,
            firstSeenAt: [asString(existing.first_seen_at), asString(link.first_seen_at)].sort()[0],
            lastSeenAt: [asString(existing.last_seen_at), asString(link.last_seen_at)].sort().at(-1) ?? nowIso()
          }
        );
      } else {
        this.run(
          `INSERT INTO anime_fansub_group (anime_id, fansub_group_id, first_seen_at, last_seen_at)
           VALUES (@animeId, @canonicalId, @firstSeenAt, @lastSeenAt)`,
          {
            animeId,
            canonicalId,
            firstSeenAt: asString(link.first_seen_at),
            lastSeenAt: asString(link.last_seen_at)
          }
        );
      }
    }

    this.run("UPDATE my_anime SET default_fansub_group_id = @canonicalId WHERE default_fansub_group_id = @duplicateId", { canonicalId, duplicateId });
    this.run("UPDATE episode_preference SET fansub_group_id = @canonicalId WHERE fansub_group_id = @duplicateId", { canonicalId, duplicateId });
    this.run("UPDATE release SET fansub_group_id = @canonicalId WHERE fansub_group_id = @duplicateId", { canonicalId, duplicateId });
    this.run(
      `UPDATE download_task
       SET fansub_group_id = @canonicalId, fansub_name = @canonicalName
       WHERE fansub_group_id = @duplicateId`,
      { canonicalId, canonicalName, duplicateId }
    );
    this.run("DELETE FROM anime_fansub_group WHERE fansub_group_id = @duplicateId", { duplicateId });
  }

  /** 清理字幕组自别名，并统一已关联下载任务的展示名称。 */
  private normalizeFansubGroupData(): void {
    const groups = this.all("SELECT * FROM fansub_group ORDER BY id").map(mapFansub);
    let aliasGroupCount = 0;
    let downloadTaskCount = 0;

    this.transaction(() => {
      for (const group of groups) {
        const aliases = uniqueStrings(group.aliases)
          .filter((alias) => normalizeFansubDisplayName(alias) !== normalizeFansubDisplayName(group.name));
        if (aliases.length !== group.aliases.length || aliases.some((alias, index) => alias !== group.aliases[index])) {
          this.upsertFansub({ ...group, aliases });
          aliasGroupCount += 1;
        }

        const result = this.run(
          `UPDATE download_task
           SET fansub_name = @fansubName
           WHERE fansub_group_id = @fansubGroupId
             AND (fansub_name IS NULL OR fansub_name <> @fansubName)`,
          { fansubGroupId: group.id, fansubName: group.name }
        );
        downloadTaskCount += result.changes;
      }
    });

    if (aliasGroupCount > 0 || downloadTaskCount > 0) {
      logger.info("Fansub group data normalized", { aliasGroupCount, downloadTaskCount });
    }
  }

  private getMeta(key: string): string | undefined {
    const row = this.get("SELECT value FROM app_meta WHERE key = @key", { key });
    return row ? asString(row.value) : undefined;
  }

  private setMeta(key: string, value: string): void {
    this.run(
      `INSERT INTO app_meta (key, value, updated_at) VALUES (@key, @value, @updatedAt)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      { key, value, updatedAt: nowIso() }
    );
  }

  private getState<T>(key: string): T | undefined {
    const table = key === "settings" ? "app_settings" : "app_state";
    const row = this.get(`SELECT value_json FROM ${table} WHERE key = @key`, { key });
    return row ? fromJson<T>(asString(row.value_json)) : undefined;
  }

  private setState(key: string, value: unknown, table: "app_settings" | "app_state"): void {
    this.run(
      `INSERT INTO ${table} (key, value_json, updated_at) VALUES (@key, @valueJson, @updatedAt)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      { key, valueJson: toJson(value), updatedAt: nowIso() }
    );
  }

  private transaction<T>(operation: () => T): T {
    return this.database.transaction(operation)();
  }

  private run(sql: string, params: SqliteParams = {}): Database.RunResult {
    return this.database.prepare(sql).run(params);
  }

  private get(sql: string, params: SqliteParams = {}): SqliteRow | undefined {
    return this.database.prepare(sql).get(params) as SqliteRow | undefined;
  }

  private all(sql: string, params: SqliteParams = {}): SqliteRow[] {
    return this.database.prepare(sql).all(params) as SqliteRow[];
  }

  /** 在旧库迁移时按需追加列。 */
  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.all(`PRAGMA table_info(${table})`).map((row) => asString(row.name));
    if (!columns.includes(column)) {
      this.database.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
    }
  }

  /** 幂等补齐资源偏好与下载技术信息列，用于修复版本号领先于实际表结构的数据库。 */
  private ensureReleaseMetadataColumns(): void {
    this.ensureColumn("my_anime", "preferred_subtitle_languages_json", "preferred_subtitle_languages_json TEXT NOT NULL DEFAULT '[]'");
    this.ensureColumn("my_anime", "preferred_bit_depth", "preferred_bit_depth INTEGER");
    this.ensureColumn("my_anime_rss_subscription", "preferred_subtitle_languages_json", "preferred_subtitle_languages_json TEXT NOT NULL DEFAULT '[]'");
    this.ensureColumn("release", "bit_depth", "bit_depth INTEGER");
    this.ensureColumn("release", "subtitle_languages_json", "subtitle_languages_json TEXT NOT NULL DEFAULT '[]'");
    this.ensureColumn("download_task", "resolution", "resolution TEXT");
    this.ensureColumn("download_task", "declared_video_codec", "declared_video_codec TEXT");
    this.ensureColumn("download_task", "normalized_video_codec", "normalized_video_codec TEXT");
    this.ensureColumn("download_task", "bit_depth", "bit_depth INTEGER");
    this.ensureColumn("download_task", "subtitle_languages_json", "subtitle_languages_json TEXT NOT NULL DEFAULT '[]'");
    this.ensureColumn("download_task", "subtitle", "subtitle TEXT");
  }
}

/** 校验观看进度输入，避免异常请求批量生成大量单集。 */
function normalizeWatchProgress(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 10_000) {
    throw new Error("观看进度必须是 0 到 10000 之间的整数");
  }
  return value;
}

/** 写库前按别名文本去重，并基于最终番剧标识重建唯一别名标识。 */
function normalizeAnimeAliasesForPersistence(anime: Anime): {
  aliases: Anime["aliases"];
  changed: boolean;
  duplicateIds: string[];
} {
  const candidates: Anime["aliases"] = [];
  const aliasIndexByKey = new Map<string, number>();
  const seenIds = new Set<string>();
  const duplicateIds = new Set<string>();

  for (const alias of anime.aliases) {
    const value = alias.alias.trim();
    const key = normalizeAnimeAliasKey(value);
    if (!key) {
      continue;
    }

    if (seenIds.has(alias.id)) {
      duplicateIds.add(alias.id);
    } else {
      seenIds.add(alias.id);
    }

    const existingIndex = aliasIndexByKey.get(key);
    if (existingIndex !== undefined) {
      if (alias.priority > candidates[existingIndex].priority) {
        candidates[existingIndex] = { ...alias, alias: value };
      }
      continue;
    }

    aliasIndexByKey.set(key, candidates.length);
    candidates.push({ ...alias, alias: value });
  }

  const aliases = candidates.map((alias, index) => ({
    ...alias,
    id: `${anime.id}-alias-${index + 1}`,
    animeId: anime.id
  }));
  const changed = aliases.length !== anime.aliases.length || aliases.some((alias, index) => {
    const original = anime.aliases[index];
    return !original ||
      alias.id !== original.id ||
      alias.animeId !== original.animeId ||
      alias.alias !== original.alias;
  });

  return {
    aliases,
    changed,
    duplicateIds: [...duplicateIds]
  };
}

/** 生成用于别名语义去重的稳定键。 */
function normalizeAnimeAliasKey(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase();
}

function mapAnime(row: SqliteRow, aliases: Anime["aliases"]): Anime {
  return compact({
    id: asString(row.id), title: asString(row.title), originalTitle: optionalString(row.original_title), aliases,
    premiereDate: optionalString(row.premiere_date), premiereYear: Number(row.premiere_year),
    premiereMonth: Number(row.premiere_month), season: optionalString(row.season) as Anime["season"],
    summary: optionalString(row.summary), coverUrl: optionalString(row.cover_url),
    rating: mapAnimeRating(row),
    externalIds: fromJson<Record<string, string>>(asString(row.external_ids_json)),
    detail: parseAnimeDetailJson(asString(row.detail_json), asString(row.id))
  });
}

/** 安全解析详情 JSON，损坏记录回退为空并保留可用基础字段。 */
function parseAnimeDetailJson(value: string, animeId: string): Anime["detail"] {
  try {
    return normalizeAnimeDetailMetadata(JSON.parse(value));
  } catch (error) {
    logger.warn("SQLite 番剧详情 JSON 解析失败", {
      animeId,
      error: error instanceof Error ? error.message : String(error)
    });
    return undefined;
  }
}

function mapAnimeRating(row: SqliteRow): Anime["rating"] {
  const score = optionalNumber(row.rating_score);
  const source = optionalString(row.rating_source);
  if (score === undefined || !source) {
    return undefined;
  }

  return compact({
    score,
    count: optionalNumber(row.rating_count),
    source
  });
}

function mapAnimeSourceBinding(row: SqliteRow): AnimeSourceBinding {
  return compact({
    id: asString(row.id),
    animeId: asString(row.anime_id),
    sourceId: asString(row.source_id),
    sourceAnimeId: asString(row.source_anime_id),
    sourceAnimeTitle: optionalString(row.source_anime_title),
    sourceUrl: optionalString(row.source_url),
    matchMethod: asString(row.match_method) as AnimeSourceBinding["matchMethod"],
    confidence: Number(row.confidence),
    confirmed: toBoolean(row.confirmed),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at)
  });
}

function mapAnimeSourceExclusion(row: SqliteRow): AnimeSourceExclusion {
  return compact({
    id: asString(row.id),
    animeId: asString(row.anime_id),
    sourceId: asString(row.source_id),
    scope: asString(row.scope) as AnimeSourceExclusion["scope"],
    sourceAnimeId: optionalString(row.source_anime_id),
    sourceAnimeTitle: optionalString(row.source_anime_title),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at)
  });
}

function mapAnimeAlias(row: SqliteRow): Anime["aliases"][number] {
  return { id: asString(row.id), animeId: asString(row.anime_id), alias: asString(row.alias),
    language: asString(row.language) as Anime["aliases"][number]["language"], priority: Number(row.priority) };
}

function mapMyAnime(row: SqliteRow, anime: Anime, rssSubscriptions: NonNullable<MyAnime["rssSubscriptions"]>): MyAnime {
  return compact({ id: asString(row.id), anime, status: asString(row.status) as MyAnime["status"],
    defaultFansubGroupId: optionalString(row.default_fansub_group_id), autoDownload: toBoolean(row.auto_download),
    downloadDir: optionalString(row.download_dir), preferredResolution: optionalString(row.preferred_resolution) as MyAnime["preferredResolution"],
    preferredCodec: optionalString(row.preferred_codec) as MyAnime["preferredCodec"],
    preferredBitDepth: optionalNumber(row.preferred_bit_depth) as MyAnime["preferredBitDepth"],
    preferredSubtitleLanguages: resolveSubtitleLanguages(
      fromJson(asString(row.preferred_subtitle_languages_json)),
      optionalString(row.preferred_subtitle) as MyAnime["preferredSubtitle"]
    ),
    preferredSubtitle: optionalString(row.preferred_subtitle) as MyAnime["preferredSubtitle"],
    rssSubscriptions,
    addedAt: asString(row.added_at), updatedAt: asString(row.updated_at) });
}

function mapEpisode(row: SqliteRow): Episode {
  return compact({ id: asString(row.id), animeId: asString(row.anime_id), episodeNo: Number(row.episode_no),
    title: optionalString(row.title), airTime: optionalString(row.air_time), status: asString(row.status) as Episode["status"] });
}

function mapEpisodePreference(row: SqliteRow): EpisodePreference {
  return compact({ id: asString(row.id), animeId: asString(row.anime_id), episodeId: asString(row.episode_id),
    fansubGroupId: optionalString(row.fansub_group_id), releaseId: optionalString(row.release_id),
    isManualOverride: toBoolean(row.is_manual_override) });
}

/** 将 SQLite 的 -1 文件索引还原为未指定索引。 */
function mapPlaybackCheckpoint(row: SqliteRow): PlaybackCheckpoint {
  const fileIndex = Number(row.file_index);
  return compact({
    taskId: asString(row.task_id),
    fileIndex: fileIndex >= 0 ? fileIndex : undefined,
    positionSeconds: Number(row.position_seconds),
    durationSeconds: Number(row.duration_seconds),
    completed: toBoolean(row.completed),
    watchedReported: toBoolean(row.watched_reported),
    updatedAt: asString(row.updated_at)
  });
}

/** 用 -1 表示未指定文件索引，确保 SQLite 复合主键可稳定去重。 */
function normalizeCheckpointFileIndex(fileIndex?: number): number {
  return fileIndex ?? -1;
}

function mapFansub(row: SqliteRow): FansubGroup {
  return { id: asString(row.id), name: asString(row.name), aliases: fromJson<string[]>(asString(row.aliases_json)),
    sourceIds: fromJson<string[]>(asString(row.source_ids_json)) };
}

/** 从已归一化资源中汇总可持久化的字幕组。 */
function collectDiscoveredFansubs(releases: Release[]): FansubGroup[] {
  const groups = new Map<string, FansubGroup>();
  for (const release of releases) {
    const id = release.fansubGroupId?.trim();
    const name = release.fansubName?.trim();
    if (!id || !name) {
      continue;
    }

    const current = groups.get(id) ?? { id, name, aliases: [], sourceIds: [] };
    current.aliases = uniqueStrings([
      ...current.aliases,
      ...(current.name !== name ? [name] : [])
    ]);
    current.sourceIds = uniqueStrings([...current.sourceIds, release.sourceId]);
    groups.set(id, current);
  }
  return [...groups.values()];
}

/** 按名称和别名规范键构建应被合并的字幕组集合。 */
function buildFansubMergeClusters(groups: FansubGroup[]): FansubGroup[][] {
  const parents = new Map(groups.map((group) => [group.id, group.id]));
  const keyOwners = new Map<string, string>();

  /** 查找并压缩字幕组并查集根节点。 */
  function find(groupId: string): string {
    const parent = parents.get(groupId) ?? groupId;
    if (parent === groupId) {
      return groupId;
    }
    const root = find(parent);
    parents.set(groupId, root);
    return root;
  }

  /** 合并两个共享规范名称的字幕组节点。 */
  function union(leftId: string, rightId: string): void {
    const leftRoot = find(leftId);
    const rightRoot = find(rightId);
    if (leftRoot !== rightRoot) {
      parents.set(rightRoot, leftRoot);
    }
  }

  for (const group of groups) {
    const keys = new Set([group.name, ...group.aliases].map(normalizeFansubName).filter(Boolean));
    for (const key of keys) {
      const ownerId = keyOwners.get(key);
      if (ownerId) {
        union(group.id, ownerId);
      } else {
        keyOwners.set(key, group.id);
      }
    }
  }

  const clusters = new Map<string, FansubGroup[]>();
  for (const group of groups) {
    const root = find(group.id);
    clusters.set(root, [...(clusters.get(root) ?? []), group]);
  }
  return [...clusters.values()];
}

/** 优先选择人工配置且展示名已采用规范字符的字幕组作为合并目标。 */
function selectCanonicalFansub(groups: FansubGroup[]): FansubGroup {
  return [...groups].sort((left, right) => {
    const manualDifference = Number(left.id.startsWith("fansub-auto-")) - Number(right.id.startsWith("fansub-auto-"));
    if (manualDifference !== 0) {
      return manualDifference;
    }

    const displayDifference = getFansubDisplayPenalty(left.name) - getFansubDisplayPenalty(right.name);
    return displayDifference || left.id.localeCompare(right.id);
  })[0];
}

/** 判断展示名是否仍包含会被规范键折叠的异体字符。 */
function getFansubDisplayPenalty(name: string): number {
  const displayKey = normalizeFansubDisplayName(name);
  return displayKey === normalizeFansubName(name) ? 0 : 1;
}

/** 规范展示文本格式，但保留简繁和日文异体差异。 */
function normalizeFansubDisplayName(name: string): string {
  return name.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

/** 按不区分大小写的文本键去重，同时保留原始展示值。 */
function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = value.trim().toLocaleLowerCase();
    if (!key || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function mapSource(row: SqliteRow): ReleaseSourceConfig {
  return compact({ id: asString(row.id), name: asString(row.name), kind: asString(row.kind) as ReleaseSourceConfig["kind"],
    enabled: toBoolean(row.enabled), useProxy: toBoolean(row.use_proxy),
    requestIntervalMs: normalizeSourceRequestInterval(optionalNumber(row.request_interval_ms)),
    baseUrl: optionalString(row.base_url), apiKey: optionalString(row.api_key),
    rssUrl: optionalString(row.rss_url), tags: fromJson<string[]>(asString(row.tags_json)) });
}

function mapSourceSyncState(row: SqliteRow): ReleaseSourceSyncState {
  return compact({
    sourceId: asString(row.source_id),
    requestHost: optionalString(row.request_host),
    lastRequestAt: optionalString(row.last_request_at),
    requestFailureCount: optionalNumber(row.request_failure_count) ?? 0,
    backoffUntil: optionalString(row.backoff_until),
    lastSyncAttemptAt: optionalString(row.last_sync_attempt_at),
    lastSuccessfulSyncAt: optionalString(row.last_successful_sync_at),
    lastSyncError: optionalString(row.last_sync_error),
    etag: optionalString(row.etag),
    lastModified: optionalString(row.last_modified)
  });
}

/** 将 SQLite 行映射为通用网络熔断状态。 */
function mapRequestCircuitState(row: SqliteRow): RequestCircuitState {
  return compact({
    key: asString(row.circuit_key),
    group: asString(row.circuit_group),
    requestHost: optionalString(row.request_host),
    lastRequestAt: optionalString(row.last_request_at),
    failureCount: optionalNumber(row.failure_count) ?? 0,
    backoffUntil: optionalString(row.backoff_until)
  });
}

function mapRelease(row: SqliteRow): Release {
  const raw = fromJson<Partial<Release>>(asString(row.raw_json));
  return compact({
    ...raw,
    id: asString(row.id),
    title: asString(row.title),
    animeId: optionalString(row.anime_id) ?? raw.animeId,
    episodeNo: optionalNumber(row.episode_no) ?? raw.episodeNo,
    fansubGroupId: optionalString(row.fansub_group_id) ?? raw.fansubGroupId,
    sourceId: asString(row.source_id),
    sourceName: asString(row.source_name),
    magnetUrl: optionalString(row.magnet_url),
    torrentUrl: optionalString(row.torrent_url),
    infoHash: optionalString(row.info_hash),
    size: optionalNumber(row.size),
    resolution: optionalString(row.resolution) as Release["resolution"],
    declaredVideoCodec: optionalString(row.declared_video_codec),
    normalizedVideoCodec: optionalString(row.normalized_video_codec) as Release["normalizedVideoCodec"],
    bitDepth: optionalNumber(row.bit_depth) as Release["bitDepth"],
    subtitle: optionalString(row.subtitle) as Release["subtitle"],
    subtitleLanguages: normalizeSubtitleLanguages(fromJson(asString(row.subtitle_languages_json))),
    publishedAt: asString(row.published_at),
    seeders: optionalNumber(row.seeders)
  });
}

function mapDownload(row: SqliteRow, files: TorrentFile[]): DownloadTask {
  return compact({ id: asString(row.id), releaseId: optionalString(row.release_id), animeId: optionalString(row.anime_id),
    episodeId: optionalString(row.episode_id), animeTitle: optionalString(row.anime_title), episodeNo: optionalNumber(row.episode_no),
    fansubGroupId: optionalString(row.fansub_group_id), fansubName: optionalString(row.fansub_name),
    resolution: optionalString(row.resolution) as DownloadTask["resolution"],
    declaredVideoCodec: optionalString(row.declared_video_codec),
    normalizedVideoCodec: optionalString(row.normalized_video_codec) as DownloadTask["normalizedVideoCodec"],
    bitDepth: optionalNumber(row.bit_depth) as DownloadTask["bitDepth"],
    subtitleLanguages: normalizeSubtitleLanguages(fromJson(asString(row.subtitle_languages_json))),
    subtitle: optionalString(row.subtitle) as DownloadTask["subtitle"],
    correlationTag: optionalString(row.correlation_tag), engine: asString(row.engine) as DownloadTask["engine"],
    torrentHash: optionalString(row.torrent_hash), name: asString(row.name), status: asString(row.status) as DownloadStatus,
    progress: Number(row.progress), downloadSpeed: Number(row.download_speed), uploadSpeed: Number(row.upload_speed),
    etaSeconds: optionalNumber(row.eta_seconds), savePath: asString(row.save_path), files,
    createdAt: asString(row.created_at), completedAt: optionalString(row.completed_at) });
}

function mapTorrentFile(row: SqliteRow): { downloadTaskId: string; file: TorrentFile } {
  return { downloadTaskId: asString(row.download_task_id), file: { id: asString(row.id), index: Number(row.file_index),
    name: asString(row.name), episodeId: optionalString(row.episode_id), episodeNo: optionalNumber(row.episode_no),
    size: Number(row.size), progress: Number(row.progress), priority: Number(row.priority), selected: toBoolean(row.selected) } };
}

/** 将来源采集间隔限制在 250 毫秒到 60 秒之间。 */
function normalizeSourceRequestInterval(value?: number): number {
  if (!Number.isFinite(value)) {
    return 1_500;
  }
  return Math.max(250, Math.min(60_000, Math.round(value!)));
}

/** 为下载任务自动补建的单集生成稳定 ID。 */
function createDownloadEpisodeId(animeId: string, episodeNo: number): string {
  return `episode-${animeId}-${String(episodeNo).replace(".", "-")}`;
}

/** 在下载引擎刷新文件进度时保留已建立的文件级单集关联。 */
function mergeTorrentFileEpisodeLinks(engineFiles: TorrentFile[], existingFiles: TorrentFile[]): TorrentFile[] {
  const existingByIdentity = new Map(
    existingFiles.map((file) => [`${file.index}:${file.name}`, file])
  );
  return engineFiles.map((file) => {
    const existing = existingByIdentity.get(`${file.index}:${file.name}`);
    return existing
      ? { ...file, episodeId: existing.episodeId, episodeNo: existing.episodeNo }
      : file;
  });
}

/** 生成下载任务关联快照，用于避免无变化时重复写库和打印日志。 */
function downloadAssociationSignature(task: Pick<DownloadTask, "episodeId" | "episodeNo" | "files">): string {
  return JSON.stringify({
    episodeId: task.episodeId,
    episodeNo: task.episodeNo,
    files: task.files.map((file) => [file.index, file.name, file.episodeId, file.episodeNo])
  });
}

/** 仅允许连续的正整数集数自动补建，避免特殊文件中的数字污染单集。 */
function isContiguousEpisodeSequence(values: number[]): boolean {
  const unique = [...new Set(values)].sort((left, right) => left - right);
  return unique.length > 1 && unique.every((value, index) =>
    Number.isSafeInteger(value) && value > 0 && (index === 0 || value === unique[index - 1] + 1)
  );
}

/** 根据当前下载状态和进度设置新建单集的初始状态。 */
function resolveEpisodeStatusFromDownload(task: Pick<DownloadTask, "status" | "progress">): Episode["status"] {
  return isCompletedDownloadTask(task) ? "downloaded" : "downloading";
}

function mapMediaFile(row: SqliteRow): MediaFile {
  return compact({ id: asString(row.id), animeId: asString(row.anime_id), episodeId: optionalString(row.episode_id),
    downloadTaskId: optionalString(row.download_task_id), filePath: asString(row.file_path), fileName: asString(row.file_name),
    size: Number(row.size), container: optionalString(row.container) as MediaFile["container"],
    declaredVideoCodec: optionalString(row.declared_video_codec), detectedVideoCodec: optionalString(row.detected_video_codec),
    normalizedVideoCodec: asString(row.normalized_video_codec) as MediaFile["normalizedVideoCodec"],
    resolution: optionalString(row.resolution), bitDepth: optionalNumber(row.bit_depth),
    audioCodecs: fromJson<string[]>(asString(row.audio_codecs_json)), subtitleTracks: fromJson<string[]>(asString(row.subtitle_tracks_json)),
    durationSeconds: optionalNumber(row.duration_seconds), downloadedAt: optionalString(row.downloaded_at), probedAt: optionalString(row.probed_at) });
}

function mapNotification(row: SqliteRow): NotificationRecord {
  return compact({ id: asString(row.id), kind: asString(row.kind) as NotificationRecord["kind"], title: asString(row.title),
    body: asString(row.body), severity: asString(row.severity) as NotificationRecord["severity"],
    animeId: optionalString(row.anime_id), episodeId: optionalString(row.episode_id),
    downloadTaskId: optionalString(row.download_task_id), createdAt: asString(row.created_at), readAt: optionalString(row.read_at) });
}

function stripDerivedDashboard(dashboard: DashboardData): DashboardData {
  return { ...dashboard, dailyReminder: { ...dashboard.dailyReminder, items: [] }, todayEpisodes: [], activeDownloads: [], recentCompleted: [] };
}

function getSnapshotCounts(data: AppDataFile) {
  return {
    animeCatalog: data.animeCatalog.length,
    aliases: data.animeCatalog.reduce((sum, anime) => sum + anime.aliases.length, 0),
    myAnime: data.myAnime.length,
    episodes: data.episodes.length,
    episodePreferences: data.episodePreferences.length,
    fansubGroups: data.fansubGroups.length,
    sources: data.sources.length,
    downloads: data.downloads.length,
    torrentFiles: data.downloads.reduce((sum, task) => sum + task.files.length, 0),
    mediaFiles: data.mediaFiles.length,
    notifications: data.notifications.length
  };
}

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

function nowIso(): string { return new Date().toISOString(); }
function toInteger(value: boolean): number { return value ? 1 : 0; }
function toBoolean(value: SqliteValue): boolean { return Number(value) !== 0; }
function asString(value: SqliteValue): string { return String(value ?? ""); }
function optionalString(value: SqliteValue): string | undefined { return value === null ? undefined : String(value); }
function optionalNumber(value: SqliteValue): number | undefined { return value === null ? undefined : Number(value); }
function toJson(value: unknown): string { return JSON.stringify(value); }
function fromJson<T>(value: string): T { return JSON.parse(value) as T; }
