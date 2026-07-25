use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};

use crate::{
    now_iso, ReleaseSourceSeed, StorageError, StorageSeed, APP_DATA_VERSION, SQLITE_SCHEMA_VERSION,
};

const CURRENT_SCHEMA: &str = include_str!("schema_v18.sql");

/// 数据库中记录的结构和应用数据版本。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct DatabaseVersions {
    pub schema_version: Option<u32>,
    pub app_data_version: Option<u32>,
}

/// 读取数据库版本；空库返回两个空值。
pub(crate) fn read_database_versions(
    connection: &Connection,
) -> Result<DatabaseVersions, StorageError> {
    if !table_exists(connection, "app_meta")? {
        return Ok(DatabaseVersions {
            schema_version: None,
            app_data_version: None,
        });
    }

    Ok(DatabaseVersions {
        schema_version: read_version(connection, "schema_version")?,
        app_data_version: read_version(connection, "app_data_version")?,
    })
}

/// 在单个立即事务中完成结构迁移、业务数据迁移和首次 seed。
pub(crate) fn initialize_database(
    connection: &mut Connection,
    seed: &StorageSeed,
) -> Result<(), StorageError> {
    connection.execute_batch("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;")?;
    let versions = read_database_versions(connection)?;
    validate_supported_versions(versions)?;

    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    transaction.execute_batch(CURRENT_SCHEMA)?;
    ensure_legacy_columns(&transaction)?;
    migrate_schema_data(&transaction, versions.schema_version.unwrap_or(0))?;

    match versions.app_data_version {
        None => seed_database(&transaction, seed)?,
        Some(version) if version < APP_DATA_VERSION => migrate_app_data(&transaction, version)?,
        Some(_) => {}
    }

    set_meta(
        &transaction,
        "schema_version",
        &SQLITE_SCHEMA_VERSION.to_string(),
    )?;
    set_meta(
        &transaction,
        "app_data_version",
        &APP_DATA_VERSION.to_string(),
    )?;
    transaction.commit()?;
    Ok(())
}

/// 拒绝由更高版本应用创建的数据库，避免破坏未知结构。
fn validate_supported_versions(versions: DatabaseVersions) -> Result<(), StorageError> {
    if let Some(actual) = versions
        .schema_version
        .filter(|version| *version > SQLITE_SCHEMA_VERSION)
    {
        return Err(StorageError::UnsupportedSchemaVersion {
            actual,
            supported: SQLITE_SCHEMA_VERSION,
        });
    }
    if let Some(actual) = versions
        .app_data_version
        .filter(|version| *version > APP_DATA_VERSION)
    {
        return Err(StorageError::UnsupportedAppDataVersion {
            actual,
            supported: APP_DATA_VERSION,
        });
    }
    Ok(())
}

/// 补齐历史数据库中版本号与真实列不一致的情况。
fn ensure_legacy_columns(transaction: &Transaction<'_>) -> Result<(), StorageError> {
    for (table, column, definition) in [
        ("anime_catalog", "rating_score", "rating_score REAL"),
        ("anime_catalog", "rating_count", "rating_count INTEGER"),
        ("anime_catalog", "rating_source", "rating_source TEXT"),
        (
            "anime_catalog",
            "detail_json",
            "detail_json TEXT NOT NULL DEFAULT '{}'",
        ),
        (
            "my_anime",
            "preferred_subtitle_languages_json",
            "preferred_subtitle_languages_json TEXT NOT NULL DEFAULT '[]'",
        ),
        (
            "my_anime",
            "preferred_bit_depth",
            "preferred_bit_depth INTEGER",
        ),
        (
            "my_anime_rss_subscription",
            "preferred_subtitle",
            "preferred_subtitle TEXT",
        ),
        (
            "my_anime_rss_subscription",
            "preferred_subtitle_languages_json",
            "preferred_subtitle_languages_json TEXT NOT NULL DEFAULT '[]'",
        ),
        (
            "my_anime_rss_subscription",
            "refresh_interval_minutes",
            "refresh_interval_minutes INTEGER",
        ),
        (
            "my_anime_rss_subscription",
            "last_fetched_at",
            "last_fetched_at TEXT",
        ),
        ("release", "bit_depth", "bit_depth INTEGER"),
        (
            "release",
            "subtitle_languages_json",
            "subtitle_languages_json TEXT NOT NULL DEFAULT '[]'",
        ),
        ("download_task", "resolution", "resolution TEXT"),
        (
            "download_task",
            "declared_video_codec",
            "declared_video_codec TEXT",
        ),
        (
            "download_task",
            "normalized_video_codec",
            "normalized_video_codec TEXT",
        ),
        ("download_task", "bit_depth", "bit_depth INTEGER"),
        (
            "download_task",
            "subtitle_languages_json",
            "subtitle_languages_json TEXT NOT NULL DEFAULT '[]'",
        ),
        ("download_task", "subtitle", "subtitle TEXT"),
        (
            "release_source",
            "use_proxy",
            "use_proxy INTEGER NOT NULL DEFAULT 0",
        ),
        (
            "release_source",
            "request_interval_ms",
            "request_interval_ms INTEGER NOT NULL DEFAULT 1000",
        ),
        (
            "release_source_sync_state",
            "request_host",
            "request_host TEXT",
        ),
        ("torrent_file", "episode_id", "episode_id TEXT"),
        ("torrent_file", "episode_no", "episode_no REAL"),
    ] {
        ensure_column(transaction, table, column, definition)?;
    }
    Ok(())
}

