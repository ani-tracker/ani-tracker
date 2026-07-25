use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use ani_domain::{
    AnimeStatus, Episode, EpisodePreference, MyAnime, PlaybackCheckpoint,
    ReportPlaybackProgressInput, SavePlaybackCheckpointInput, SetAnimeWatchProgressInput,
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
