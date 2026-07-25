use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use ani_domain::{
    AnimeSourceBinding, AnimeSourceBindingMatchMethod, AnimeSourceExclusion,
    AnimeSourceExclusionScope, AnimeStatus, DownloadStatus, DownloadTask, Episode,
    EpisodePreference, EpisodeStatus, MediaFile, MyAnime, NotificationKind, NotificationRecord,
    NotificationSeverity, PlaybackCheckpoint, ReleaseSearchResult, ReleaseSourceConfig,
    ReleaseSourceSyncState, ReportPlaybackProgressInput, RequestCircuitState,
    SavePlaybackCheckpointInput, SetAnimeWatchProgressInput, TorrentEngineKind, TorrentFile,
};
use ani_repository::{
    AnimeCatalogRepository, AnimeSourceBindingRepository, CachedReleaseQuery, DownloadRepository,
    MediaRepository, NotificationRepository, ReleaseCacheRepository, ReleaseSearchCacheEntry,
    ReleaseSourceRepository, RepositoryError, UnitOfWork, UnitOfWorkFactory,
};
use rusqlite::{params, Connection, OpenFlags};
use serde::Deserialize;
use serde_json::json;

use crate::{
    ReleaseSourceSeed, Storage, StorageError, StorageOptions, StorageSeed, APP_DATA_VERSION,
    SQLITE_SCHEMA_VERSION,
};

