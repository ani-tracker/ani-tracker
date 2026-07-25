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
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
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
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub rss_subscriptions: Vec<AnimeRssSubscription>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preferred_resolution: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preferred_codec: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preferred_bit_depth: Option<i64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub preferred_subtitle_languages: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preferred_subtitle: Option<String>,
    pub added_at: String,
    pub updated_at: String,
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

#[cfg(test)]
mod tests {
    use super::{AnimeStatus, NotificationKind};

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
}