/// 执行现有 TypeScript Repository 已发布的结构数据迁移。
fn migrate_schema_data(
    transaction: &Transaction<'_>,
    current_schema_version: u32,
) -> Result<(), StorageError> {
    if current_schema_version < 5 {
        transaction.execute_batch(
            r#"
            INSERT OR IGNORE INTO anime_fansub_group
              (anime_id, fansub_group_id, first_seen_at, last_seen_at)
            SELECT anime_id, default_fansub_group_id, updated_at, updated_at
            FROM my_anime WHERE default_fansub_group_id IS NOT NULL;

            INSERT OR IGNORE INTO anime_fansub_group
              (anime_id, fansub_group_id, first_seen_at, last_seen_at)
            SELECT anime_id, fansub_group_id, updated_at, updated_at
            FROM episode_preference WHERE fansub_group_id IS NOT NULL;

            INSERT OR IGNORE INTO anime_fansub_group
              (anime_id, fansub_group_id, first_seen_at, last_seen_at)
            SELECT anime_id, fansub_group_id, created_at, updated_at
            FROM download_task
            WHERE anime_id IS NOT NULL AND fansub_group_id IS NOT NULL
              AND fansub_group_id IN (SELECT id FROM fansub_group);
            "#,
        )?;
    }

    if current_schema_version < 8 {
        transaction.execute_batch(
            r#"
            UPDATE my_anime SET preferred_subtitle_languages_json =
              CASE preferred_subtitle WHEN 'chs' THEN '["chs"]' WHEN 'cht' THEN '["cht"]'
                WHEN 'jpn' THEN '["jpn"]' WHEN 'eng' THEN '["eng"]'
                WHEN 'multi' THEN '["chs","cht"]' ELSE '[]' END
            WHERE preferred_subtitle_languages_json = '[]' AND preferred_subtitle IS NOT NULL;

            UPDATE my_anime_rss_subscription SET preferred_subtitle_languages_json =
              CASE preferred_subtitle WHEN 'chs' THEN '["chs"]' WHEN 'cht' THEN '["cht"]'
                WHEN 'jpn' THEN '["jpn"]' WHEN 'eng' THEN '["eng"]'
                WHEN 'multi' THEN '["chs","cht"]' ELSE '[]' END
            WHERE preferred_subtitle_languages_json = '[]' AND preferred_subtitle IS NOT NULL;

            UPDATE release SET subtitle_languages_json =
              CASE subtitle WHEN 'chs' THEN '["chs"]' WHEN 'cht' THEN '["cht"]'
                WHEN 'jpn' THEN '["jpn"]' WHEN 'eng' THEN '["eng"]'
                WHEN 'multi' THEN '["chs","cht"]' ELSE '[]' END
            WHERE subtitle_languages_json = '[]' AND subtitle IS NOT NULL;
            "#,
        )?;
    }

    if current_schema_version < 10 {
        transaction.execute_batch(
            r#"
            UPDATE release_source SET use_proxy = 1, request_interval_ms = 1500
            WHERE id IN ('mikan', 'dmhy', 'mikan-site', 'anibt', 'acgnx');
            UPDATE release_source SET use_proxy = 0, request_interval_ms = 250
            WHERE id = 'prowlarr';
            "#,
        )?;
    }

    if current_schema_version < 14 {
        transaction.execute_batch(
            r#"
            INSERT OR IGNORE INTO request_circuit_state
              (circuit_key, circuit_group, request_host, last_request_at, failure_count, backoff_until, updated_at)
            SELECT 'release-source:' || source_id, 'release-source', request_host, last_request_at,
              request_failure_count, backoff_until, updated_at
            FROM release_source_sync_state
            WHERE request_host IS NOT NULL OR last_request_at IS NOT NULL
              OR request_failure_count > 0 OR backoff_until IS NOT NULL;

            UPDATE release_source_sync_state SET request_host = NULL, last_request_at = NULL,
              request_failure_count = 0, backoff_until = NULL;
            "#,
        )?;
    }

    if current_schema_version < 15 {
        transaction.execute("DELETE FROM release WHERE anime_id IS NOT NULL", [])?;
        transaction.execute("DELETE FROM release_search_cache", [])?;
    }
    Ok(())
}

