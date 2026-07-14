import type Database from "better-sqlite3";
import * as BetterSqlite3Module from "better-sqlite3";
import type {
  Anime,
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
  ReleaseSourceConfig,
  TorrentFile
} from "@shared/domain";
import type { AppDataFile } from "@shared/persistence/app-data";
import { APP_DATA_VERSION } from "@shared/persistence/app-data";
import { logger } from "../logger";
import { mergeAnimeMetadataBatches } from "../metadata/metadata-provider";
import { sourceConfigs } from "../mock-data";
import { createDefaultSettingsProvider, type DefaultSettingsProvider } from "../platform/default-settings-provider";
import { createSeedData } from "../storage/seed-data";
import { SQLITE_SCHEMA, SQLITE_SCHEMA_VERSION } from "../storage/sqlite-schema";
import type { AppRepository } from "./app-repository";
import {
  buildDailyReminderSummary,
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
      activeDownloads: data.downloads,
      recentCompleted: sortMediaFiles(data.mediaFiles).slice(0, 10),
      sourceHealth: data.dashboard.sourceHealth.map((source) => ({
        ...source,
        status: data.sources.find((item) => item.id === source.sourceId)?.enabled === false ? "warning" : source.status
      }))
    };
  }

  async listMyAnime(): Promise<MyAnime[]> {
    const animeById = new Map((await this.listAnimeCatalog()).map((anime) => [anime.id, anime]));
    return sortMyAnime(
      this.all("SELECT * FROM my_anime").flatMap((row) => {
        const anime = animeById.get(asString(row.anime_id));
        return anime ? [mapMyAnime(row, anime)] : [];
      })
    );
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
    const catalog = await this.listAnimeCatalog();
    let addedCount = 0;
    let existingCount = 0;
    for (const item of items) {
      const index = catalog.findIndex((anime) => isSameAnime(anime, item));
      if (index >= 0) {
        catalog[index] = {
          ...catalog[index],
          ...item,
          id: catalog[index].id,
          aliases: mergeAliases(catalog[index].aliases, item.aliases).map((alias) => ({
            ...alias,
            animeId: catalog[index].id
          })),
          externalIds: { ...catalog[index].externalIds, ...item.externalIds }
        };
        existingCount += 1;
      } else {
        catalog.push(item);
        addedCount += 1;
      }
    }
    const deduped = mergeAnimeMetadataBatches([{ source: "catalog", items: catalog }]);
    this.transaction(() => {
      for (const anime of deduped) this.upsertAnime(anime);
      const keepIds = new Set(deduped.map((anime) => anime.id));
      for (const row of this.all("SELECT id FROM anime_catalog")) {
        const id = asString(row.id);
        if (!keepIds.has(id)) this.run("DELETE FROM anime_catalog WHERE id = @id", { id });
      }
    });
    return { items: sortAnimeCatalog(deduped), addedCount, existingCount };
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
    this.transaction(() => this.upsertDownload(task));
    return this.listDownloads();
  }

  async mergeDownloadTasksFromEngine(tasks: DownloadTask[]): Promise<DownloadTask[]> {
    const current = await this.listDownloads();
    const merged = tasks.map((task) => {
      const existing = findExistingDownloadTask(current, task);
      return existing
        ? {
            ...task,
            releaseId: existing.releaseId,
            animeId: existing.animeId,
            episodeId: existing.episodeId,
            animeTitle: existing.animeTitle,
            episodeNo: existing.episodeNo,
            fansubGroupId: existing.fansubGroupId,
            fansubName: existing.fansubName,
            correlationTag: existing.correlationTag ?? task.correlationTag,
            createdAt: existing.createdAt,
            completedAt: task.completedAt ?? existing.completedAt
          }
        : task;
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

  async listFansubs(): Promise<FansubGroup[]> {
    return this.all("SELECT * FROM fansub_group ORDER BY name").map(mapFansub);
  }

  async listSources(): Promise<ReleaseSourceConfig[]> {
    const current = this.all("SELECT * FROM release_source ORDER BY name").map(mapSource);
    const missing = sourceConfigs.filter((source) => !current.some((item) => item.id === source.id));
    if (missing.length) {
      this.transaction(() => missing.forEach((source) => this.upsertSourceRow(source)));
      logger.info("Default release sources added to SQLite", { sourceIds: missing.map((source) => source.id) });
      return this.all("SELECT * FROM release_source ORDER BY name").map(mapSource);
    }
    return current;
  }

  async getSettings(): Promise<AppSettings> {
    const value = this.getState<AppSettings>("settings");
    return value ?? this.settingsProvider.getSettings();
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

  async upsertMyAnime(item: MyAnime): Promise<MyAnime[]> {
    const saved: MyAnime = { ...item, addedAt: item.addedAt || nowIso(), updatedAt: nowIso() };
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
    this.setMeta("schema_version", String(SQLITE_SCHEMA_VERSION));
    logger.info("SQLite repository initialized", { path: this.databasePath, schemaVersion: SQLITE_SCHEMA_VERSION });
  }

  /** 将首次启动快照写入各业务表。 */
  private writeSnapshot(data: AppDataFile): void {
    data.animeCatalog.forEach((anime) => this.upsertAnime(anime));
    data.fansubGroups.forEach((fansub) => this.upsertFansub(fansub));
    data.sources.forEach((source) => this.upsertSourceRow(source));
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
    return sortMyAnime(
      this.all("SELECT * FROM my_anime").flatMap((row) => {
        const anime = animeById.get(asString(row.anime_id));
        return anime ? [mapMyAnime(row, anime)] : [];
      })
    );
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
      "notification", "media_file", "torrent_file", "download_task", "episode_preference", "episode",
      "my_anime", "anime_alias", "release", "anime_catalog", "fansub_group", "release_source", "app_settings", "app_state", "app_meta"
    ]) {
      this.database.exec(`DELETE FROM ${table}`);
    }
    this.setMeta("schema_version", String(SQLITE_SCHEMA_VERSION));
  }

  private upsertAnime(anime: Anime): void {
    const timestamp = nowIso();
    this.run(
      `INSERT INTO anime_catalog (
        id, title, original_title, premiere_date, premiere_year, premiere_month, season, summary,
        cover_url, external_ids_json, created_at, updated_at
      ) VALUES (
        @id, @title, @originalTitle, @premiereDate, @premiereYear, @premiereMonth, @season, @summary,
        @coverUrl, @externalIdsJson, @createdAt, @updatedAt
      ) ON CONFLICT(id) DO UPDATE SET
        title = excluded.title, original_title = excluded.original_title, premiere_date = excluded.premiere_date,
        premiere_year = excluded.premiere_year, premiere_month = excluded.premiere_month, season = excluded.season,
        summary = excluded.summary, cover_url = excluded.cover_url, external_ids_json = excluded.external_ids_json,
        updated_at = excluded.updated_at`,
      {
        id: anime.id, title: anime.title, originalTitle: anime.originalTitle ?? null,
        premiereDate: anime.premiereDate ?? null, premiereYear: anime.premiereYear,
        premiereMonth: anime.premiereMonth, season: anime.season ?? null, summary: anime.summary ?? null,
        coverUrl: anime.coverUrl ?? null, externalIdsJson: toJson(anime.externalIds),
        createdAt: timestamp, updatedAt: timestamp
      }
    );
    this.run("DELETE FROM anime_alias WHERE anime_id = @animeId", { animeId: anime.id });
    for (const alias of anime.aliases) {
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

  private upsertMyAnimeRow(item: MyAnime): void {
    this.run(
      `INSERT INTO my_anime (
        id, anime_id, status, default_fansub_group_id, auto_download, download_dir,
        preferred_resolution, preferred_codec, preferred_subtitle, added_at, updated_at
      ) VALUES (
        @id, @animeId, @status, @defaultFansubGroupId, @autoDownload, @downloadDir,
        @preferredResolution, @preferredCodec, @preferredSubtitle, @addedAt, @updatedAt
      ) ON CONFLICT(id) DO UPDATE SET
        anime_id = excluded.anime_id, status = excluded.status,
        default_fansub_group_id = excluded.default_fansub_group_id, auto_download = excluded.auto_download,
        download_dir = excluded.download_dir, preferred_resolution = excluded.preferred_resolution,
        preferred_codec = excluded.preferred_codec, preferred_subtitle = excluded.preferred_subtitle,
        updated_at = excluded.updated_at`,
      {
        id: item.id, animeId: item.anime.id, status: item.status,
        defaultFansubGroupId: item.defaultFansubGroupId ?? null, autoDownload: toInteger(item.autoDownload),
        downloadDir: item.downloadDir ?? null, preferredResolution: item.preferredResolution ?? null,
        preferredCodec: item.preferredCodec ?? null, preferredSubtitle: item.preferredSubtitle ?? null,
        addedAt: item.addedAt, updatedAt: item.updatedAt
      }
    );
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
  }

  private upsertSourceRow(source: ReleaseSourceConfig): void {
    const timestamp = nowIso();
    this.run(
      `INSERT INTO release_source (id, name, kind, enabled, base_url, api_key, rss_url, tags_json, created_at, updated_at)
       VALUES (@id, @name, @kind, @enabled, @baseUrl, @apiKey, @rssUrl, @tagsJson, @createdAt, @updatedAt)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, kind = excluded.kind, enabled = excluded.enabled,
       base_url = excluded.base_url, api_key = excluded.api_key, rss_url = excluded.rss_url,
       tags_json = excluded.tags_json, updated_at = excluded.updated_at`,
      { id: source.id, name: source.name, kind: source.kind, enabled: toInteger(source.enabled),
        baseUrl: source.baseUrl ?? null, apiKey: source.apiKey ?? null, rssUrl: source.rssUrl ?? null,
        tagsJson: toJson(source.tags ?? []), createdAt: timestamp, updatedAt: timestamp }
    );
  }

  private upsertDownload(task: DownloadTask): void {
    this.run(
      `INSERT INTO download_task (
        id, release_id, anime_id, episode_id, anime_title, episode_no, fansub_group_id, fansub_name,
        correlation_tag, engine, torrent_hash, name, status, progress, download_speed, upload_speed,
        eta_seconds, save_path, created_at, completed_at, updated_at
      ) VALUES (
        @id, @releaseId, @animeId, @episodeId, @animeTitle, @episodeNo, @fansubGroupId, @fansubName,
        @correlationTag, @engine, @torrentHash, @name, @status, @progress, @downloadSpeed, @uploadSpeed,
        @etaSeconds, @savePath, @createdAt, @completedAt, @updatedAt
      ) ON CONFLICT(id) DO UPDATE SET
        release_id = excluded.release_id, anime_id = excluded.anime_id, episode_id = excluded.episode_id,
        anime_title = excluded.anime_title, episode_no = excluded.episode_no,
        fansub_group_id = excluded.fansub_group_id, fansub_name = excluded.fansub_name,
        correlation_tag = excluded.correlation_tag, engine = excluded.engine, torrent_hash = excluded.torrent_hash,
        name = excluded.name, status = excluded.status, progress = excluded.progress,
        download_speed = excluded.download_speed, upload_speed = excluded.upload_speed,
        eta_seconds = excluded.eta_seconds, save_path = excluded.save_path,
        completed_at = excluded.completed_at, updated_at = excluded.updated_at`,
      {
        id: task.id, releaseId: task.releaseId ?? null, animeId: task.animeId ?? null,
        episodeId: task.episodeId ?? null, animeTitle: task.animeTitle ?? null, episodeNo: task.episodeNo ?? null,
        fansubGroupId: task.fansubGroupId ?? null, fansubName: task.fansubName ?? null,
        correlationTag: task.correlationTag ?? null, engine: task.engine, torrentHash: task.torrentHash ?? null,
        name: task.name, status: task.status, progress: task.progress, downloadSpeed: task.downloadSpeed,
        uploadSpeed: task.uploadSpeed, etaSeconds: task.etaSeconds ?? null, savePath: task.savePath,
        createdAt: task.createdAt, completedAt: task.completedAt ?? null, updatedAt: nowIso()
      }
    );
    this.run("DELETE FROM torrent_file WHERE download_task_id = @taskId", { taskId: task.id });
    for (const file of task.files) {
      this.run(
        `INSERT INTO torrent_file (id, download_task_id, file_index, name, size, progress, priority, selected)
         VALUES (@id, @taskId, @fileIndex, @name, @size, @progress, @priority, @selected)`,
        { id: file.id, taskId: task.id, fileIndex: file.index, name: file.name, size: file.size,
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
      downloads.forEach((task) => this.upsertDownload(task));
      const keepIds = new Set(downloads.map((task) => task.id));
      for (const row of this.all("SELECT id FROM download_task")) {
        const id = asString(row.id);
        if (!keepIds.has(id)) {
          this.run("DELETE FROM download_task WHERE id = @id", { id });
        }
      }
    });
    await this.syncEpisodesFromCurrentDownloads();
  }

  private async syncEpisodesFromCurrentDownloads(): Promise<void> {
    const snapshot = this.readSnapshot();
    syncEpisodeStatusesFromDownloads(snapshot);
    this.transaction(() => snapshot.episodes.forEach((episode) => this.upsertEpisodeRow(episode)));
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
}

function mapAnime(row: SqliteRow, aliases: Anime["aliases"]): Anime {
  return compact({
    id: asString(row.id), title: asString(row.title), originalTitle: optionalString(row.original_title), aliases,
    premiereDate: optionalString(row.premiere_date), premiereYear: Number(row.premiere_year),
    premiereMonth: Number(row.premiere_month), season: optionalString(row.season) as Anime["season"],
    summary: optionalString(row.summary), coverUrl: optionalString(row.cover_url),
    externalIds: fromJson<Record<string, string>>(asString(row.external_ids_json))
  });
}

function mapAnimeAlias(row: SqliteRow): Anime["aliases"][number] {
  return { id: asString(row.id), animeId: asString(row.anime_id), alias: asString(row.alias),
    language: asString(row.language) as Anime["aliases"][number]["language"], priority: Number(row.priority) };
}

function mapMyAnime(row: SqliteRow, anime: Anime): MyAnime {
  return compact({ id: asString(row.id), anime, status: asString(row.status) as MyAnime["status"],
    defaultFansubGroupId: optionalString(row.default_fansub_group_id), autoDownload: toBoolean(row.auto_download),
    downloadDir: optionalString(row.download_dir), preferredResolution: optionalString(row.preferred_resolution) as MyAnime["preferredResolution"],
    preferredCodec: optionalString(row.preferred_codec) as MyAnime["preferredCodec"],
    preferredSubtitle: optionalString(row.preferred_subtitle) as MyAnime["preferredSubtitle"],
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

function mapFansub(row: SqliteRow): FansubGroup {
  return { id: asString(row.id), name: asString(row.name), aliases: fromJson<string[]>(asString(row.aliases_json)),
    sourceIds: fromJson<string[]>(asString(row.source_ids_json)) };
}

function mapSource(row: SqliteRow): ReleaseSourceConfig {
  return compact({ id: asString(row.id), name: asString(row.name), kind: asString(row.kind) as ReleaseSourceConfig["kind"],
    enabled: toBoolean(row.enabled), baseUrl: optionalString(row.base_url), apiKey: optionalString(row.api_key),
    rssUrl: optionalString(row.rss_url), tags: fromJson<string[]>(asString(row.tags_json)) });
}

function mapDownload(row: SqliteRow, files: TorrentFile[]): DownloadTask {
  return compact({ id: asString(row.id), releaseId: optionalString(row.release_id), animeId: optionalString(row.anime_id),
    episodeId: optionalString(row.episode_id), animeTitle: optionalString(row.anime_title), episodeNo: optionalNumber(row.episode_no),
    fansubGroupId: optionalString(row.fansub_group_id), fansubName: optionalString(row.fansub_name),
    correlationTag: optionalString(row.correlation_tag), engine: asString(row.engine) as DownloadTask["engine"],
    torrentHash: optionalString(row.torrent_hash), name: asString(row.name), status: asString(row.status) as DownloadStatus,
    progress: Number(row.progress), downloadSpeed: Number(row.download_speed), uploadSpeed: Number(row.upload_speed),
    etaSeconds: optionalNumber(row.eta_seconds), savePath: asString(row.save_path), files,
    createdAt: asString(row.created_at), completedAt: optionalString(row.completed_at) });
}

function mapTorrentFile(row: SqliteRow): { downloadTaskId: string; file: TorrentFile } {
  return { downloadTaskId: asString(row.download_task_id), file: { id: asString(row.id), index: Number(row.file_index),
    name: asString(row.name), size: Number(row.size), progress: Number(row.progress), priority: Number(row.priority),
    selected: toBoolean(row.selected) } };
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
