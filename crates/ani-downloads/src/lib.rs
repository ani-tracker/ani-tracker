mod engine;
mod error;
mod registry;
mod service;
mod torrent_core;

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
#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
pub use torrent_core::{ProcessTorrentCoreTransport, TorrentCoreProcessOptions};
pub use torrent_core::{TorrentCoreEngine, TorrentCoreTransport};

#[cfg(test)]
mod tests;