static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ContractFixture<T> {
    schema_version: u32,
    kind: String,
    payload: T,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct P3FollowingWriteModelFixture {
    my_anime: MyAnime,
    episode: Episode,
    preference: EpisodePreference,
    watch_progress_input: SetAnimeWatchProgressInput,
    report_playback_progress_input: ReportPlaybackProgressInput,
    save_playback_checkpoint_input: SavePlaybackCheckpointInput,
    checkpoint: PlaybackCheckpoint,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct P3SourceNetworkModelFixture {
    source: ReleaseSourceConfig,
    sync_state: ReleaseSourceSyncState,
    circuit_state: RequestCircuitState,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct P3SourceBindingModelFixture {
    binding: AnimeSourceBinding,
    exclusion: AnimeSourceExclusion,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct P3ReleaseSearchModelFixture {
    search_result: ReleaseSearchResult,
}

/// 验证新库在单次启动中完成建表、seed 和版本写入。
#[test]
fn initializes_new_database_with_seed() {
    let directory = TestDirectory::new("new");
    let options = test_options(&directory, "active.sqlite");
    let storage = Storage::open(options).expect("new database must initialize");

    assert!(storage.report().created);
    assert_eq!(storage.report().schema_version, SQLITE_SCHEMA_VERSION);
    assert_eq!(storage.report().app_data_version, APP_DATA_VERSION);
    assert_eq!(read_meta(&storage.connection, "schema_version"), "18");
    assert_eq!(read_meta(&storage.connection, "app_data_version"), "22");
    assert_eq!(
        storage
            .connection
            .query_row(
                "SELECT value_json FROM app_settings WHERE key = 'settings'",
                [],
                |row| row.get::<_, String>(0)
            )
            .expect("seeded settings"),
        r#"{"appearance":{"mode":"system"}}"#
    );
    assert_eq!(
        storage
            .connection
            .query_row("SELECT COUNT(*) FROM release_source", [], |row| row
                .get::<_, i64>(0))
            .expect("source count"),
        1
    );
    storage.verify().expect("new database integrity");
}

/// 验证设置补丁可持久化，同时不能覆盖宿主拥有的存储路径。
#[test]
fn updates_and_resets_settings_through_repository() {
    let directory = TestDirectory::new("settings-write");
    let storage = Storage::open(test_options(&directory, "active.sqlite"))
        .expect("open settings write database");
    let defaults = json!({
        "appearance": { "mode": "system" },
        "network": { "metadataProxy": { "mode": "system", "timeoutMs": 15000 } },
        "storage": { "databasePath": "host-owned.sqlite" }
    });
    let updated = storage
        .repository()
        .update_settings(
            &json!({
                "network": { "metadataProxy": { "mode": "manual", "url": "http://127.0.0.1:7890" } },
                "storage": { "databasePath": "untrusted.sqlite" }
            }),
            &defaults,
        )
        .expect("update settings");

    assert_eq!(updated["network"]["metadataProxy"]["mode"], "manual");
    assert_eq!(updated["storage"]["databasePath"], "host-owned.sqlite");
    let reset = storage
        .repository()
        .reset_settings(&defaults)
        .expect("reset settings");
    assert_eq!(reset, defaults);
}

/// 验证旧库升级前保留一致性备份，并执行结构与应用数据迁移。
#[test]
fn backs_up_and_migrates_legacy_versions() {
    let directory = TestDirectory::new("migration");
    let options = test_options(&directory, "active.sqlite");
    let database_path = options.database_path.clone();
    drop(Storage::open(options.clone()).expect("create current database"));

    let legacy = Connection::open(&database_path).expect("open legacy database");
    legacy
        .execute_batch(
            "ALTER TABLE anime_catalog DROP COLUMN detail_json;
             UPDATE app_meta SET value = '12' WHERE key = 'schema_version';
             UPDATE app_meta SET value = '21' WHERE key = 'app_data_version';",
        )
        .expect("downgrade schema fixture");
    insert_source(&legacy, "prowlarr", true);
    insert_source(&legacy, "anibt", true);
    drop(legacy);

    let storage = Storage::open(options).expect("legacy database must migrate");
    let backup_path = storage
        .report()
        .backup_path
        .clone()
        .expect("migration backup path");
    assert!(backup_path.is_file());
    assert!(column_exists(
        &storage.connection,
        "anime_catalog",
        "detail_json"
    ));
    assert_eq!(read_meta(&storage.connection, "schema_version"), "18");
    assert_eq!(read_meta(&storage.connection, "app_data_version"), "22");
    assert_eq!(source_count(&storage.connection, "prowlarr"), 0);
    assert_eq!(source_proxy(&storage.connection, "anibt"), 0);
    storage.verify().expect("migrated database integrity");

    let backup = open_read_only(&backup_path);
    assert_eq!(read_meta(&backup, "schema_version"), "12");
    assert_eq!(read_meta(&backup, "app_data_version"), "21");
    assert!(!column_exists(&backup, "anime_catalog", "detail_json"));
    assert_eq!(source_count(&backup, "prowlarr"), 1);
}

/// 验证 Tauri 首启只复制 Electron 数据库，不修改或删除源文件。
#[test]
fn copies_legacy_database_without_modifying_source() {
    let directory = TestDirectory::new("copy");
    let source_options = test_options(&directory, "electron.sqlite");
    let source_path = source_options.database_path.clone();
    drop(Storage::open(source_options).expect("create electron database"));

    let target_path = directory.path().join("tauri").join("ani-tracker.sqlite");
    let options = StorageOptions {
        database_path: target_path.clone(),
        backup_directory: directory.path().join("backups"),
        legacy_database_paths: vec![source_path.clone()],
        seed: StorageSeed::default(),
    };
    let storage = Storage::open(options).expect("copy legacy database");

    assert_eq!(
        storage.report().copied_from.as_deref(),
        Some(source_path.as_path())
    );
    assert!(storage
        .report()
        .backup_path
        .as_ref()
        .is_some_and(|path| path.is_file()));
    assert!(source_path.is_file());
    assert!(target_path.is_file());
    assert_eq!(
        storage
            .connection
            .query_row(
                "SELECT value_json FROM app_settings WHERE key = 'settings'",
                [],
                |row| row.get::<_, String>(0)
            )
            .expect("copied settings"),
        r#"{"appearance":{"mode":"system"}}"#
    );
    open_read_only(&source_path)
        .query_row("PRAGMA integrity_check", [], |row| row.get::<_, String>(0))
        .map(|result| assert_eq!(result, "ok"))
        .expect("source database remains valid");
}

/// 验证迁移事务失败后恢复原始版本和表结构。
#[test]
fn restores_backup_when_migration_fails() {
    let directory = TestDirectory::new("rollback");
    let options = test_options(&directory, "active.sqlite");
    let database_path = options.database_path.clone();
    drop(Storage::open(options.clone()).expect("create current database"));

    let legacy = Connection::open(&database_path).expect("open migration failure fixture");
    legacy
        .execute_batch(
            "ALTER TABLE torrent_file DROP COLUMN episode_no;
             UPDATE app_meta SET value = '17' WHERE key = 'schema_version';
             CREATE TRIGGER reject_schema_version_update
             BEFORE UPDATE OF value ON app_meta
             WHEN OLD.key = 'schema_version'
             BEGIN SELECT RAISE(ABORT, 'forced migration failure'); END;",
        )
        .expect("prepare migration failure fixture");
    drop(legacy);

    let error = Storage::open(options)
        .err()
        .expect("migration must fail and return an error");
    assert!(matches!(error, StorageError::MigrationRolledBack { .. }));

    let restored = open_read_only(&database_path);
    assert_eq!(read_meta(&restored, "schema_version"), "17");
    assert!(!column_exists(&restored, "torrent_file", "episode_no"));
    assert_eq!(
        restored
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger' AND name = 'reject_schema_version_update'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .expect("restored trigger"),
        1
    );
}

/// 验证损坏库阻止启动，且不会被 seed 覆盖。
#[test]
fn rejects_corrupt_database_without_overwrite() {
    let directory = TestDirectory::new("corrupt");
    let options = test_options(&directory, "active.sqlite");
    let corrupt_bytes = b"not a sqlite database";
    fs::write(&options.database_path, corrupt_bytes).expect("write corrupt fixture");

    let error = Storage::open(options.clone())
        .err()
        .expect("corrupt database must fail");
    assert!(matches!(error, StorageError::CorruptDatabase { .. }));
    assert_eq!(
        fs::read(&options.database_path).expect("read untouched corrupt fixture"),
        corrupt_bytes
    );
    assert_eq!(
        fs::read_dir(&options.backup_directory)
            .expect("read backup directory")
            .count(),
        0
    );
}

/// 验证 P2 首批设置、通知、追番和首页查询使用同一 SQLite 数据源。
#[test]
fn reads_p2_business_views_from_sqlite() {
    let directory = TestDirectory::new("p2-views");
    let options = test_options(&directory, "active.sqlite");
    let storage = Storage::open(options).expect("create p2 view database");
    insert_p2_read_model_fixture(&storage.connection);
    let repository = storage.repository();

    let settings = repository
        .get_settings(&json!({
            "appearance": { "mode": "system", "themePackId": "default" },
            "network": { "metadataProxy": { "mode": "off", "timeoutMs": 15000 } },
            "storage": { "databasePath": "C:/tauri/ani-tracker.sqlite", "cacheDir": "C:/tauri/cache" },
            "players": [
                { "id": "built-in", "name": "内置播放器", "executablePath": "", "argumentTemplate": "{file}" },
                { "id": "system", "name": "系统播放器", "executablePath": "", "argumentTemplate": "{file}" }
            ]
        }))
        .expect("read merged settings");
    assert_eq!(settings["appearance"]["mode"], "dark");
    assert_eq!(settings["appearance"]["themePackId"], "default");
    assert_eq!(settings["network"]["metadataProxy"]["timeoutMs"], 15_000);
    assert_eq!(
        settings["storage"]["databasePath"],
        "C:/tauri/ani-tracker.sqlite"
    );
    assert_eq!(settings["storage"]["cacheDir"], "C:/tauri/cache");
    assert_eq!(settings["players"][0]["executablePath"], "C:/VLC/vlc.exe");
    assert_eq!(settings["players"][0]["argumentTemplate"], "{file}");
    assert_eq!(settings["players"][1]["id"], "system");

    let notifications = repository.list_notifications().expect("list notifications");
    assert_eq!(notifications.len(), 2);
    assert_eq!(notifications[0].id, "notification-new");
    assert_eq!(
        repository
            .get_unread_notification_count()
            .expect("unread count"),
        1
    );

    let followed = repository.list_my_anime().expect("list my anime");
    assert_eq!(followed.len(), 1);
    assert_eq!(followed[0].anime.title, "测试番剧");
    assert_eq!(followed[0].anime.aliases[0].alias, "测试别名");
    assert_eq!(followed[0].preferred_subtitle_languages, ["chs", "cht"]);
    assert_eq!(followed[0].rss_subscriptions.len(), 1);
    assert_eq!(
        followed[0].rss_subscriptions[0].preferred_subtitle_languages,
        ["cht"]
    );

    let dashboard = repository.get_dashboard().expect("read dashboard");
    assert_eq!(dashboard.daily_reminder.total, 3);
    assert_eq!(dashboard.daily_reminder.aired, 1);
    assert_eq!(dashboard.daily_reminder.downloading, 1);
    assert_eq!(dashboard.daily_reminder.downloaded, 1);
    assert_eq!(dashboard.today_episodes.len(), 3);
    assert_eq!(dashboard.pending_actions.len(), 1);
    assert_eq!(dashboard.pending_actions[0].episode_no, Some(1.0));
    assert_eq!(dashboard.active_downloads.len(), 1);
    assert_eq!(dashboard.active_downloads[0].id, "download-active");
    assert_eq!(dashboard.recent_completed.len(), 1);
    assert_eq!(dashboard.weekly_schedule[0].day, "周一");
    assert_eq!(dashboard.source_health[0].status, "warning");
}

/// 验证 P3 追番、单集、偏好、观看进度和续播写入形成完整事务闭环。
#[test]
fn writes_p3_following_business_transactionally() {
    let directory = TestDirectory::new("p3-following");
    let storage = Storage::open(test_options(&directory, "active.sqlite"))
        .expect("create p3 following database");
    let fixture: ContractFixture<P3FollowingWriteModelFixture> =
        serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../fixtures/contracts/p3-following-write-model.v1.json"
        )))
        .expect("decode p3 following fixture");
    assert_eq!(fixture.schema_version, 1);
    assert_eq!(fixture.kind, "p3-following-write-model");
    let repository = storage.repository();

    let followed = repository
        .upsert_my_anime(fixture.payload.my_anime.clone())
        .expect("save my anime");
    assert_eq!(followed.len(), 1);
    assert_eq!(followed[0].anime.aliases[0].id, "anime-p3-1-alias-1");
    assert_eq!(followed[0].rss_subscriptions.len(), 1);

    repository
        .upsert_episode(&fixture.payload.episode)
        .expect("save episode one");
    let episode_two = Episode {
        id: "episode-anime-p3-1-2".to_owned(),
        episode_no: 2.0,
        title: Some("第二集".to_owned()),
        ..fixture.payload.episode.clone()
    };
    repository
        .upsert_episode(&episode_two)
        .expect("save episode two");
    let preferences = repository
        .upsert_episode_preference(&fixture.payload.preference)
        .expect("save preference");
    assert_eq!(preferences.len(), 1);
    assert_eq!(preferences[0], fixture.payload.preference);

    let progress = repository
        .set_anime_watch_progress(&fixture.payload.watch_progress_input)
        .expect("set watch progress");
    assert_eq!(progress.watched_episode_count, 1);
    assert_eq!(progress.total_episode_count, 12);
    assert_eq!(
        repository
            .list_episodes("anime-p3-1")
            .expect("list episodes")[1]
            .status,
        ani_domain::EpisodeStatus::Aired
    );

    insert_p3_playback_download(&storage.connection);
    assert!(repository
        .report_playback_progress(&fixture.payload.report_playback_progress_input)
        .expect("report playback progress"));
    assert_eq!(
        repository
            .list_episodes("anime-p3-1")
            .expect("list watched episodes")[1]
            .status,
        ani_domain::EpisodeStatus::Watched
    );
    repository
        .upsert_episode(&episode_two)
        .expect("reset episode two for checkpoint assertion");
    let checkpoint = repository
        .save_playback_checkpoint(&fixture.payload.save_playback_checkpoint_input)
        .expect("save playback checkpoint");
    assert_eq!(checkpoint.task_id, fixture.payload.checkpoint.task_id);
    assert!(checkpoint.watched_reported);
    assert_eq!(
        repository
            .get_playback_checkpoint("download-p3-1", Some(0))
            .expect("read checkpoint")
            .expect("checkpoint exists")
            .position_seconds,
        1_380.0
    );

    assert!(repository
        .remove_episode_preference("episode-anime-p3-1-1")
        .expect("remove preference")
        .is_empty());
    let mut completed = fixture.payload.my_anime.clone();
    completed.status = AnimeStatus::Completed;
    completed.auto_download = true;
    assert!(
        !repository
            .upsert_my_anime(completed)
            .expect("save completed my anime")[0]
            .auto_download
    );
    assert!(repository
        .remove_my_anime("my-anime-p3-1")
        .expect("remove my anime")
        .is_empty());
    assert!(repository
        .list_episodes("anime-p3-1")
        .expect("episodes removed")
        .is_empty());
}

/// 验证追番复合写入失败时番剧目录和追番记录均不落库。
#[test]
fn rolls_back_failed_p3_following_write() {
    let directory = TestDirectory::new("p3-following-rollback");
    let storage =
        Storage::open(test_options(&directory, "active.sqlite")).expect("create rollback database");
    let fixture: ContractFixture<P3FollowingWriteModelFixture> =
        serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../fixtures/contracts/p3-following-write-model.v1.json"
        )))
        .expect("decode p3 following fixture");
    let mut invalid = fixture.payload.my_anime;
    invalid.default_fansub_group_id = Some("missing-fansub".to_owned());

    assert!(storage.repository().upsert_my_anime(invalid).is_err());
    assert_eq!(
        storage
            .connection
            .query_row(
                "SELECT COUNT(*) FROM anime_catalog WHERE id = 'anime-p3-1'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .expect("catalog rollback count"),
        0
    );
    assert_eq!(
        storage
            .connection
            .query_row("SELECT COUNT(*) FROM my_anime", [], |row| row
                .get::<_, i64>(0))
            .expect("my anime rollback count"),
        0
    );
}

