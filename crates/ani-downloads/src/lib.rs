mod engine;
mod error;
mod qbittorrent;
mod registry;
mod service;
mod torrent_core;

pub use engine::{
    AddTorrentOptions, DownloadEngine, DownloadEngineConfig, DownloadEngineStatus, DownloadSource,
    SeedingLimits,
};
pub use error::{DownloadEngineError, DownloadServiceError};
pub use qbittorrent::{QbittorrentConnectionConfig, QbittorrentEngine};
pub use registry::DownloadEngineRegistry;
pub use service::{
    DownloadAddRequest, DownloadRefreshResult, DownloadTaskContext, DownloadTaskService,
    DownloadTaskStore,
};
pub use torrent_core::{map_torrent_core_error, TorrentCoreEngine, TorrentCoreTransport};
#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
pub use torrent_core::{ProcessTorrentCoreTransport, TorrentCoreProcessOptions};

#[cfg(test)]
mod tests;