/// 执行应用数据版本 22 的默认下载源清理。
fn migrate_app_data(
    transaction: &Transaction<'_>,
    current_app_data_version: u32,
) -> Result<(), StorageError> {
    if current_app_data_version < 22 {
        transaction.execute("DELETE FROM release_source WHERE id = 'prowlarr'", [])?;
        transaction.execute(
            "DELETE FROM request_circuit_state WHERE circuit_key = 'release-source:prowlarr'",
            [],
        )?;
        transaction.execute("DELETE FROM release_search_cache", [])?;
        transaction.execute(
            "UPDATE release_source SET use_proxy = 0, updated_at = ?1 WHERE id = 'anibt'",
            [now_iso()],
        )?;
    }
    Ok(())
}

/// 空库首次启动时写入设置、首页空状态和默认下载源。
fn seed_database(transaction: &Transaction<'_>, seed: &StorageSeed) -> Result<(), StorageError> {
    let timestamp = now_iso();
    transaction.execute(
        "INSERT INTO app_settings (key, value_json, updated_at) VALUES ('settings', ?1, ?2) \
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
        params![seed.settings.to_string(), &timestamp],
    )?;
    transaction.execute(
        "INSERT INTO app_state (key, value_json, updated_at) VALUES ('dashboard', ?1, ?2) \
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
        params![seed.dashboard.to_string(), &timestamp],
    )?;
    for source in &seed.release_sources {
        seed_release_source(transaction, source, &timestamp)?;
    }
    Ok(())
}

/// 写入一条默认下载源，保留旧库中已有的用户配置。
fn seed_release_source(
    transaction: &Transaction<'_>,
    source: &ReleaseSourceSeed,
    timestamp: &str,
) -> Result<(), StorageError> {
    let tags_json = serde_json::to_string(&source.tags).expect("string vector must serialize");
    transaction.execute(
        "INSERT OR IGNORE INTO release_source ( \
           id, name, kind, enabled, use_proxy, request_interval_ms, base_url, api_key, rss_url, \
           tags_json, created_at, updated_at \
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)",
        params![
            &source.id,
            &source.name,
            &source.kind,
            if source.enabled { 1_i64 } else { 0_i64 },
            if source.use_proxy { 1_i64 } else { 0_i64 },
            source.request_interval_ms,
            source.base_url.as_deref(),
            source.api_key.as_deref(),
            source.rss_url.as_deref(),
            tags_json,
            timestamp,
        ],
    )?;
    Ok(())
}

/// 幂等追加旧数据库缺失的列。
fn ensure_column(
    transaction: &Transaction<'_>,
    table: &str,
    column: &str,
    definition: &str,
) -> Result<(), StorageError> {
    let mut statement = transaction.prepare(&format!("PRAGMA table_info({table})"))?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<Result<Vec<_>, _>>()?;
    if !columns.iter().any(|existing| existing == column) {
        transaction.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {definition};"))?;
    }
    Ok(())
}

/// 判断指定表是否存在。
fn table_exists(connection: &Connection, table: &str) -> Result<bool, StorageError> {
    let count: i64 = connection.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
        [table],
        |row| row.get(0),
    )?;
    Ok(count > 0)
}

/// 从 app_meta 读取并严格解析版本号。
fn read_version(connection: &Connection, key: &'static str) -> Result<Option<u32>, StorageError> {
    let value = connection
        .query_row("SELECT value FROM app_meta WHERE key = ?1", [key], |row| {
            row.get::<_, String>(0)
        })
        .optional()?;
    value
        .map(|raw| {
            raw.parse::<u32>()
                .map_err(|_| StorageError::InvalidVersionMetadata { key, value: raw })
        })
        .transpose()
}

/// 原子写入一项版本元数据。
fn set_meta(transaction: &Transaction<'_>, key: &str, value: &str) -> Result<(), StorageError> {
    transaction.execute(
        "INSERT INTO app_meta (key, value, updated_at) VALUES (?1, ?2, ?3) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        params![key, value, now_iso()],
    )?;
    Ok(())
}