/// 验证下载任务和文件快照完整往返，并按文件进度同步关联单集。
#[test]
fn writes_download_snapshot_and_syncs_episode_statuses() {
    let directory = TestDirectory::new("p4-download-write");
    let storage = Storage::open(test_options(&directory, "active.sqlite"))
        .expect("create p4 download database");
    let fixture: ContractFixture<P3FollowingWriteModelFixture> =
        serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../fixtures/contracts/p3-following-write-model.v1.json"
        )))
        .expect("decode p3 following fixture");
    let repository = storage.repository();
    repository
        .upsert_my_anime(fixture.payload.my_anime.clone())
        .expect("save p4 anime");
    repository
        .upsert_episode(&fixture.payload.episode)
        .expect("save p4 episode one");
    let episode_two = Episode {
        id: "episode-anime-p3-1-2".to_owned(),
        episode_no: 2.0,
        title: Some("第二集".to_owned()),
        ..fixture.payload.episode
    };
    repository
        .upsert_episode(&episode_two)
        .expect("save p4 episode two");

    let task = p4_download_task();
    let saved = DownloadRepository::upsert_download_task(&repository, &task)
        .expect("save p4 download snapshot");
    assert_eq!(saved, vec![task.clone()]);
    assert_eq!(
        repository
            .list_episodes("anime-p3-1")
            .expect("list synced episodes")
            .into_iter()
            .map(|episode| episode.status)
            .collect::<Vec<_>>(),
        vec![EpisodeStatus::Downloading, EpisodeStatus::Downloaded]
    );

    let mut completed = task.clone();
    completed.status = DownloadStatus::Completed;
    completed.progress = 1.0;
    completed.created_at = "2099-01-01T00:00:00.000Z".to_owned();
    completed.completed_at = Some("2026-07-25T01:00:00.000Z".to_owned());
    for file in &mut completed.files {
        file.progress = 1.0;
    }
    let completed_snapshot = DownloadRepository::upsert_download_task(&repository, &completed)
        .expect("complete p4 download snapshot");
    assert_eq!(completed_snapshot[0].created_at, task.created_at);
    assert_eq!(completed_snapshot[0].completed_at, completed.completed_at);
    assert!(repository
        .list_episodes("anime-p3-1")
        .expect("list completed episodes")
        .iter()
        .all(|episode| episode.status == EpisodeStatus::Downloaded));
}

