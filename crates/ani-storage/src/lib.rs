mod error;
mod migration;
mod repository;

use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};

use chrono::{SecondsFormat, Utc};
use log::{error, info, warn};
use rusqlite::{backup::Backup, Connection, OpenFlags};
use serde_json::Value;

pub use error::StorageError;
use migration::{initialize_database, read_database_versions};
pub use repository::AppRepository;

/// 当前与 Electron 共用的 SQLite 结构版本。
pub const SQLITE_SCHEMA_VERSION: u32 = 18;
/// 当前与 TypeScript 共用的应用数据版本。
pub const APP_DATA_VERSION: u32 = 22;

/// 首次启动写入的最小应用数据。
#[derive(Debug, Clone)]
pub struct StorageSeed {
    pub settings: Value,
    pub dashboard: Value,
    pub release_sources: Vec<ReleaseSourceSeed>,
}

impl Default for StorageSeed {
    /// 创建不含演示业务数据的空种子。
    fn default() -> Self {
        Self {
            settings: Value::Object(Default::default()),
            dashboard: Value::Object(Default::default()),
            release_sources: Vec::new(),
        }
    }
}

/// 首次启动写入的下载源配置。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReleaseSourceSeed {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub enabled: bool,
    pub use_proxy: bool,
    pub request_interval_ms: i64,
    pub base_url: Option<String>,
    pub api_key: Option<String>,
    pub rss_url: Option<String>,
    pub tags: Vec<String>,
}

/// SQLite 启动参数，由宿主提供平台路径和默认数据。
#[derive(Debug, Clone)]
pub struct StorageOptions {
    pub database_path: PathBuf,
    pub backup_directory: PathBuf,
    pub legacy_database_paths: Vec<PathBuf>,
    pub seed: StorageSeed,
}

/// 本次 SQLite 启动执行的复制、迁移和备份结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StorageOpenReport {
    pub created: bool,
    pub copied_from: Option<PathBuf>,
    pub backup_path: Option<PathBuf>,
    pub schema_version: u32,
    pub app_data_version: u32,
}

/// 持有单写者 SQLite 连接。
pub struct Storage {
    connection: Connection,
    database_path: PathBuf,
    report: StorageOpenReport,
}

impl Storage {
    /// 发现旧 Electron 数据库，完成一致性复制、迁移、校验和失败恢复。
    pub fn open(options: StorageOptions) -> Result<Self, StorageError> {
        ensure_parent_directory(&options.database_path)?;
        ensure_directory(&options.backup_directory)?;

        let copied_from =
            copy_legacy_database_if_needed(&options.database_path, &options.legacy_database_paths)?;
        let existed_before = options.database_path.exists();
        let created = copied_from.is_none() && !existed_before;
        let mut connection = open_connection(&options.database_path)?;
        verify_integrity(&connection, &options.database_path)?;

        let versions = read_database_versions(&connection)?;
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

        let needs_migration = versions.schema_version != Some(SQLITE_SCHEMA_VERSION)
            || versions.app_data_version != Some(APP_DATA_VERSION);
        let backup_path = if existed_before && (needs_migration || copied_from.is_some()) {
            Some(create_migration_backup(
                &connection,
                &options.database_path,
                &options.backup_directory,
                versions.schema_version,
                versions.app_data_version,
            )?)
        } else {
            None
        };

        let initialization = initialize_database(&mut connection, &options.seed)
            .and_then(|_| configure_connection(&connection))
            .and_then(|_| verify_integrity(&connection, &options.database_path));
        if let Err(migration_error) = initialization {
            drop(connection);
            if let Some(backup_path) = backup_path.as_deref() {
                return match restore_database(&options.database_path, backup_path) {
                    Ok(()) => {
                        error!(
                            "SQLite 迁移失败，已恢复备份：database={}, backup={}, error={}",
                            options.database_path.display(),
                            backup_path.display(),
                            migration_error
                        );
                        Err(StorageError::MigrationRolledBack {
                            source: Box::new(migration_error),
                        })
                    }
                    Err(restore_error) => Err(StorageError::MigrationRestoreFailed {
                        migration: Box::new(migration_error),
                        restore: Box::new(restore_error),
                    }),
                };
            }

            if created {
                remove_database_files(&options.database_path);
            }
            return Err(migration_error);
        }

        let report = StorageOpenReport {
            created,
            copied_from,
            backup_path,
            schema_version: SQLITE_SCHEMA_VERSION,
            app_data_version: APP_DATA_VERSION,
        };
        info!(
            "SQLite 数据层就绪：database={}, created={}, copied_from={:?}, backup={:?}",
            options.database_path.display(),
            report.created,
            report.copied_from,
            report.backup_path
        );

        Ok(Self {
            connection,
            database_path: options.database_path,
            report,
        })
    }

