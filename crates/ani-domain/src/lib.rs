use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 追番状态，与 TypeScript `AnimeStatus` 契约保持一致。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AnimeStatus {
    Watching,
    Planned,
    Completed,
    Paused,
    Dropped,
}

/// 单集生命周期状态。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EpisodeStatus {
    Upcoming,
    Aired,
    Matched,
    Downloading,
    Downloaded,
    Watched,
}

/// 下载任务生命周期状态。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DownloadStatus {
    Queued,
    FetchingMetadata,
    Downloading,
    Stalled,
    Paused,
    Checking,
    Moving,
    Completed,
    Seeding,
    Error,
    MissingFiles,
}

impl DownloadStatus {
    /// 判断状态是否仍处于下载活动生命周期。
    pub fn is_active(&self) -> bool {
        matches!(
            self,
            Self::Queued
                | Self::FetchingMetadata
                | Self::Downloading
                | Self::Stalled
                | Self::Paused
                | Self::Checking
                | Self::Moving
        )
    }

    /// 判断状态是否明确表示下载数据已完成。
    pub fn is_completed(&self) -> bool {
        matches!(self, Self::Completed | Self::Seeding)
    }
}

/// 下载任务使用的引擎类型。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TorrentEngineKind {
    Embedded,
    Qbittorrent,
}

/// 番剧别名语言，与现有目录数据保持一致。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AnimeAliasLanguage {
    Zh,
    Ja,
    En,
    Romaji,
    Custom,
}

/// 番剧目录别名。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnimeAlias {
    pub id: String,
    pub anime_id: String,
    pub alias: String,
    pub language: AnimeAliasLanguage,
    pub priority: i64,
}

/// 番剧评分摘要。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnimeRating {
    pub score: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub count: Option<i64>,
    pub source: String,
}

/// 首页和追番列表需要的完整番剧目录记录。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Anime {
    pub id: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub original_title: Option<String>,
    pub aliases: Vec<AnimeAlias>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub premiere_date: Option<String>,
    pub premiere_year: i64,
    pub premiere_month: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub season: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cover_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rating: Option<AnimeRating>,
    pub external_ids: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<Value>,
}

/// 单部追番的 RSS 订阅设置。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnimeRssSubscription {
    pub id: String,
    pub my_anime_id: String,
    pub name: String,
    pub url: String,
    pub enabled: bool,
    #[serde(default)]
    pub preferred_subtitle_languages: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preferred_subtitle: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refresh_interval_minutes: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_fetched_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// 我的追番只读记录。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MyAnime {
    pub id: String,
    pub anime: Anime,
    pub status: AnimeStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_fansub_group_id: Option<String>,
    pub auto_download: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub download_dir: Option<String>,
    #[serde(default)]
    pub rss_subscriptions: Vec<AnimeRssSubscription>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preferred_resolution: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preferred_codec: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preferred_bit_depth: Option<i64>,
    #[serde(default)]
    pub preferred_subtitle_languages: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preferred_subtitle: Option<String>,
    pub added_at: String,
    pub updated_at: String,
}

/// 番剧单集记录。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Episode {
    pub id: String,
    pub anime_id: String,
    pub episode_no: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub air_time: Option<String>,
    pub status: EpisodeStatus,
}

/// 下载任务中的单个文件。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TorrentFile {
    pub id: String,
    pub index: i64,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub episode_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub episode_no: Option<f64>,
    pub size: i64,
    pub progress: f64,
    pub priority: i64,
    pub selected: bool,
}

/// 首页使用的下载任务快照。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadTask {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub release_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub anime_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub episode_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub anime_title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub episode_no: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fansub_group_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fansub_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolution: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub declared_video_codec: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub normalized_video_codec: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bit_depth: Option<i64>,
    #[serde(default)]
    pub subtitle_languages: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subtitle: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub correlation_tag: Option<String>,
    pub engine: TorrentEngineKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub torrent_hash: Option<String>,
    pub name: String,
    pub status: DownloadStatus,
    pub progress: f64,
    pub download_speed: i64,
    pub upload_speed: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub eta_seconds: Option<i64>,
    pub save_path: String,
    pub files: Vec<TorrentFile>,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<String>,
}

impl DownloadTask {
    /// 判断任务是否已完成，并兼容引擎状态延迟和文件级进度。
    pub fn is_completed(&self) -> bool {
        if matches!(
            &self.status,
            DownloadStatus::Error | DownloadStatus::MissingFiles
        ) {
            return false;
        }
        if self.status.is_completed() {
            return true;
        }

        let selected_files = self
            .files
            .iter()
            .filter(|file| file.selected)
            .collect::<Vec<_>>();
        if !selected_files.is_empty() {
            return selected_files.iter().all(|file| file.progress >= 1.0);
        }
        self.progress >= 1.0
    }