/// 验证删除下载任务会恢复单集状态，且外键失败不会留下半条任务。
#[test]
fn removes_download_snapshot_and_rolls_back_invalid_files() {
    let directory = TestDirectory::new("p4-download-remove");
    let storage = Storage::open(test_options(&directory, "active.sqlite"))
        .expect("create p4 download removal database");
    let fixture: ContractFixture<P3FollowingWriteModelFixture> =
        serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../fixtures/contracts/p3-following-write-model.v1.json"
        )))
        .expect("decode p3 following fixture");
    let repository = storage.repository();
    repository
        .upsert_my_anime(fixture.payload.my_anime.clone())
        .expect("save removal anime");
    repository
        .upsert_episode(&fixture.payload.episode)
        .expect("save removal episode one");
    repository
        .upsert_episode(&Episode {
            id: "episode-anime-p3-1-2".to_owned(),
            episode_no: 2.0,
            ..fixture.payload.episode
        })
        .expect("save removal episode two");
    let task = p4_download_task();
    DownloadRepository::upsert_download_task(&repository, &task).expect("save removable task");

    let remaining = DownloadRepository::remove_download_task(
        &repository,
        task.torrent_hash.as_deref().expect("task hash"),
    )
    .expect("remove task by hash");
    assert!(remaining.is_empty());
    assert!(repository
        .list_episodes("anime-p3-1")
        .expect("list restored episodes")
        .iter()
        .all(|episode| episode.status == EpisodeStatus::Aired));

    let mut invalid = p4_download_task();
    invalid.id = "p4-invalid-task".to_owned();
    invalid.files[0].episode_id = Some("missing-episode".to_owned());
    assert!(DownloadRepository::upsert_download_task(&repository, &invalid).is_err());
    assert!(DownloadRepository::list_downloads(&repository)
        .expect("list downloads after rollback")
        .is_empty());
}

/// 验证媒体记录完整往返，并按文件路径移除旧标识。
#[test]
fn upserts_media_files_and_deduplicates_paths() {
    let directory = TestDirectory::new("p4-media-write");
    let storage =
        Storage::open(test_options(&directory, "active.sqlite")).expect("create media database");
    let repository = storage.repository();
    let mut media = MediaFile {
        id: "media-old".to_owned(),
        anime_id: "anime-1".to_owned(),
        episode_id: Some("episode-1".to_owned()),
        download_task_id: Some("download-1".to_owned()),
        file_path: "C:/Anime/episode-1.mkv".to_owned(),
        file_name: "episode-1.mkv".to_owned(),
        size: 1024,
        container: Some("mkv".to_owned()),
        declared_video_codec: Some("HEVC".to_owned()),
        detected_video_codec: Some("hevc".to_owned()),
        normalized_video_codec: "H.265/HEVC".to_owned(),
        resolution: Some("1920x1080".to_owned()),
        bit_depth: Some(10),
        audio_codecs: vec!["AAC".to_owned()],
        subtitle_tracks: vec!["chi / ASS".to_owned()],
        duration_seconds: Some(1440),
        downloaded_at: Some("2026-07-25T00:00:00.000Z".to_owned()),
        probed_at: Some("2026-07-25T00:01:00.000Z".to_owned()),
    };
    let first = MediaRepository::upsert_media_files(&repository, &[media.clone()])
        .expect("write first media");
    assert_eq!(first.len(), 1);
    assert_eq!(first[0].audio_codecs, ["AAC"]);

    media.id = "media-new".to_owned();
    media.duration_seconds = Some(1500);
    let replaced =
        MediaRepository::upsert_media_files(&repository, &[media]).expect("replace media by path");

    assert_eq!(replaced.len(), 1);
    assert_eq!(replaced[0].id, "media-new");
    assert_eq!(replaced[0].duration_seconds, Some(1500));
}

/// 验证番剧目录合并、搜索、月份替换和详情聚合保持业务引用。
#[test]
fn reads_and_replaces_p3_anime_catalog() {
    let directory = TestDirectory::new("p3-catalog");
    let storage = Storage::open(test_options(&directory, "active.sqlite"))
        .expect("create p3 catalog database");
    let fixture: ContractFixture<P3FollowingWriteModelFixture> =
        serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../fixtures/contracts/p3-following-write-model.v1.json"
        )))
        .expect("decode p3 following fixture");
    let repository = storage.repository();
    repository
        .upsert_my_anime(fixture.payload.my_anime.clone())
        .expect("save referenced anime");

    let mut old_cache = fixture.payload.my_anime.anime.clone();
    old_cache.id = "anime-p3-old-cache".to_owned();
    old_cache.title = "待替换缓存番剧".to_owned();
    old_cache.original_title = Some("Old Cache Anime".to_owned());
    old_cache.external_ids = json!({ "bangumi": "old-cache" });
    old_cache.aliases[0].alias = "Old Cache Alias".to_owned();
    let initial = repository
        .upsert_anime_catalog(&[old_cache])
        .expect("save old catalog cache");
    assert_eq!(initial.added_count, 1);
    assert_eq!(
        repository
            .list_anime_catalog(Some(2026), Some(7))
            .expect("list july catalog")
            .len(),
        2
    );
    assert_eq!(
        repository
            .search_anime_catalog("p3 alias")
            .expect("search alias")
            .items[0]
            .id,
        "anime-p3-1"
    );

    let mut refreshed = fixture.payload.my_anime.anime.clone();
    refreshed.id = "provider-replacement-id".to_owned();
    refreshed.title = "P3 刷新番剧".to_owned();
    refreshed.aliases[0].alias = "Refreshed Alias".to_owned();
    refreshed.detail = Some(json!({
        "episodeCount": 12,
        "refreshedAt": chrono::Utc::now().to_rfc3339()
    }));
    let replaced = repository
        .replace_anime_catalog_month(2026, 7, &[refreshed])
        .expect("replace july catalog");
    assert_eq!(replaced.existing_count, 1);
    let july = repository
        .list_anime_catalog(Some(2026), Some(7))
        .expect("list replaced july catalog");
    assert_eq!(july.len(), 1);
    assert_eq!(july[0].id, "anime-p3-1");
    assert_eq!(july[0].title, "P3 刷新番剧");
    assert!(july[0]
        .aliases
        .iter()
        .any(|alias| alias.alias == "Refreshed Alias"));

    let detail = repository
        .get_anime_detail("anime-p3-1")
        .expect("read local anime detail");
    assert!(detail.my_anime.is_some());
    assert!(!detail.stale);
    assert!(detail.partial_errors.is_empty());
}

