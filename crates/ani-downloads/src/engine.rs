use std::path::PathBuf;

use ani_domain::{DownloadTask, TorrentEngineKind, TorrentFile};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use crate::DownloadEngineError;

/// 下载引擎运行状态，用于健康检查和配置确认。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadEngineStatus {
    pub version: String,
    pub task_count: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub listen_port: Option<u16>,
    #[serde(default)]
    pub network_policy_blocked: bool,
}

/// 内置下载引擎的做种停止策略。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeedingLimits {
    pub enabled: bool,
    pub ratio_enabled: bool,
    pub ratio_limit: f64,
    pub time_enabled: bool,
    pub time_limit_minutes: u32,
}

impl Default for SeedingLimits {
    /// 创建关闭做种限制的默认策略。
    fn default() -> Self {
        Self {
            enabled: false,
            ratio_enabled: false,
            ratio_limit: 1.0,
            time_enabled: false,
            time_limit_minutes: 120,
        }
    }
}

/// 可由设置页实时下发的下载引擎配置。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadEngineConfig {
    pub listen_port: u16,
    pub dht_enabled: bool,
    pub upnp_enabled: bool,
    pub max_active_downloads: u32,
    pub max_download_speed: u32,
    pub max_upload_speed: u32,
    #[serde(default = "allow_metered_downloads_by_default")]
    pub allow_metered_downloads: bool,
    #[serde(default)]
    pub seeding_limits: SeedingLimits,
}

/// 兼容旧配置和桌面调用方，未声明时保持允许计费网络。
fn allow_metered_downloads_by_default() -> bool {
    true
}

/// 添加种子时传给具体引擎的通用选项。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddTorrentOptions {
    pub save_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selected_file_indexes: Option<Vec<i64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub correlation_tag: Option<String>,
    #[serde(default)]
    pub paused: bool,
}

/// 统一任务服务可接受的本地种子来源。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DownloadSource {
    Magnet(String),
    TorrentFile(PathBuf),
}

/// 桌面 sidecar、移动原生核心和 qBittorrent 共用的下载引擎端口。
#[async_trait]
pub trait DownloadEngine: Send + Sync {
    /// 返回该适配器负责的稳定引擎类型。
    fn kind(&self) -> TorrentEngineKind;

    /// 读取引擎健康状态和版本。
    async fn status(&self) -> Result<DownloadEngineStatus, DownloadEngineError>;

    /// 更新引擎运行配置并返回生效后的状态。
    async fn configure(
        &self,
        config: &DownloadEngineConfig,
    ) -> Result<DownloadEngineStatus, DownloadEngineError>;

    /// 从磁链添加任务并返回首个真实任务快照。
    async fn add_magnet(
        &self,
        url: &str,
        options: &AddTorrentOptions,
    ) -> Result<DownloadTask, DownloadEngineError>;

    /// 从本地 torrent 文件添加任务并返回首个真实任务快照。
    async fn add_torrent_file(
        &self,
        file_path: &std::path::Path,
        options: &AddTorrentOptions,
    ) -> Result<DownloadTask, DownloadEngineError>;

    /// 读取引擎管理的全部任务。
    async fn list_tasks(&self) -> Result<Vec<DownloadTask>, DownloadEngineError>;

    /// 读取指定任务快照。
    async fn get_task(&self, task_id: &str) -> Result<DownloadTask, DownloadEngineError>;

    /// 读取指定任务文件列表。
    async fn get_files(&self, task_id: &str) -> Result<Vec<TorrentFile>, DownloadEngineError>;

    /// 更新一组文件的下载优先级。
    async fn set_file_priority(
        &self,
        task_id: &str,
        file_indexes: &[i64],
        priority: i64,
    ) -> Result<(), DownloadEngineError>;

    /// 暂停指定任务并请求恢复数据落盘。
    async fn pause(&self, task_id: &str) -> Result<(), DownloadEngineError>;

    /// 恢复指定任务。
    async fn resume(&self, task_id: &str) -> Result<(), DownloadEngineError>;

    /// 移除任务，并按参数决定是否删除下载文件。
    async fn remove(&self, task_id: &str, delete_files: bool) -> Result<(), DownloadEngineError>;

    /// 优雅关闭引擎并等待恢复数据落盘。
    async fn shutdown(&self) -> Result<(), DownloadEngineError>;
}
