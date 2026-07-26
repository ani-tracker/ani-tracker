use std::path::PathBuf;

use ani_repository::RepositoryError;

/// SQLite 数据层启动和迁移错误。
#[derive(Debug, thiserror::Error)]
pub enum StorageError {
    #[error("宿主路径解析失败（{action}）：{detail}")]
    HostPath {
        action: &'static str,
        detail: String,
    },
    #[error("数据库文件操作失败（{operation}）：{path}：{source}")]
    FileOperation {
        operation: &'static str,
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("SQLite 操作失败：{0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("数据库 JSON 字段解析失败（{context}）：{source}")]
    JsonData {
        context: &'static str,
        #[source]
        source: serde_json::Error,
    },
    #[error("数据库字段值不受支持（{field}={value}）")]
    InvalidDomainValue { field: &'static str, value: String },
    #[error("业务输入无效（{field}）：{message}")]
    InvalidInput {
        field: &'static str,
        message: String,
    },
    #[error("安全存储操作失败（{action}, {key}）：{detail}")]
    SecureStoreOperation {
        action: &'static str,
        key: String,
        detail: String,
    },
    #[error("{entity}不存在：{id}")]
    RecordNotFound { entity: &'static str, id: String },
    #[error("数据库不是有效的 SQLite 文件：{path}：{detail}")]
    CorruptDatabase { path: PathBuf, detail: String },
    #[error("数据库结构版本 {actual} 高于当前支持版本 {supported}")]
    UnsupportedSchemaVersion { actual: u32, supported: u32 },
    #[error("应用数据版本 {actual} 高于当前支持版本 {supported}")]
    UnsupportedAppDataVersion { actual: u32, supported: u32 },
    #[error("数据库元数据 {key} 不是有效版本号：{value}")]
    InvalidVersionMetadata { key: &'static str, value: String },
    #[error("数据库迁移失败，已恢复迁移前备份：{source}")]
    MigrationRolledBack {
        #[source]
        source: Box<StorageError>,
    },
    #[error("数据库迁移失败且恢复备份失败；迁移错误：{migration}; 恢复错误：{restore}")]
    MigrationRestoreFailed {
        migration: Box<StorageError>,
        restore: Box<StorageError>,
    },
    #[error("用户数据恢复失败，已恢复操作前快照：{source}")]
    DataRestoreRolledBack {
        #[source]
        source: Box<StorageError>,
    },
    #[error("用户数据恢复失败且回滚快照恢复失败；恢复错误：{restore}; 回滚错误：{rollback}")]
    DataRestoreFailed {
        restore: Box<StorageError>,
        rollback: Box<StorageError>,
    },
}

/// 平台 SecureStore 适配器统一返回的稳定错误。
#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct SecureStoreError(pub String);

impl StorageError {
    /// 创建带操作名和路径的文件系统错误。
    pub(crate) fn file(
        operation: &'static str,
        path: impl Into<PathBuf>,
        source: std::io::Error,
    ) -> Self {
        Self::FileOperation {
            operation,
            path: path.into(),
            source,
        }
    }
}

impl From<StorageError> for RepositoryError {
    /// 隔离 SQLite 驱动细节，只向业务层暴露稳定错误分类。
    fn from(error: StorageError) -> Self {
        match error {
            StorageError::InvalidInput { field, message } => Self::InvalidInput {
                field: field.to_owned(),
                message,
            },
            StorageError::RecordNotFound { entity, id } => Self::RecordNotFound {
                entity: entity.to_owned(),
                id,
            },
            error => Self::Backend {
                backend: "sqlite".to_owned(),
                message: error.to_string(),
            },
        }
    }
}