/// 验证公共工作单元能回滚或提交复用事务的 Repository 写入。
#[test]
fn exposes_atomic_repository_unit_of_work() {
    let directory = TestDirectory::new("repository-unit-of-work");
    let mut storage = Storage::open(test_options(&directory, "active.sqlite"))
        .expect("open repository unit of work database");
    let cache_key = "source-search-unit-of-work";
    let now = "2026-07-25T00:00:00.000Z";
    let entry = ReleaseSearchCacheEntry {
        result: json!({ "items": [{ "title": "事务缓存" }] }),
        expires_at: "2026-07-26T00:00:00.000Z".to_owned(),
    };

    let work = storage
        .begin_unit_of_work()
        .expect("begin rollback unit of work");
    {
        let repositories = work.repositories();
        ReleaseSourceRepository::upsert_release_search_cache(&repositories, cache_key, &entry)
            .expect("write cache inside rollback unit of work");
        assert!(
            ReleaseSourceRepository::get_release_search_cache(&repositories, cache_key, now)
                .expect("read uncommitted cache")
                .is_some()
        );
    }
    work.rollback().expect("rollback unit of work");
    assert!(ReleaseSourceRepository::get_release_search_cache(
        &storage.repository(),
        cache_key,
        now
    )
    .expect("read cache after rollback")
    .is_none());

    let work = storage
        .begin_unit_of_work()
        .expect("begin commit unit of work");
    {
        let repositories = work.repositories();
        ReleaseSourceRepository::upsert_release_search_cache(&repositories, cache_key, &entry)
            .expect("write cache inside commit unit of work");
    }
    work.commit().expect("commit unit of work");
    assert!(ReleaseSourceRepository::get_release_search_cache(
        &storage.repository(),
        cache_key,
        now
    )
    .expect("read cache after commit")
    .is_some());
}

/// 验证来源配置、同步游标、熔断和搜索缓存均通过 SQLite 适配器持久化。
#[test]
fn persists_p3_source_network_state() {
    let directory = TestDirectory::new("p3-source-network");
    let storage = Storage::open(test_options(&directory, "active.sqlite"))
        .expect("open p3 source network database");
    let fixture: ContractFixture<P3SourceNetworkModelFixture> =
        serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../fixtures/contracts/p3-source-network-model.v1.json"
        )))
        .expect("decode p3 source network fixture");
    let repository = storage.repository();

    let sources = repository
        .upsert_source(&fixture.payload.source)
        .expect("save source config");
    assert!(sources
        .iter()
        .any(|source| source.id == fixture.payload.source.id));
    repository
        .upsert_source_sync_state(&fixture.payload.sync_state)
        .expect("save source sync state");
    assert_eq!(
        repository
            .list_source_sync_states()
            .expect("list source sync states")
            .into_iter()
            .find(|state| state.source_id == fixture.payload.source.id)
            .expect("saved source sync state")
            .request_failure_count,
        2
    );
    repository
        .upsert_request_circuit_state(&fixture.payload.circuit_state)
        .expect("save request circuit state");
    assert_eq!(
        repository
            .get_request_circuit_state(&fixture.payload.circuit_state.key)
            .expect("read request circuit state")
            .expect("saved request circuit state")
            .failure_count,
        2
    );
    repository
        .clear_request_circuit_state(&fixture.payload.circuit_state.key)
        .expect("clear request circuit state");
    assert!(repository
        .get_request_circuit_state(&fixture.payload.circuit_state.key)
        .expect("read cleared request circuit state")
        .is_none());
}

/// 验证来源绑定和排除记录通过公共 Repository 端口完整持久化并校验输入。
#[test]
fn persists_p3_source_bindings_and_exclusions() {
    let directory = TestDirectory::new("p3-source-binding");
    let storage = Storage::open(test_options(&directory, "active.sqlite"))
        .expect("open p3 source binding database");
    let fixture: ContractFixture<P3SourceBindingModelFixture> =
        serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../fixtures/contracts/p3-source-binding-model.v1.json"
        )))
        .expect("decode p3 source binding fixture");
    assert_eq!(fixture.schema_version, 1);
    assert_eq!(fixture.kind, "p3-source-binding-model");
    insert_source(
        &storage.connection,
        &fixture.payload.binding.source_id,
        false,
    );
    insert_source_binding_anime(&storage.connection, &fixture.payload.binding.anime_id);
    let repository = storage.repository();

    let bindings = AnimeSourceBindingRepository::upsert_anime_source_binding(
        &repository,
        &fixture.payload.binding,
    )
    .expect("save source binding");
    assert_eq!(bindings.len(), 1);
    assert_eq!(bindings[0], fixture.payload.binding);

    let mut replacement = fixture.payload.binding.clone();
    replacement.id = "replacement-binding-id".to_owned();
    replacement.source_anime_id = "528829".to_owned();
    replacement.match_method = AnimeSourceBindingMatchMethod::Manual;
    replacement.confidence = 0.75;
    replacement.updated_at = "2026-07-25T00:10:00.000Z".to_owned();
    let bindings =
        AnimeSourceBindingRepository::upsert_anime_source_binding(&repository, &replacement)
            .expect("replace source binding");
    assert_eq!(bindings.len(), 1);
    assert_eq!(bindings[0].source_anime_id, "528829");
    assert_eq!(bindings[0].created_at, fixture.payload.binding.created_at);

    let mut invalid_binding = replacement.clone();
    invalid_binding.source_url = Some("file:///private/source".to_owned());
    assert!(matches!(
        AnimeSourceBindingRepository::upsert_anime_source_binding(&repository, &invalid_binding),
        Err(RepositoryError::InvalidInput { .. })
    ));

    let exclusions = AnimeSourceBindingRepository::upsert_anime_source_exclusion(
        &repository,
        &fixture.payload.exclusion,
    )
    .expect("save candidate exclusion");
    assert_eq!(exclusions, vec![fixture.payload.exclusion.clone()]);

    let mut source_exclusion = fixture.payload.exclusion.clone();
    source_exclusion.id = "source-exclusion-all".to_owned();
    source_exclusion.scope = AnimeSourceExclusionScope::Source;
    source_exclusion.source_anime_id = None;
    source_exclusion.source_anime_title = None;
    let exclusions =
        AnimeSourceBindingRepository::upsert_anime_source_exclusion(&repository, &source_exclusion)
            .expect("save source exclusion");
    assert_eq!(exclusions.len(), 2);

    let mut invalid_exclusion = fixture.payload.exclusion.clone();
    invalid_exclusion.source_anime_id = None;
    assert!(matches!(
        AnimeSourceBindingRepository::upsert_anime_source_exclusion(
            &repository,
            &invalid_exclusion
        ),
        Err(RepositoryError::InvalidInput { .. })
    ));

    let exclusions = AnimeSourceBindingRepository::remove_anime_source_exclusion(
        &repository,
        &fixture.payload.exclusion.anime_id,
        &fixture.payload.exclusion.source_id,
        fixture.payload.exclusion.source_anime_id.as_deref(),
    )
    .expect("remove candidate exclusion");
    assert_eq!(exclusions, vec![source_exclusion]);
    let exclusions = AnimeSourceBindingRepository::remove_anime_source_exclusion(
        &repository,
        &fixture.payload.exclusion.anime_id,
        &fixture.payload.exclusion.source_id,
        None,
    )
    .expect("remove source exclusion");
    assert!(exclusions.is_empty());

    let bindings = AnimeSourceBindingRepository::remove_anime_source_binding(
        &repository,
        &replacement.anime_id,
        &replacement.source_id,
    )
    .expect("remove source binding");
    assert!(bindings.is_empty());
}