    /// 返回本次启动的数据库迁移报告。
    pub fn report(&self) -> &StorageOpenReport {
        &self.report
    }

    /// 返回当前数据库文件路径。
    pub fn database_path(&self) -> &Path {
        &self.database_path
    }

    /// 执行完整性与外键一致性检查。
    pub fn verify(&self) -> Result<(), StorageError> {
        verify_integrity(&self.connection, &self.database_path)
    }

    /// 创建仅在当前连接生命周期内有效的业务 Repository。
    pub fn repository(&self) -> AppRepository<'_> {
        AppRepository::new(&self.connection)
    }
}

impl Drop for Storage {
    /// 关闭前尽力将 WAL 内容写回主数据库。
    fn drop(&mut self) {
        if let Err(checkpoint_error) = self
            .connection
            .execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
        {
            warn!(
                "SQLite WAL 收尾失败：database={}, error={}",
                self.database_path.display(),
                checkpoint_error
            );
        }
    }
}

/// 打开现有或新建 SQLite 连接。
fn open_connection(path: &Path) -> Result<Connection, StorageError> {
    Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_CREATE
            | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(StorageError::from)
}

/// 配置单写者 SQLite 连接参数。
fn configure_connection(connection: &Connection) -> Result<(), StorageError> {
    connection.execute_batch(
        "PRAGMA journal_mode = WAL;\
         PRAGMA foreign_keys = ON;\
         PRAGMA busy_timeout = 5000;",
    )?;
    Ok(())
}

/// 校验数据库页结构与全部外键引用。
fn verify_integrity(connection: &Connection, path: &Path) -> Result<(), StorageError> {
    let integrity: String = connection
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .map_err(|source| StorageError::CorruptDatabase {
            path: path.to_path_buf(),
            detail: source.to_string(),
        })?;
    if integrity != "ok" {
        return Err(StorageError::CorruptDatabase {
            path: path.to_path_buf(),
            detail: integrity,
        });
    }

    let foreign_key_error_count: i64 =
        connection.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
            row.get(0)
        })?;
    if foreign_key_error_count > 0 {
        return Err(StorageError::CorruptDatabase {
            path: path.to_path_buf(),
            detail: format!("存在 {foreign_key_error_count} 条无效外键引用"),
        });
    }
    Ok(())
}

