use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OpenFlags};
use serde_json::json;

use crate::{
    ReleaseSourceSeed, Storage, StorageError, StorageOptions, StorageSeed, APP_DATA_VERSION,
    SQLITE_SCHEMA_VERSION,
};

static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

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