/// 验证原始资源缓存与动态字幕组观察通过公共 Repository 端口持久化。
#[test]
fn persists_p3_release_cache_and_observed_fansubs() {
    let directory = TestDirectory::new("p3-release-cache");
    let storage = Storage::open(test_options(&directory, "active.sqlite"))
        .expect("open p3 release cache database");
    let fixture: ContractFixture<P3ReleaseSearchModelFixture> =
        serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../fixtures/contracts/p3-release-search-model.v1.json"
        )))
        .expect("decode p3 release search fixture");
    let release = fixture.payload.search_result.releases[0].clone();
    insert_source(&storage.connection, &release.source_id, false);
    insert_source_binding_anime(
        &storage.connection,
        release.anime_id.as_deref().expect("fixture anime id"),
    );
    let repository = storage.repository();

    let mut alias_release = release.clone();
    alias_release.fansub_name = Some("契约字幕组别名".to_owned());
    alias_release.source_id = "other-contract".to_owned();
    let observed = AnimeCatalogRepository::observe_anime_fansubs(
        &repository,
        release.anime_id.as_deref().expect("fixture anime id"),
        &[release.clone(), alias_release],
    )
    .expect("observe release fansubs");
    assert_eq!(observed.len(), 1);
    assert_eq!(observed[0].id, "fansub-contract");
    assert_eq!(observed[0].name, "契约字幕组");
    assert_eq!(observed[0].aliases, vec!["契约字幕组别名"]);
    assert_eq!(
        observed[0].source_ids,
        vec!["other-contract", "rss-contract"]
    );

    assert_eq!(
        ReleaseCacheRepository::upsert_cached_releases(&repository, std::slice::from_ref(&release))
            .expect("save first cached release"),
        1
    );
    assert_eq!(
        ReleaseCacheRepository::upsert_cached_releases(&repository, std::slice::from_ref(&release))
            .expect("save duplicate cached release"),
        0
    );
    let query = CachedReleaseQuery {
        source_ids: Some(vec![release.source_id.clone()]),
        anime_id: release.anime_id.clone(),
        limit: Some(10),
    };
    assert_eq!(
        ReleaseCacheRepository::list_cached_releases(&repository, &query)
            .expect("list cached release"),
        vec![release.clone()]
    );

    let mut refreshed = release.clone();
    refreshed.anime_id = None;
    refreshed.seeders = Some(48);
    ReleaseCacheRepository::upsert_cached_releases(&repository, &[refreshed])
        .expect("refresh cached release without anime id");
    let cached = ReleaseCacheRepository::list_cached_releases(&repository, &query)
        .expect("list refreshed cached release");
    assert_eq!(cached.len(), 1);
    assert_eq!(cached[0].anime_id, release.anime_id);
    assert_eq!(cached[0].seeders, Some(48));
    assert!(ReleaseCacheRepository::list_cached_releases(
        &repository,
        &CachedReleaseQuery {
            source_ids: Some(Vec::new()),
            ..CachedReleaseQuery::default()
        }
    )
    .expect("list empty source cache")
    .is_empty());

    assert_eq!(
        ReleaseCacheRepository::prune_cached_releases(&repository, "2026-07-26T00:00:00.000Z")
            .expect("prune cached releases"),
        1
    );
    assert!(
        ReleaseCacheRepository::list_cached_releases(&repository, &query)
            .expect("list pruned cache")
            .is_empty()
    );
}

/// 验证公共通知写入端口增量保存来源同步提醒并保留已读状态。
#[test]
fn persists_notifications_through_repository_port() {
    let directory = TestDirectory::new("notification-write");
    let storage = Storage::open(test_options(&directory, "active.sqlite"))
        .expect("open notification database");
    let repository = storage.repository();
    let mut record = NotificationRecord {
        id: "source-sync-contract".to_owned(),
        kind: NotificationKind::System,
        title: "来源同步失败".to_owned(),
        body: "失败来源：契约来源".to_owned(),
        severity: NotificationSeverity::Warning,
        anime_id: None,
        episode_id: None,
        download_task_id: None,
        created_at: "2026-07-25T01:00:00.000Z".to_owned(),
        read_at: Some("2026-07-25T02:00:00.000Z".to_owned()),
    };
    let saved =
        NotificationRepository::add_notifications(&repository, std::slice::from_ref(&record))
            .expect("save source sync notification");
    assert_eq!(saved, vec![record.clone()]);
    record.body = "更新后的失败原因".to_owned();
    record.read_at = None;
    let updated = NotificationRepository::add_notifications(&repository, &[record])
        .expect("update source sync notification");
    assert_eq!(updated[0].body, "更新后的失败原因");
    assert_eq!(
        updated[0].read_at.as_deref(),
        Some("2026-07-25T02:00:00.000Z")
    );
    assert_eq!(
        NotificationRepository::get_unread_notification_count(&repository)
            .expect("count unread notifications"),
        0
    );
}