/// 目标库不存在时，从第一个有效旧库创建一致性副本。
fn copy_legacy_database_if_needed(
    target: &Path,
    candidates: &[PathBuf],
) -> Result<Option<PathBuf>, StorageError> {
    if target.exists() {
        return Ok(None);
    }

    let source = candidates
        .iter()
        .find(|candidate| candidate.as_path() != target && candidate.is_file());
    let Some(source) = source else {
        return Ok(None);
    };

    let source_connection = Connection::open_with_flags(
        source,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    verify_integrity(&source_connection, source)?;
    snapshot_database(&source_connection, target)?;
    info!(
        "已复制 Electron SQLite 数据库：source={}, target={}",
        source.display(),
        target.display()
    );
    Ok(Some(source.clone()))
}

/// 使用 SQLite 在线备份 API 创建包含 WAL 内容的一致性快照。
fn snapshot_database(connection: &Connection, target: &Path) -> Result<(), StorageError> {
    if target.exists() {
        fs::remove_file(target)
            .map_err(|source| StorageError::file("删除旧快照", target, source))?;
    }
    let mut destination = Connection::open(target)?;
    let backup = Backup::new(connection, &mut destination)?;
    backup.run_to_completion(128, std::time::Duration::from_millis(10), None)?;
    drop(backup);
    destination
        .close()
        .map_err(|(_, error)| StorageError::Sqlite(error))?;
    Ok(())
}

/// 在迁移前生成带源版本号的数据库备份。
fn create_migration_backup(
    connection: &Connection,
    database_path: &Path,
    backup_directory: &Path,
    schema_version: Option<u32>,
    app_data_version: Option<u32>,
) -> Result<PathBuf, StorageError> {
    let stem = database_path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("ani-tracker");
    let timestamp = Utc::now().format("%Y%m%dT%H%M%S%.3fZ");
    let base_name = format!(
        "{stem}.schema-{}.app-{}.migration-{timestamp}.sqlite",
        schema_version.unwrap_or(0),
        app_data_version.unwrap_or(0)
    );
    let backup_path = unique_path(backup_directory, &base_name);
    snapshot_database(connection, &backup_path)?;
    info!(
        "SQLite 迁移备份完成：database={}, backup={}",
        database_path.display(),
        backup_path.display()
    );
    Ok(backup_path)
}

/// 将迁移前快照恢复为活动数据库。
fn restore_database(database_path: &Path, backup_path: &Path) -> Result<(), StorageError> {
    remove_sidecar_file(database_path, "-wal")?;
    remove_sidecar_file(database_path, "-shm")?;
    fs::copy(backup_path, database_path)
        .map_err(|source| StorageError::file("恢复数据库备份", database_path, source))?;
    Ok(())
}

/// 创建目录并保留具体失败路径。
fn ensure_directory(path: &Path) -> Result<(), StorageError> {
    fs::create_dir_all(path).map_err(|source| StorageError::file("创建目录", path, source))
}

/// 创建数据库文件的父目录。
fn ensure_parent_directory(path: &Path) -> Result<(), StorageError> {
    match path.parent() {
        Some(parent) => ensure_directory(parent),
        None => Ok(()),
    }
}

/// 为同一毫秒内的多个备份选择不冲突路径。
fn unique_path(directory: &Path, file_name: &str) -> PathBuf {
    let initial = directory.join(file_name);
    if !initial.exists() {
        return initial;
    }

    for suffix in 1..=u32::MAX {
        let candidate = directory.join(format!("{file_name}.{suffix}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    unreachable!("u32 backup suffix space exhausted")
}

/// 删除数据库失败初始化产生的精确目标文件。
fn remove_database_files(database_path: &Path) {
    for path in [
        database_path.to_path_buf(),
        sidecar_path(database_path, "-wal"),
        sidecar_path(database_path, "-shm"),
    ] {
        if let Err(remove_error) = fs::remove_file(&path) {
            if remove_error.kind() != std::io::ErrorKind::NotFound {
                warn!(
                    "清理失败的 SQLite 文件失败：path={}, error={}",
                    path.display(),
                    remove_error
                );
            }
        }
    }
}

/// 删除指定 SQLite sidecar 文件。
fn remove_sidecar_file(database_path: &Path, suffix: &str) -> Result<(), StorageError> {
    let path = sidecar_path(database_path, suffix);
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(source) => Err(StorageError::file("删除 SQLite sidecar", path, source)),
    }
}

/// 生成 SQLite WAL 或 SHM 文件路径。
fn sidecar_path(database_path: &Path, suffix: &str) -> PathBuf {
    let mut path = OsString::from(database_path.as_os_str());
    path.push(suffix);
    PathBuf::from(path)
}

/// 返回当前 UTC 时间，供数据库元数据和 seed 共用。
pub(crate) fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests;