    /// 判断任务是否应计入首页活动下载。
    pub fn is_active(&self) -> bool {
        self.status.is_active() && !self.is_completed()
    }
}

/// 首页最近完成区域使用的媒体文件。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaFile {
    pub id: String,
    pub anime_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub episode_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub download_task_id: Option<String>,
    pub file_path: String,
    pub file_name: String,
    pub size: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub container: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub declared_video_codec: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detected_video_codec: Option<String>,
    pub normalized_video_codec: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolution: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bit_depth: Option<i64>,
    pub audio_codecs: Vec<String>,
    pub subtitle_tracks: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_seconds: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub downloaded_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub probed_at: Option<String>,
}

/// 应用内通知类别。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NotificationKind {
    Automation,
    Download,
    Reminder,
    System,
}

/// 应用内通知严重程度。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NotificationSeverity {
    Info,
    Success,
    Warning,
    Error,
}

/// 提醒中心使用的通知记录。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationRecord {
    pub id: String,
    pub kind: NotificationKind,
    pub title: String,
    pub body: String,
    pub severity: NotificationSeverity,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub anime_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub episode_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub download_task_id: Option<String>,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub read_at: Option<String>,
}

/// 首页每日提醒条目。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DailyReminderItem {
    pub id: String,
    pub anime_id: String,
    pub anime_title: String,
    pub episode_id: String,
    pub episode_no: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub air_time: Option<String>,
    pub status: EpisodeStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fansub_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub download_task_id: Option<String>,
}

/// 首页每日提醒汇总。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DailyReminderSummary {
    pub date: String,
    pub total: usize,
    pub upcoming: usize,
    pub aired: usize,
    pub downloading: usize,
    pub downloaded: usize,
    pub items: Vec<DailyReminderItem>,
}

/// 首页精简单集条目。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EpisodeSummary {
    pub id: String,
    pub anime_title: String,
    pub episode_no: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub air_time: Option<String>,
    pub status: EpisodeStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fansub_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub download_task_id: Option<String>,
}

/// 首页需要人工处理的事项。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingAction {
    pub id: String,
    pub title: String,
    pub description: String,
    pub severity: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub anime_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub episode_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub episode_no: Option<f64>,
}

/// 首页周播出计划中的一天。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WeeklyScheduleDay {
    pub day: String,
    pub items: Vec<EpisodeSummary>,
}

/// 首页下载源健康状态。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceHealth {
    pub source_id: String,
    pub name: String,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_checked_at: Option<String>,
}

/// 首页完整聚合数据。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DashboardData {
    pub daily_reminder: DailyReminderSummary,
    pub today_episodes: Vec<EpisodeSummary>,
    pub pending_actions: Vec<PendingAction>,
    pub active_downloads: Vec<DownloadTask>,
    pub recent_completed: Vec<MediaFile>,
    pub weekly_schedule: Vec<WeeklyScheduleDay>,
    pub source_health: Vec<SourceHealth>,
}

/// 设置保持版本化 JSON 契约，由平台默认值补齐新增字段。
pub type AppSettings = Value;

#[cfg(test)]
mod tests {
    use serde::Deserialize;

    use super::{AnimeStatus, DashboardData, MyAnime, NotificationKind, NotificationRecord};

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct ContractFixture<T> {
        schema_version: u32,
        kind: String,
        payload: T,
    }

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct P2ReadModelFixture {
        notification: NotificationRecord,
        my_anime: MyAnime,
        dashboard: DashboardData,
    }

    /// 验证领域枚举沿用前端现有的 JSON 字面量。
    #[test]
    fn serializes_contract_enums() {
        assert_eq!(
            serde_json::to_string(&AnimeStatus::Watching).expect("serialize anime status"),
            "\"watching\""
        );
        assert_eq!(
            serde_json::to_string(&NotificationKind::System).expect("serialize notification kind"),
            "\"system\""
        );
    }

    /// 验证 Rust 能严格解码与 TypeScript 共用的 P2 只读模型金样。
    #[test]
    fn decodes_p2_read_model_fixture() {
        let fixture = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../fixtures/contracts/p2-read-model.v1.json"
        ));
        let decoded: ContractFixture<P2ReadModelFixture> =
            serde_json::from_str(fixture).expect("p2 read model fixture must decode");

        assert_eq!(decoded.schema_version, 1);
        assert_eq!(decoded.kind, "p2-read-model");
        assert_eq!(
            decoded.payload.notification.kind,
            NotificationKind::Download
        );
        assert_eq!(decoded.payload.my_anime.anime.id, "anime-contract-1");
        assert_eq!(decoded.payload.dashboard.daily_reminder.total, 0);
    }
}