/// 验证公共通知端口支持单条已读、全部已读和清空操作。
#[test]
fn mutates_notifications_through_repository_port() {
    let directory = TestDirectory::new("notification-mutations");
    let storage = Storage::open(test_options(&directory, "active.sqlite"))
        .expect("open notification database");
    let repository = storage.repository();
    let records = ["notification-a", "notification-b"].map(|id| NotificationRecord {
        id: id.to_owned(),
        kind: NotificationKind::System,
        title: "系统提醒".to_owned(),
        body: "测试通知状态".to_owned(),
        severity: NotificationSeverity::Info,
        anime_id: None,
        episode_id: None,
        download_task_id: None,
        created_at: format!(
            "2026-07-25T01:00:0{}.000Z",
            if id.ends_with('a') { 1 } else { 2 }
        ),
        read_at: None,
    });
    NotificationRepository::add_notifications(&repository, &records).expect("save notifications");

    let marked = NotificationRepository::mark_notification_read(&repository, "notification-a")
        .expect("mark notification read");
    assert!(marked
        .iter()
        .find(|record| record.id == "notification-a")
        .and_then(|record| record.read_at.as_ref())
        .is_some());
    assert_eq!(
        NotificationRepository::get_unread_notification_count(&repository)
            .expect("count one unread notification"),
        1
    );

    let all_read = NotificationRepository::mark_all_notifications_read(&repository)
        .expect("mark all notifications read");
    assert!(all_read.iter().all(|record| record.read_at.is_some()));
    assert!(NotificationRepository::clear_notifications(&repository)
        .expect("clear notifications")
        .is_empty());
    assert!(NotificationRepository::list_notifications(&repository)
        .expect("list cleared notifications")
        .is_empty());
}

/// 创建包含固定设置和下载源的测试启动参数。
fn test_options(directory: &TestDirectory, database_name: &str) -> StorageOptions {
    StorageOptions {
        database_path: directory.path().join(database_name),
        backup_directory: directory.path().join("backups"),
        legacy_database_paths: Vec::new(),
        seed: StorageSeed {
            settings: json!({ "appearance": { "mode": "system" } }),
            dashboard: json!({ "todayEpisodes": [] }),
            release_sources: vec![ReleaseSourceSeed {
                id: "anibt".to_owned(),
                name: "AniBT".to_owned(),
                kind: "site_adapter".to_owned(),
                enabled: true,
                use_proxy: false,
                request_interval_ms: 1_500,
                base_url: Some("https://anibt.example".to_owned()),
                api_key: None,
                rss_url: None,
                tags: vec!["anime".to_owned()],
            }],
        },
    }
}

/// 写入覆盖 P2 首批查询的固定业务样本。
fn insert_p2_read_model_fixture(connection: &Connection) {
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    connection
        .execute(
            "UPDATE app_settings SET value_json = ?1 WHERE key = 'settings'",
            [r#"{"appearance":{"mode":"dark"},"players":[{"id":"built-in","executablePath":"C:/VLC/vlc.exe"}]}"#],
        )
        .expect("patch stored settings");
    connection
        .execute(
            "UPDATE app_state SET value_json = ?1 WHERE key = 'dashboard'",
            [r#"{"weeklySchedule":[{"day":"周一","items":[]}],"sourceHealth":[{"sourceId":"anibt","name":"AniBT","status":"ok"}]}"#],
        )
        .expect("patch stored dashboard");
    connection
        .execute(
            "UPDATE release_source SET enabled = 0 WHERE id = 'anibt'",
            [],
        )
        .expect("disable fixture source");
    connection
        .execute(
            "INSERT INTO fansub_group (id, name, aliases_json, source_ids_json, created_at, updated_at)
             VALUES ('fansub-1', '测试字幕组', '[]', '[]', ?1, ?1)",
            [&now],
        )
        .expect("insert fansub");
    connection
        .execute(
            r#"INSERT INTO anime_catalog (
               id, title, original_title, premiere_year, premiere_month, external_ids_json,
               detail_json, created_at, updated_at
             ) VALUES ('anime-1', '测试番剧', 'Test Anime', 2026, 7, '{"bangumi":"1"}',
               '{"episodeCount":12}', ?1, ?1)"#,
            [&now],
        )
        .expect("insert anime");
    connection
        .execute(
            "INSERT INTO anime_alias (id, anime_id, alias, language, priority)
             VALUES ('alias-1', 'anime-1', '测试别名', 'zh', 10)",
            [],
        )
        .expect("insert alias");
    connection
        .execute(
            "INSERT INTO my_anime (
               id, anime_id, status, default_fansub_group_id, auto_download,
               preferred_subtitle, preferred_subtitle_languages_json, added_at, updated_at
             ) VALUES ('my-anime-1', 'anime-1', 'watching', 'fansub-1', 1,
               'multi', '[]', ?1, ?1)",
            [&now],
        )
        .expect("insert my anime");
    connection
        .execute(
            "INSERT INTO my_anime_rss_subscription (
               id, my_anime_id, name, url, enabled, preferred_subtitle,
               preferred_subtitle_languages_json, created_at, updated_at
             ) VALUES ('rss-1', 'my-anime-1', '测试 RSS', 'https://example.test/rss', 1,
               'cht', '[]', ?1, ?1)",
            [&now],
        )
        .expect("insert rss subscription");

    for (episode_no, status) in [(1_i64, "aired"), (2_i64, "aired"), (3_i64, "aired")] {
        connection
            .execute(
                "INSERT INTO episode (
                   id, anime_id, episode_no, air_time, status, created_at, updated_at
                 ) VALUES (?1, 'anime-1', ?2, ?3, ?4, ?3, ?3)",
                params![format!("episode-{episode_no}"), episode_no, &now, status],
            )
            .expect("insert episode");
    }
    insert_download(
        connection,
        "download-active",
        "episode-2",
        2,
        "downloading",
        0.5,
        &now,
    );
    insert_download(
        connection,
        "download-completed",
        "episode-3",
        3,
        "completed",
        1.0,
        &now,
    );
    connection
        .execute(
            r#"INSERT INTO media_file (
               id, anime_id, episode_id, download_task_id, file_path, file_name, size,
               normalized_video_codec, audio_codecs_json, subtitle_tracks_json, downloaded_at
             ) VALUES ('media-1', 'anime-1', 'episode-3', 'download-completed',
               'C:/video/3.mkv', '3.mkv', 1024, 'H.265/HEVC', '["aac"]', '["ass"]', ?1)"#,
            [&now],
        )
        .expect("insert media file");
    connection
        .execute(
            "INSERT INTO notification (id, kind, title, body, severity, created_at, read_at)
             VALUES ('notification-old', 'system', '已读', '旧通知', 'info',
               '2026-07-01T00:00:00.000Z', '2026-07-01T01:00:00.000Z')",
            [],
        )
        .expect("insert old notification");
    connection
        .execute(
            "INSERT INTO notification (id, kind, title, body, severity, created_at)
             VALUES ('notification-new', 'download', '下载完成', '第 3 集', 'success',
               '2026-07-02T00:00:00.000Z')",
            [],
        )
        .expect("insert unread notification");
}

