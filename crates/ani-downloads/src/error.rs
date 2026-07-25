use ani_domain::TorrentEngineKind;
use ani_repository::RepositoryError;

/// 具体 torrent/qBittorrent 适配器的稳定错误模型。
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum DownloadEngineError {
    #[error("下载引擎不可用：{0}")]
    Unavailable(String),
    #[error("下载引擎通信失败：{0}")]
    Transport(String),
    #[error("下载引擎协议错误：{0}")]
    Protocol(String),
    #[error("下载引擎任务不存在：{0}")]
    TaskNotFound(String),
    #[error("下载引擎拒绝参数：{0}")]
    InvalidInput(String),
}

/// 下载任务服务对 Tauri commands 暴露的稳定错误模型。
#[derive(Debug, thiserror::Error)]
pub enum DownloadServiceError {
    #[error("下载输入无效（{field}）：{message}")]
    InvalidInput {
        field: &'static str,
        message: String,
    },
    #[error("下载任务不存在：{0}")]
    TaskNotFound(String),
    #[error("下载引擎未注册：{0:?}")]
    EngineNotRegistered(TorrentEngineKind),
    #[error("下载引擎重复注册：{0:?}")]
    DuplicateEngine(TorrentEngineKind),
    #[error("下载引擎操作失败（{engine:?}/{operation}）：{source}")]
    Engine {
        engine: TorrentEngineKind,
        operation: &'static str,
        source: DownloadEngineError,
    },
    #[error(transparent)]
    Repository(#[from] RepositoryError),
}

impl DownloadServiceError {
    /// 为具体引擎错误补充引擎类型和操作名。
    pub(crate) fn engine(
        engine: TorrentEngineKind,
        operation: &'static str,
        source: DownloadEngineError,
    ) -> Self {
        Self::Engine {
            engine,
            operation,
            source,
        }
    }

    /// 创建统一的下载输入错误。
    pub(crate) fn invalid(field: &'static str, message: impl Into<String>) -> Self {
        Self::InvalidInput {
            field,
            message: message.into(),
        }
    }
}
