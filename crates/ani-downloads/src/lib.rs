mod engine;
mod error;
mod registry;
mod service;

pub use engine::{
    AddTorrentOptions, DownloadEngine, DownloadEngineConfig, DownloadEngineStatus, DownloadSource,
    SeedingLimits,
};
pub use error::{DownloadEngineError, DownloadServiceError};
pub use registry::DownloadEngineRegistry;
pub use service::{
    DownloadAddRequest, DownloadRefreshFailure, DownloadRefreshResult, DownloadTaskContext,
    DownloadTaskService, DownloadTaskStore,
};

#[cfg(test)]
mod tests;