/// 创建覆盖任务元数据和文件级单集关联的 P4 下载快照。
fn p4_download_task() -> DownloadTask {
    DownloadTask {
        id: "p4-download-task".to_owned(),
        release_id: None,
        anime_id: Some("anime-p3-1".to_owned()),
        episode_id: None,
        anime_title: Some("P3 契约番剧".to_owned()),
        episode_no: None,
        fansub_group_id: None,
        fansub_name: None,
        resolution: Some("1080p".to_owned()),
        declared_video_codec: Some("HEVC".to_owned()),
        normalized_video_codec: Some("H.265/HEVC".to_owned()),
        bit_depth: Some(10),
        subtitle_languages: vec!["chs".to_owned(), "cht".to_owned()],
        subtitle: Some("multi".to_owned()),
        correlation_tag: Some("p4-contract".to_owned()),
        engine: TorrentEngineKind::Embedded,
        torrent_hash: Some("p4-hash".to_owned()),
        name: "P4 batch".to_owned(),
        status: DownloadStatus::Downloading,
        progress: 0.5,
        download_speed: 1024,
        upload_speed: 128,
        eta_seconds: Some(60),
        save_path: "C:/video".to_owned(),
        files: vec![
            TorrentFile {
                id: "p4-hash:0".to_owned(),
                index: 0,
                name: "episode-1.mkv".to_owned(),
                episode_id: Some("episode-anime-p3-1-1".to_owned()),
                episode_no: Some(1.0),
                size: 1024,
                progress: 0.5,
                priority: 1,
                selected: true,
            },
            TorrentFile {
                id: "p4-hash:1".to_owned(),
                index: 1,
                name: "episode-2.mkv".to_owned(),
                episode_id: Some("episode-anime-p3-1-2".to_owned()),
                episode_no: Some(2.0),
                size: 2048,
                progress: 1.0,
                priority: 7,
                selected: true,
            },
        ],
        created_at: "2026-07-25T00:00:00.000Z".to_owned(),
        completed_at: None,
    }
}

/// 写入使用文件级单集关联的 P3 播放任务。
fn insert_p3_playback_download(connection: &Connection) {
    let timestamp = "2026-07-25T00:00:00.000Z";
    connection
        .execute(
            "INSERT INTO download_task (
               id, anime_id, anime_title, engine, name, status, progress,
               download_speed, upload_speed, save_path, created_at, updated_at
             ) VALUES (
               'download-p3-1', 'anime-p3-1', 'P3 契约番剧', 'embedded',
               'P3 batch', 'downloading', 0.5, 1024, 0, 'C:/video', ?1, ?1
             )",
            [timestamp],
        )
        .expect("insert p3 download task");
    connection
        .execute(
            "INSERT INTO torrent_file (
               id, download_task_id, file_index, name, episode_id, episode_no,
               size, progress, priority, selected
             ) VALUES (
               'torrent-file-p3-1', 'download-p3-1', 0, 'episode-2.mkv',
               'episode-anime-p3-1-2', 2, 1024, 0.5, 1, 1
             )",
            [],
        )
        .expect("insert p3 torrent file");
}

/// 写入首页下载状态测试记录。
fn insert_download(
    connection: &Connection,
    id: &str,
    episode_id: &str,
    episode_no: i64,
    status: &str,
    progress: f64,
    timestamp: &str,
) {
    connection
        .execute(
            "INSERT INTO download_task (
               id, anime_id, episode_id, anime_title, episode_no, fansub_group_id, fansub_name,
               engine, name, status, progress, download_speed, upload_speed, save_path,
               created_at, updated_at
             ) VALUES (?1, 'anime-1', ?2, '测试番剧', ?3, 'fansub-1', '测试字幕组',
               'embedded', ?1, ?4, ?5, 1024, 0, 'C:/video', ?6, ?6)",
            params![id, episode_id, episode_no, status, progress, timestamp],
        )
        .expect("insert download task");
}

/// 插入旧版下载源测试记录。
fn insert_source(connection: &Connection, id: &str, use_proxy: bool) {
    connection
        .execute(
            "INSERT OR REPLACE INTO release_source (
               id, name, kind, enabled, use_proxy, request_interval_ms, tags_json, created_at, updated_at
             ) VALUES (?1, ?1, 'manual', 1, ?2, 1000, '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
            params![id, if use_proxy { 1_i64 } else { 0_i64 }],
        )
        .expect("insert source fixture");
}

/// 写入来源绑定外键依赖的最小番剧目录记录。
fn insert_source_binding_anime(connection: &Connection, anime_id: &str) {
    connection
        .execute(
            "INSERT INTO anime_catalog (
               id, title, premiere_year, premiere_month, external_ids_json, created_at, updated_at
             ) VALUES (?1, '来源绑定契约番', 2026, 7, '{}',
               '2026-07-25T00:00:00.000Z', '2026-07-25T00:00:00.000Z')",
            [anime_id],
        )
        .expect("insert source binding anime fixture");
}

/// 读取一项数据库版本元数据。
fn read_meta(connection: &Connection, key: &str) -> String {
    connection
        .query_row("SELECT value FROM app_meta WHERE key = ?1", [key], |row| {
            row.get(0)
        })
        .expect("read app_meta value")
}

/// 判断表中是否存在指定列。
fn column_exists(connection: &Connection, table: &str, column: &str) -> bool {
    let mut statement = connection
        .prepare(&format!("PRAGMA table_info({table})"))
        .expect("prepare table_info");
    statement
        .query_map([], |row| row.get::<_, String>(1))
        .expect("query table_info")
        .collect::<Result<Vec<_>, _>>()
        .expect("collect table_info")
        .iter()
        .any(|name| name == column)
}

/// 统计指定下载源记录。
fn source_count(connection: &Connection, source_id: &str) -> i64 {
    connection
        .query_row(
            "SELECT COUNT(*) FROM release_source WHERE id = ?1",
            [source_id],
            |row| row.get(0),
        )
        .expect("source count")
}

/// 读取指定下载源代理标记。
fn source_proxy(connection: &Connection, source_id: &str) -> i64 {
    connection
        .query_row(
            "SELECT use_proxy FROM release_source WHERE id = ?1",
            [source_id],
            |row| row.get(0),
        )
        .expect("source proxy")
}

/// 以只读模式打开测试数据库。
fn open_read_only(path: &Path) -> Connection {
    Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .expect("open read-only database")
}

/// 自动清理的独立测试目录。
struct TestDirectory {
    path: PathBuf,
}

impl TestDirectory {
    /// 创建不与并行测试冲突的临时目录。
    fn new(label: &str) -> Self {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock after epoch")
            .as_nanos();
        let sequence = TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "ani-storage-{label}-{}-{timestamp}-{sequence}",
            std::process::id()
        ));
        fs::create_dir_all(&path).expect("create test directory");
        Self { path }
    }

    /// 返回测试目录路径。
    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TestDirectory {
    /// 测试结束后删除精确创建的临时目录。
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}
