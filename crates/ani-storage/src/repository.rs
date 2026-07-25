use std::cmp::Ordering;
use std::collections::HashMap;

use ani_domain::{
    Anime, AnimeAlias, AnimeAliasLanguage, AnimeRating, AnimeRssSubscription, AnimeStatus,
    AppSettings, DailyReminderItem, DailyReminderSummary, DashboardData, DownloadStatus,
    DownloadTask, Episode, EpisodeStatus, EpisodeSummary, MediaFile, MyAnime, NotificationKind,
    NotificationRecord, NotificationSeverity, PendingAction, SourceHealth, TorrentEngineKind,
    TorrentFile, WeeklyScheduleDay,
};
use chrono::{DateTime, Local, Utc};
use log::{debug, warn};
use rusqlite::{Connection, OptionalExtension, Row};
use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::StorageError;

/// 提供 P2 首批设置、通知、追番和首页只读查询。
pub struct AppRepository<'connection> {
    connection: &'connection Connection,
}

impl<'connection> AppRepository<'connection> {
    /// 使用已完成迁移的 SQLite 连接创建 Repository。
    pub(crate) fn new(connection: &'connection Connection) -> Self {
        Self { connection }
    }

    /// 读取设置，并用当前平台默认值递归补齐新增字段。
    pub fn get_settings(
        &self,
        platform_defaults: &AppSettings,
    ) -> Result<AppSettings, StorageError> {
        let stored = self.read_json_state("app_settings", "settings", "应用设置")?;
        let mut merged = platform_defaults.clone();
        if let Some(stored) = stored {
            let merged_players =
                merge_player_profiles(platform_defaults.get("players"), stored.get("players"));
            merge_json(&mut merged, stored);
            if let (Some(settings), Some(players)) = (merged.as_object_mut(), merged_players) {
                settings.insert("players".to_owned(), players);
            }
        }
        Ok(merged)
    }

    /// 按创建时间倒序读取提醒中心通知。
    pub fn list_notifications(&self) -> Result<Vec<NotificationRecord>, StorageError> {
        let rows = query_all(
            self.connection,
            "SELECT * FROM notification ORDER BY created_at DESC",
            map_notification_row,
        )?;
        rows.into_iter().map(NotificationRow::into_domain).collect()
    }

    /// 统计当前未读通知数量。
    pub fn get_unread_notification_count(&self) -> Result<u64, StorageError> {
        let count = self.connection.query_row(
            "SELECT COUNT(*) FROM notification WHERE read_at IS NULL",
            [],
            |row| row.get::<_, u64>(0),
        )?;
        Ok(count)
    }

    /// 读取并按季度、标题排序我的追番。
    pub fn list_my_anime(&self) -> Result<Vec<MyAnime>, StorageError> {
        let aliases = self.list_aliases_by_anime()?;
        let anime = query_all(
            self.connection,
            "SELECT * FROM anime_catalog",
            map_anime_row,
        )?
        .into_iter()
        .map(|row| {
            let anime_aliases = aliases.get(&row.id).cloned().unwrap_or_default();
            row.into_domain(anime_aliases)
        })
        .collect::<Result<Vec<_>, _>>()?;
        let anime_by_id = anime
            .into_iter()
            .map(|item| (item.id.clone(), item))
            .collect::<HashMap<_, _>>();
        let subscriptions = self.list_rss_subscriptions_by_my_anime()?;
        let rows = query_all(self.connection, "SELECT * FROM my_anime", map_my_anime_row)?;
        let mut items = rows
            .into_iter()
            .filter_map(|row| {
                let anime = anime_by_id.get(&row.anime_id)?.clone();
                let rss_subscriptions = subscriptions.get(&row.id).cloned().unwrap_or_default();
                Some(row.into_domain(anime, rss_subscriptions))
            })
            .collect::<Result<Vec<_>, _>>()?;
        sort_my_anime(&mut items);
        Ok(items)
    }

    /// 从追番、单集、下载和媒体表生成首页实时聚合数据。
    pub fn get_dashboard(&self) -> Result<DashboardData, StorageError> {
        let stored = self
            .read_json_state("app_state", "dashboard", "首页状态")?
            .unwrap_or_else(|| Value::Object(Default::default()));
        let weekly_schedule = read_dashboard_field::<Vec<WeeklyScheduleDay>>(
            &stored,
            "weeklySchedule",
            "首页周计划",
        )?
        .unwrap_or_default();
        let mut source_health =
            read_dashboard_field::<Vec<SourceHealth>>(&stored, "sourceHealth", "首页来源健康状态")?
                .unwrap_or_default();

        let my_anime = self.list_my_anime()?;
        let episodes = self.list_episodes()?;
        let downloads = self.list_downloads()?;
        let mut media_files = self.list_media_files()?;
        let fansub_names = self.list_fansub_names()?;
        let source_enabled = self.list_source_enabled()?;

        let daily_reminder = build_daily_reminder(&my_anime, &episodes, &downloads, &fansub_names);
        let today_episodes = daily_reminder
            .items
            .iter()
            .map(to_episode_summary)
            .collect();
        let pending_actions = build_pending_actions(&my_anime, &episodes, &downloads);
        let active_downloads = downloads
            .iter()
            .filter(|task| task.is_active())
            .cloned()
            .collect::<Vec<_>>();
        media_files.sort_by(|left, right| media_sort_key(right).cmp(media_sort_key(left)));
        media_files.truncate(10);
        for source in &mut source_health {
            if source_enabled.get(&source.source_id) == Some(&false) {
                source.status = "warning".to_owned();
            }
        }

        debug!(
            "Rust 首页聚合完成：followed={}, episodes={}, active_downloads={}, recent_completed={}",
            my_anime.len(),
            episodes.len(),
            active_downloads.len(),
            media_files.len()
        );
        Ok(DashboardData {
            daily_reminder,
            today_episodes,
            pending_actions,
            active_downloads,
            recent_completed: media_files,
            weekly_schedule,
            source_health,
        })
    }

    /// 读取番剧别名并按番剧分组。
    fn list_aliases_by_anime(&self) -> Result<HashMap<String, Vec<AnimeAlias>>, StorageError> {
        let rows = query_all(
            self.connection,
            "SELECT * FROM anime_alias ORDER BY priority DESC",
            map_alias_row,
        )?;
        let mut aliases = HashMap::<String, Vec<AnimeAlias>>::new();
        for row in rows {
            let anime_id = row.anime_id.clone();
            aliases
                .entry(anime_id)
                .or_default()
                .push(row.into_domain()?);
        }
        Ok(aliases)
    }

    /// 读取 RSS 订阅并按追番记录分组。
    fn list_rss_subscriptions_by_my_anime(
        &self,
    ) -> Result<HashMap<String, Vec<AnimeRssSubscription>>, StorageError> {
        let rows = query_all(
            self.connection,
            "SELECT * FROM my_anime_rss_subscription ORDER BY created_at, name",
            map_rss_subscription_row,
        )?;
        let mut subscriptions = HashMap::<String, Vec<AnimeRssSubscription>>::new();
        for row in rows {
            let my_anime_id = row.my_anime_id.clone();
            subscriptions
                .entry(my_anime_id)
                .or_default()
                .push(row.into_domain()?);
        }
        Ok(subscriptions)
    }

    /// 读取全部单集供首页聚合。
    fn list_episodes(&self) -> Result<Vec<Episode>, StorageError> {
        query_all(
            self.connection,
            "SELECT * FROM episode ORDER BY episode_no",
            map_episode_row,
        )?
        .into_iter()
        .map(EpisodeRow::into_domain)
        .collect()
    }

    /// 读取下载任务与文件快照。
    fn list_downloads(&self) -> Result<Vec<DownloadTask>, StorageError> {
        let file_rows = query_all(
            self.connection,
            "SELECT * FROM torrent_file ORDER BY file_index",
            map_torrent_file_row,
        )?;
        let mut files_by_task = HashMap::<String, Vec<TorrentFile>>::new();
        for row in file_rows {
            files_by_task
                .entry(row.download_task_id.clone())
                .or_default()
                .push(row.into_domain());
        }

        query_all(
            self.connection,
            "SELECT * FROM download_task ORDER BY created_at DESC",
            map_download_row,
        )?
        .into_iter()
        .map(|row| {
            let files = files_by_task.remove(&row.id).unwrap_or_default();
            row.into_domain(files)
        })
        .collect()
    }

    /// 读取并排序全部媒体文件。
    fn list_media_files(&self) -> Result<Vec<MediaFile>, StorageError> {
        query_all(
            self.connection,
            "SELECT * FROM media_file",
            map_media_file_row,
        )?
        .into_iter()
        .map(MediaFileRow::into_domain)
        .collect()
    }

    /// 读取字幕组名称映射。
    fn list_fansub_names(&self) -> Result<HashMap<String, String>, StorageError> {
        let rows = query_all(
            self.connection,
            "SELECT id, name FROM fansub_group",
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )?;
        Ok(rows.into_iter().collect())
    }

    /// 读取下载源启用状态映射。
    fn list_source_enabled(&self) -> Result<HashMap<String, bool>, StorageError> {
        let rows = query_all(
            self.connection,
            "SELECT id, enabled FROM release_source",
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)? != 0)),
        )?;
        Ok(rows.into_iter().collect())
    }

    /// 从固定表读取 JSON 状态。
    fn read_json_state(
        &self,
        table: &'static str,
        key: &'static str,
        context: &'static str,
    ) -> Result<Option<Value>, StorageError> {
        let sql = match table {
            "app_settings" => "SELECT value_json FROM app_settings WHERE key = ?1",
            "app_state" => "SELECT value_json FROM app_state WHERE key = ?1",
            _ => unreachable!("repository only reads fixed state tables"),
        };
        let raw = self
            .connection
            .query_row(sql, [key], |row| row.get::<_, String>(0))
            .optional()?;
        raw.map(|value| parse_json(&value, context)).transpose()
    }
}

/// 读取查询全部结果，统一转换 SQLite 错误。
fn query_all<T>(
    connection: &Connection,
    sql: &str,
    mut mapper: impl FnMut(&Row<'_>) -> rusqlite::Result<T>,
) -> Result<Vec<T>, StorageError> {
    let mut statement = connection.prepare(sql)?;
    let rows = statement.query_map([], |row| mapper(row))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(StorageError::from)
}

/// 将持久化设置递归覆盖到平台默认设置。
fn merge_json(target: &mut Value, patch: Value) {
    match (target, patch) {
        (Value::Object(target), Value::Object(patch)) => {
            for (key, value) in patch {
                match target.get_mut(&key) {
                    Some(existing) => merge_json(existing, value),
                    None => {
                        target.insert(key, value);
                    }
                }
            }
        }
        (target, patch) => *target = patch,
    }
}

/// 按稳定标识合并播放器配置，并保留新版本新增的默认项。
fn merge_player_profiles(defaults: Option<&Value>, patch: Option<&Value>) -> Option<Value> {
    let defaults = defaults?.as_array()?;
    let Some(patch) = patch.and_then(Value::as_array) else {
        return Some(Value::Array(defaults.clone()));
    };
    let patch_by_id = patch
        .iter()
        .filter_map(|profile| Some((profile.get("id")?.as_str()?, profile)))
        .collect::<HashMap<_, _>>();
    let mut merged = defaults
        .iter()
        .map(|profile| {
            let mut profile = profile.clone();
            if let Some(profile_patch) = profile
                .get("id")
                .and_then(Value::as_str)
                .and_then(|id| patch_by_id.get(id))
            {
                merge_json(&mut profile, (*profile_patch).clone());
            }
            profile
        })
        .collect::<Vec<_>>();
    let default_ids = defaults
        .iter()
        .filter_map(|profile| profile.get("id")?.as_str())
        .collect::<Vec<_>>();
    merged.extend(
        patch
            .iter()
            .filter(|profile| match profile.get("id").and_then(Value::as_str) {
                Some(id) => !default_ids.contains(&id),
                None => true,
            })
            .cloned(),
    );
    Some(Value::Array(merged))
}

/// 解析数据库 JSON 字段并附带业务上下文。
fn parse_json<T: DeserializeOwned>(value: &str, context: &'static str) -> Result<T, StorageError> {
    serde_json::from_str(value).map_err(|source| StorageError::JsonData { context, source })
}

/// 解析首页状态中的单个字段，缺失时交由调用方使用默认值。
fn read_dashboard_field<T: DeserializeOwned>(
    dashboard: &Value,
    key: &str,
    context: &'static str,
) -> Result<Option<T>, StorageError> {
    dashboard
        .get(key)
        .cloned()
        .map(|value| {
            serde_json::from_value(value)
                .map_err(|source| StorageError::JsonData { context, source })
        })
        .transpose()
}

/// 规范化字幕语言集合，并在空集合时兼容旧单值字段。
fn resolve_subtitle_languages(values: Vec<String>, legacy: Option<&str>) -> Vec<String> {
    let mut normalized = ["chs", "cht", "jpn", "eng"]
        .into_iter()
        .filter(|language| values.iter().any(|value| value == language))
        .map(str::to_owned)
        .collect::<Vec<_>>();
    if !normalized.is_empty() {
        return normalized;
    }
    normalized = match legacy {
        Some("multi") => vec!["chs".to_owned(), "cht".to_owned()],
        Some(language @ ("chs" | "cht" | "jpn" | "eng")) => vec![language.to_owned()],
        _ => Vec::new(),
    };
    normalized
}

/// 构建当天追番提醒和状态计数。
fn build_daily_reminder(
    my_anime: &[MyAnime],
    episodes: &[Episode],
    downloads: &[DownloadTask],
    fansub_names: &HashMap<String, String>,
) -> DailyReminderSummary {
    let today = Local::now().format("%Y-%m-%d").to_string();
    let followed = my_anime
        .iter()
        .map(|item| (item.anime.id.as_str(), item))
        .collect::<HashMap<_, _>>();
    let mut items = Vec::new();

    for episode in episodes {
        let Some(air_time) = episode.air_time.as_deref() else {
            continue;
        };
        if local_date_key(air_time).as_deref() != Some(today.as_str()) {
            continue;
        }
        let Some(followed_anime) = followed.get(episode.anime_id.as_str()) else {
            continue;
        };
        let download = find_episode_download(downloads, episode);
        let status = resolve_reminder_status(episode, download.as_ref());
        let fansub_name = followed_anime
            .default_fansub_group_id
            .as_ref()
            .and_then(|id| fansub_names.get(id))
            .cloned();
        items.push(DailyReminderItem {
            id: format!("daily-{}", episode.id),
            anime_id: episode.anime_id.clone(),
            anime_title: followed_anime.anime.title.clone(),
            episode_id: episode.id.clone(),
            episode_no: episode.episode_no,
            air_time: episode.air_time.clone(),
            status,
            fansub_name,
            download_task_id: download.map(|link| link.task.id.clone()),
        });
    }
    items.sort_by(|left, right| left.air_time.cmp(&right.air_time));

    DailyReminderSummary {
        date: today,
        total: items.len(),
        upcoming: count_status(&items, &[EpisodeStatus::Upcoming]),
        aired: count_status(&items, &[EpisodeStatus::Aired, EpisodeStatus::Matched]),
        downloading: count_status(&items, &[EpisodeStatus::Downloading]),
        downloaded: count_status(&items, &[EpisodeStatus::Downloaded, EpisodeStatus::Watched]),
        items,
    }
}

/// 生成首页默认字幕组等待事项。
fn build_pending_actions(
    my_anime: &[MyAnime],
    episodes: &[Episode],
    downloads: &[DownloadTask],
) -> Vec<PendingAction> {
    let followed = my_anime
        .iter()
        .map(|item| (item.anime.id.as_str(), item))
        .collect::<HashMap<_, _>>();
    let now = Utc::now();
    let mut candidates = episodes
        .iter()
        .filter_map(|episode| {
            let item = followed.get(episode.anime_id.as_str())?;
            let fansub_group_id = item.default_fansub_group_id.as_deref()?;
            if episode.status != EpisodeStatus::Aired {
                return None;
            }
            if episode
                .air_time
                .as_deref()
                .and_then(parse_timestamp)
                .is_some_and(|air_time| air_time > now)
            {
                return None;
            }
            let already_matched = downloads.iter().any(|task| {
                task.anime_id.as_deref() == Some(episode.anime_id.as_str())
                    && (task.episode_id.as_deref() == Some(episode.id.as_str())
                        || task.episode_no == Some(episode.episode_no))
                    && task.fansub_group_id.as_deref() == Some(fansub_group_id)
            });
            (!already_matched).then_some((*item, episode))
        })
        .collect::<Vec<_>>();
    candidates.sort_by(|left, right| {
        right.1.air_time.cmp(&left.1.air_time).then_with(|| {
            right
                .1
                .episode_no
                .partial_cmp(&left.1.episode_no)
                .unwrap_or(Ordering::Equal)
        })
    });
    candidates
        .into_iter()
        .take(8)
        .map(|(item, episode)| PendingAction {
            id: format!("pending-default-fansub-{}", episode.id),
            title: format!("《{}》第 {} 集", item.anime.title, episode.episode_no),
            description: format!(
                "《{}》第 {} 集已开播，但默认字幕组还没有发布资源。",
                item.anime.title, episode.episode_no
            ),
            severity: "warning".to_owned(),
            anime_id: Some(episode.anime_id.clone()),
            episode_id: Some(episode.id.clone()),
            episode_no: Some(episode.episode_no),
        })
        .collect()
}

/// 将每日提醒转换为首页精简单集。
fn to_episode_summary(item: &DailyReminderItem) -> EpisodeSummary {
    EpisodeSummary {
        id: item.id.clone(),
        anime_title: item.anime_title.clone(),
        episode_no: item.episode_no,
        air_time: item.air_time.as_deref().and_then(format_local_time),
        status: item.status.clone(),
        fansub_name: item.fansub_name.clone(),
        download_task_id: item.download_task_id.clone(),
    }
}

/// 计算指定状态集合中的提醒数量。
fn count_status(items: &[DailyReminderItem], statuses: &[EpisodeStatus]) -> usize {
    items
        .iter()
        .filter(|item| statuses.contains(&item.status))
        .count()
}

/// 查找任务级或文件级单集下载关联。
fn find_episode_download<'a>(
    downloads: &'a [DownloadTask],
    episode: &Episode,
) -> Option<EpisodeDownload<'a>> {
    for task in downloads {
        if task.anime_id.as_deref() != Some(episode.anime_id.as_str()) {
            continue;
        }
        if task.episode_id.as_deref() == Some(episode.id.as_str())
            || task.episode_no == Some(episode.episode_no)
        {
            return Some(EpisodeDownload { task, file: None });
        }
        if let Some(file) = task.files.iter().find(|file| {
            file.selected
                && (file.episode_id.as_deref() == Some(episode.id.as_str())
                    || file.episode_no == Some(episode.episode_no))
        }) {
            return Some(EpisodeDownload {
                task,
                file: Some(file),
            });
        }
    }
    None
}

/// 根据下载关联解析首页提醒状态。
fn resolve_reminder_status(
    episode: &Episode,
    download: Option<&EpisodeDownload<'_>>,
) -> EpisodeStatus {
    let Some(download) = download else {
        return episode.status.clone();
    };
    if download.task.is_completed() || download.file.is_some_and(|file| file.progress >= 1.0) {
        return EpisodeStatus::Downloaded;
    }
    if download.task.status.is_active() {
        return EpisodeStatus::Downloading;
    }
    episode.status.clone()
}

/// 将时间戳转换为当前时区日期键。
fn local_date_key(value: &str) -> Option<String> {
    parse_timestamp(value).map(|date| date.with_timezone(&Local).format("%Y-%m-%d").to_string())
}

/// 将时间戳转换为当前时区时分。
fn format_local_time(value: &str) -> Option<String> {
    parse_timestamp(value).map(|date| date.with_timezone(&Local).format("%H:%M").to_string())
}

/// 解析数据库使用的 RFC 3339 时间戳。
fn parse_timestamp(value: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|date| date.with_timezone(&Utc))
}

/// 返回媒体文件最近探测或下载时间。
fn media_sort_key(media: &MediaFile) -> &str {
    media
        .probed_at
        .as_deref()
        .or(media.downloaded_at.as_deref())
        .unwrap_or("")
}

/// 按季度和标题排序追番列表。
fn sort_my_anime(items: &mut [MyAnime]) {
    items.sort_by(|left, right| {
        right
            .anime
            .premiere_year
            .cmp(&left.anime.premiere_year)
            .then_with(|| right.anime.premiere_month.cmp(&left.anime.premiere_month))
            .then_with(|| left.anime.title.cmp(&right.anime.title))
    });
}

/// 单集与下载任务的关联结果。
struct EpisodeDownload<'task> {
    task: &'task DownloadTask,
    file: Option<&'task TorrentFile>,
}

struct AnimeAliasRow {
    id: String,
    anime_id: String,
    alias: String,
    language: String,
    priority: i64,
}

impl AnimeAliasRow {
    /// 将 SQLite 别名行转换为领域对象。
    fn into_domain(self) -> Result<AnimeAlias, StorageError> {
        Ok(AnimeAlias {
            id: self.id,
            anime_id: self.anime_id,
            alias: self.alias,
            language: parse_alias_language(&self.language)?,
            priority: self.priority,
        })
    }
}

struct AnimeRow {
    id: String,
    title: String,
    original_title: Option<String>,
    premiere_date: Option<String>,
    premiere_year: i64,
    premiere_month: i64,
    season: Option<String>,
    summary: Option<String>,
    cover_url: Option<String>,
    rating_score: Option<f64>,
    rating_count: Option<i64>,
    rating_source: Option<String>,
    external_ids_json: String,
    detail_json: String,
}

impl AnimeRow {
    /// 将 SQLite 番剧行转换为领域对象，详情损坏时保留基础信息。
    fn into_domain(self, aliases: Vec<AnimeAlias>) -> Result<Anime, StorageError> {
        let rating = self
            .rating_score
            .zip(self.rating_source)
            .map(|(score, source)| AnimeRating {
                score,
                count: self.rating_count,
                source,
            });
        let detail = match serde_json::from_str::<Value>(&self.detail_json) {
            Ok(Value::Object(object)) if object.is_empty() => None,
            Ok(Value::Null) => None,
            Ok(value) => Some(value),
            Err(detail_error) => {
                warn!(
                    "SQLite 番剧详情 JSON 解析失败：anime_id={}, error={}",
                    self.id, detail_error
                );
                None
            }
        };
        Ok(Anime {
            id: self.id,
            title: self.title,
            original_title: self.original_title,
            aliases,
            premiere_date: self.premiere_date,
            premiere_year: self.premiere_year,
            premiere_month: self.premiere_month,
            season: self.season,
            summary: self.summary,
            cover_url: self.cover_url,
            rating,
            external_ids: parse_json(&self.external_ids_json, "番剧外部标识")?,
            detail,
        })
    }
}

struct MyAnimeRow {
    id: String,
    anime_id: String,
    status: String,
    default_fansub_group_id: Option<String>,
    auto_download: bool,
    download_dir: Option<String>,
    preferred_resolution: Option<String>,
    preferred_codec: Option<String>,
    preferred_subtitle: Option<String>,
    preferred_subtitle_languages_json: String,
    preferred_bit_depth: Option<i64>,
    added_at: String,
    updated_at: String,
}

impl MyAnimeRow {
    /// 将 SQLite 追番行转换为领域对象。
    fn into_domain(
        self,
        anime: Anime,
        rss_subscriptions: Vec<AnimeRssSubscription>,
    ) -> Result<MyAnime, StorageError> {
        let preferred_subtitle_languages = resolve_subtitle_languages(
            parse_json(&self.preferred_subtitle_languages_json, "追番字幕语言")?,
            self.preferred_subtitle.as_deref(),
        );
        Ok(MyAnime {
            id: self.id,
            anime,
            status: parse_anime_status(&self.status)?,
            default_fansub_group_id: self.default_fansub_group_id,
            auto_download: self.auto_download,
            download_dir: self.download_dir,
            rss_subscriptions,
            preferred_resolution: self.preferred_resolution,
            preferred_codec: self.preferred_codec,
            preferred_bit_depth: self.preferred_bit_depth,
            preferred_subtitle_languages,
            preferred_subtitle: self.preferred_subtitle,
            added_at: self.added_at,
            updated_at: self.updated_at,
        })
    }
}

struct RssSubscriptionRow {
    id: String,
    my_anime_id: String,
    name: String,
    url: String,
    enabled: bool,
    preferred_subtitle: Option<String>,
    preferred_subtitle_languages_json: String,
    refresh_interval_minutes: Option<i64>,
    last_fetched_at: Option<String>,
    created_at: String,
    updated_at: String,
}

impl RssSubscriptionRow {
    /// 将 SQLite RSS 订阅行转换为领域对象。
    fn into_domain(self) -> Result<AnimeRssSubscription, StorageError> {
        let preferred_subtitle_languages = resolve_subtitle_languages(
            parse_json(&self.preferred_subtitle_languages_json, "RSS 字幕语言")?,
            self.preferred_subtitle.as_deref(),
        );
        Ok(AnimeRssSubscription {
            id: self.id,
            my_anime_id: self.my_anime_id,
            name: self.name,
            url: self.url,
            enabled: self.enabled,
            preferred_subtitle_languages,
            preferred_subtitle: self.preferred_subtitle,
            refresh_interval_minutes: self.refresh_interval_minutes,
            last_fetched_at: self.last_fetched_at,
            created_at: self.created_at,
            updated_at: self.updated_at,
        })
    }
}

struct EpisodeRow {
    id: String,
    anime_id: String,
    episode_no: f64,
    title: Option<String>,
    air_time: Option<String>,
    status: String,
}

impl EpisodeRow {
    /// 将 SQLite 单集行转换为领域对象。
    fn into_domain(self) -> Result<Episode, StorageError> {
        Ok(Episode {
            id: self.id,
            anime_id: self.anime_id,
            episode_no: self.episode_no,
            title: self.title,
            air_time: self.air_time,
            status: parse_episode_status(&self.status)?,
        })
    }
}

struct TorrentFileRow {
    download_task_id: String,
    id: String,
    index: i64,
    name: String,
    episode_id: Option<String>,
    episode_no: Option<f64>,
    size: i64,
    progress: f64,
    priority: i64,
    selected: bool,
}

impl TorrentFileRow {
    /// 将 SQLite 种子文件行转换为领域对象。
    fn into_domain(self) -> TorrentFile {
        TorrentFile {
            id: self.id,
            index: self.index,
            name: self.name,
            episode_id: self.episode_id,
            episode_no: self.episode_no,
            size: self.size,
            progress: self.progress,
            priority: self.priority,
            selected: self.selected,
        }
    }
}

struct DownloadRow {
    id: String,
    release_id: Option<String>,
    anime_id: Option<String>,
    episode_id: Option<String>,
    anime_title: Option<String>,
    episode_no: Option<f64>,
    fansub_group_id: Option<String>,
    fansub_name: Option<String>,
    resolution: Option<String>,
    declared_video_codec: Option<String>,
    normalized_video_codec: Option<String>,
    bit_depth: Option<i64>,
    subtitle_languages_json: String,
    subtitle: Option<String>,
    correlation_tag: Option<String>,
    engine: String,
    torrent_hash: Option<String>,
    name: String,
    status: String,
    progress: f64,
    download_speed: i64,
    upload_speed: i64,
    eta_seconds: Option<i64>,
    save_path: String,
    created_at: String,
    completed_at: Option<String>,
}

impl DownloadRow {
    /// 将 SQLite 下载任务行转换为领域对象。
    fn into_domain(self, files: Vec<TorrentFile>) -> Result<DownloadTask, StorageError> {
        let subtitle_languages = resolve_subtitle_languages(
            parse_json(&self.subtitle_languages_json, "下载任务字幕语言")?,
            self.subtitle.as_deref(),
        );
        Ok(DownloadTask {
            id: self.id,
            release_id: self.release_id,
            anime_id: self.anime_id,
            episode_id: self.episode_id,
            anime_title: self.anime_title,
            episode_no: self.episode_no,
            fansub_group_id: self.fansub_group_id,
            fansub_name: self.fansub_name,
            resolution: self.resolution,
            declared_video_codec: self.declared_video_codec,
            normalized_video_codec: self.normalized_video_codec,
            bit_depth: self.bit_depth,
            subtitle_languages,
            subtitle: self.subtitle,
            correlation_tag: self.correlation_tag,
            engine: parse_torrent_engine(&self.engine)?,
            torrent_hash: self.torrent_hash,
            name: self.name,
            status: parse_download_status(&self.status)?,
            progress: self.progress,
            download_speed: self.download_speed,
            upload_speed: self.upload_speed,
            eta_seconds: self.eta_seconds,
            save_path: self.save_path,
            files,
            created_at: self.created_at,
            completed_at: self.completed_at,
        })
    }
}

struct MediaFileRow {
    id: String,
    anime_id: String,
    episode_id: Option<String>,
    download_task_id: Option<String>,
    file_path: String,
    file_name: String,
    size: i64,
    container: Option<String>,
    declared_video_codec: Option<String>,
    detected_video_codec: Option<String>,
    normalized_video_codec: String,
    resolution: Option<String>,
    bit_depth: Option<i64>,
    audio_codecs_json: String,
    subtitle_tracks_json: String,
    duration_seconds: Option<i64>,
    downloaded_at: Option<String>,
    probed_at: Option<String>,
}

impl MediaFileRow {
    /// 将 SQLite 媒体文件行转换为领域对象。
    fn into_domain(self) -> Result<MediaFile, StorageError> {
        Ok(MediaFile {
            id: self.id,
            anime_id: self.anime_id,
            episode_id: self.episode_id,
            download_task_id: self.download_task_id,
            file_path: self.file_path,
            file_name: self.file_name,
            size: self.size,
            container: self.container,
            declared_video_codec: self.declared_video_codec,
            detected_video_codec: self.detected_video_codec,
            normalized_video_codec: self.normalized_video_codec,
            resolution: self.resolution,
            bit_depth: self.bit_depth,
            audio_codecs: parse_json(&self.audio_codecs_json, "媒体音轨")?,
            subtitle_tracks: parse_json(&self.subtitle_tracks_json, "媒体字幕轨")?,
            duration_seconds: self.duration_seconds,
            downloaded_at: self.downloaded_at,
            probed_at: self.probed_at,
        })
    }
}

struct NotificationRow {
    id: String,
    kind: String,
    title: String,
    body: String,
    severity: String,
    anime_id: Option<String>,
    episode_id: Option<String>,
    download_task_id: Option<String>,
    created_at: String,
    read_at: Option<String>,
}

impl NotificationRow {
    /// 将 SQLite 通知行转换为领域对象。
    fn into_domain(self) -> Result<NotificationRecord, StorageError> {
        Ok(NotificationRecord {
            id: self.id,
            kind: parse_notification_kind(&self.kind)?,
            title: self.title,
            body: self.body,
            severity: parse_notification_severity(&self.severity)?,
            anime_id: self.anime_id,
            episode_id: self.episode_id,
            download_task_id: self.download_task_id,
            created_at: self.created_at,
            read_at: self.read_at,
        })
    }
}

/// 映射 SQLite 番剧别名行。
fn map_alias_row(row: &Row<'_>) -> rusqlite::Result<AnimeAliasRow> {
    Ok(AnimeAliasRow {
        id: row.get("id")?,
        anime_id: row.get("anime_id")?,
        alias: row.get("alias")?,
        language: row.get("language")?,
        priority: row.get("priority")?,
    })
}

/// 映射 SQLite 番剧目录行。
fn map_anime_row(row: &Row<'_>) -> rusqlite::Result<AnimeRow> {
    Ok(AnimeRow {
        id: row.get("id")?,
        title: row.get("title")?,
        original_title: row.get("original_title")?,
        premiere_date: row.get("premiere_date")?,
        premiere_year: row.get("premiere_year")?,
        premiere_month: row.get("premiere_month")?,
        season: row.get("season")?,
        summary: row.get("summary")?,
        cover_url: row.get("cover_url")?,
        rating_score: row.get("rating_score")?,
        rating_count: row.get("rating_count")?,
        rating_source: row.get("rating_source")?,
        external_ids_json: row.get("external_ids_json")?,
        detail_json: row.get("detail_json")?,
    })
}

/// 映射 SQLite 追番行。
fn map_my_anime_row(row: &Row<'_>) -> rusqlite::Result<MyAnimeRow> {
    Ok(MyAnimeRow {
        id: row.get("id")?,
        anime_id: row.get("anime_id")?,
        status: row.get("status")?,
        default_fansub_group_id: row.get("default_fansub_group_id")?,
        auto_download: row.get::<_, i64>("auto_download")? != 0,
        download_dir: row.get("download_dir")?,
        preferred_resolution: row.get("preferred_resolution")?,
        preferred_codec: row.get("preferred_codec")?,
        preferred_subtitle: row.get("preferred_subtitle")?,
        preferred_subtitle_languages_json: row.get("preferred_subtitle_languages_json")?,
        preferred_bit_depth: row.get("preferred_bit_depth")?,
        added_at: row.get("added_at")?,
        updated_at: row.get("updated_at")?,
    })
}

/// 映射 SQLite RSS 订阅行。
fn map_rss_subscription_row(row: &Row<'_>) -> rusqlite::Result<RssSubscriptionRow> {
    Ok(RssSubscriptionRow {
        id: row.get("id")?,
        my_anime_id: row.get("my_anime_id")?,
        name: row.get("name")?,
        url: row.get("url")?,
        enabled: row.get::<_, i64>("enabled")? != 0,
        preferred_subtitle: row.get("preferred_subtitle")?,
        preferred_subtitle_languages_json: row.get("preferred_subtitle_languages_json")?,
        refresh_interval_minutes: row.get("refresh_interval_minutes")?,
        last_fetched_at: row.get("last_fetched_at")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

/// 映射 SQLite 单集行。
fn map_episode_row(row: &Row<'_>) -> rusqlite::Result<EpisodeRow> {
    Ok(EpisodeRow {
        id: row.get("id")?,
        anime_id: row.get("anime_id")?,
        episode_no: row.get("episode_no")?,
        title: row.get("title")?,
        air_time: row.get("air_time")?,
        status: row.get("status")?,
    })
}

/// 映射 SQLite 种子文件行。
fn map_torrent_file_row(row: &Row<'_>) -> rusqlite::Result<TorrentFileRow> {
    Ok(TorrentFileRow {
        download_task_id: row.get("download_task_id")?,
        id: row.get("id")?,
        index: row.get("file_index")?,
        name: row.get("name")?,
        episode_id: row.get("episode_id")?,
        episode_no: row.get("episode_no")?,
        size: row.get("size")?,
        progress: row.get("progress")?,
        priority: row.get("priority")?,
        selected: row.get::<_, i64>("selected")? != 0,
    })
}

/// 映射 SQLite 下载任务行。
fn map_download_row(row: &Row<'_>) -> rusqlite::Result<DownloadRow> {
    Ok(DownloadRow {
        id: row.get("id")?,
        release_id: row.get("release_id")?,
        anime_id: row.get("anime_id")?,
        episode_id: row.get("episode_id")?,
        anime_title: row.get("anime_title")?,
        episode_no: row.get("episode_no")?,
        fansub_group_id: row.get("fansub_group_id")?,
        fansub_name: row.get("fansub_name")?,
        resolution: row.get("resolution")?,
        declared_video_codec: row.get("declared_video_codec")?,
        normalized_video_codec: row.get("normalized_video_codec")?,
        bit_depth: row.get("bit_depth")?,
        subtitle_languages_json: row.get("subtitle_languages_json")?,
        subtitle: row.get("subtitle")?,
        correlation_tag: row.get("correlation_tag")?,
        engine: row.get("engine")?,
        torrent_hash: row.get("torrent_hash")?,
        name: row.get("name")?,
        status: row.get("status")?,
        progress: row.get("progress")?,
        download_speed: row.get("download_speed")?,
        upload_speed: row.get("upload_speed")?,
        eta_seconds: row.get("eta_seconds")?,
        save_path: row.get("save_path")?,
        created_at: row.get("created_at")?,
        completed_at: row.get("completed_at")?,
    })
}

/// 映射 SQLite 媒体文件行。
fn map_media_file_row(row: &Row<'_>) -> rusqlite::Result<MediaFileRow> {
    Ok(MediaFileRow {
        id: row.get("id")?,
        anime_id: row.get("anime_id")?,
        episode_id: row.get("episode_id")?,
        download_task_id: row.get("download_task_id")?,
        file_path: row.get("file_path")?,
        file_name: row.get("file_name")?,
        size: row.get("size")?,
        container: row.get("container")?,
        declared_video_codec: row.get("declared_video_codec")?,
        detected_video_codec: row.get("detected_video_codec")?,
        normalized_video_codec: row.get("normalized_video_codec")?,
        resolution: row.get("resolution")?,
        bit_depth: row.get("bit_depth")?,
        audio_codecs_json: row.get("audio_codecs_json")?,
        subtitle_tracks_json: row.get("subtitle_tracks_json")?,
        duration_seconds: row.get("duration_seconds")?,
        downloaded_at: row.get("downloaded_at")?,
        probed_at: row.get("probed_at")?,
    })
}

/// 映射 SQLite 通知行。
fn map_notification_row(row: &Row<'_>) -> rusqlite::Result<NotificationRow> {
    Ok(NotificationRow {
        id: row.get("id")?,
        kind: row.get("kind")?,
        title: row.get("title")?,
        body: row.get("body")?,
        severity: row.get("severity")?,
        anime_id: row.get("anime_id")?,
        episode_id: row.get("episode_id")?,
        download_task_id: row.get("download_task_id")?,
        created_at: row.get("created_at")?,
        read_at: row.get("read_at")?,
    })
}

/// 解析番剧别名语言。
fn parse_alias_language(value: &str) -> Result<AnimeAliasLanguage, StorageError> {
    match value {
        "zh" => Ok(AnimeAliasLanguage::Zh),
        "ja" => Ok(AnimeAliasLanguage::Ja),
        "en" => Ok(AnimeAliasLanguage::En),
        "romaji" => Ok(AnimeAliasLanguage::Romaji),
        "custom" => Ok(AnimeAliasLanguage::Custom),
        _ => invalid_value("anime_alias.language", value),
    }
}

/// 解析追番状态。
fn parse_anime_status(value: &str) -> Result<AnimeStatus, StorageError> {
    match value {
        "watching" => Ok(AnimeStatus::Watching),
        "planned" => Ok(AnimeStatus::Planned),
        "completed" => Ok(AnimeStatus::Completed),
        "paused" => Ok(AnimeStatus::Paused),
        "dropped" => Ok(AnimeStatus::Dropped),
        _ => invalid_value("my_anime.status", value),
    }
}

/// 解析单集状态。
fn parse_episode_status(value: &str) -> Result<EpisodeStatus, StorageError> {
    match value {
        "upcoming" => Ok(EpisodeStatus::Upcoming),
        "aired" => Ok(EpisodeStatus::Aired),
        "matched" => Ok(EpisodeStatus::Matched),
        "downloading" => Ok(EpisodeStatus::Downloading),
        "downloaded" => Ok(EpisodeStatus::Downloaded),
        "watched" => Ok(EpisodeStatus::Watched),
        _ => invalid_value("episode.status", value),
    }
}

/// 解析下载状态。
fn parse_download_status(value: &str) -> Result<DownloadStatus, StorageError> {
    match value {
        "queued" => Ok(DownloadStatus::Queued),
        "fetching_metadata" => Ok(DownloadStatus::FetchingMetadata),
        "downloading" => Ok(DownloadStatus::Downloading),
        "stalled" => Ok(DownloadStatus::Stalled),
        "paused" => Ok(DownloadStatus::Paused),
        "checking" => Ok(DownloadStatus::Checking),
        "moving" => Ok(DownloadStatus::Moving),
        "completed" => Ok(DownloadStatus::Completed),
        "seeding" => Ok(DownloadStatus::Seeding),
        "error" => Ok(DownloadStatus::Error),
        "missing_files" => Ok(DownloadStatus::MissingFiles),
        _ => invalid_value("download_task.status", value),
    }
}

/// 解析下载引擎类型。
fn parse_torrent_engine(value: &str) -> Result<TorrentEngineKind, StorageError> {
    match value {
        "embedded" => Ok(TorrentEngineKind::Embedded),
        "qbittorrent" => Ok(TorrentEngineKind::Qbittorrent),
        _ => invalid_value("download_task.engine", value),
    }
}

/// 解析通知类别。
fn parse_notification_kind(value: &str) -> Result<NotificationKind, StorageError> {
    match value {
        "automation" => Ok(NotificationKind::Automation),
        "download" => Ok(NotificationKind::Download),
        "reminder" => Ok(NotificationKind::Reminder),
        "system" => Ok(NotificationKind::System),
        _ => invalid_value("notification.kind", value),
    }
}

/// 解析通知严重程度。
fn parse_notification_severity(value: &str) -> Result<NotificationSeverity, StorageError> {
    match value {
        "info" => Ok(NotificationSeverity::Info),
        "success" => Ok(NotificationSeverity::Success),
        "warning" => Ok(NotificationSeverity::Warning),
        "error" => Ok(NotificationSeverity::Error),
        _ => invalid_value("notification.severity", value),
    }
}

/// 创建统一的非法领域字段错误。
fn invalid_value<T>(field: &'static str, value: &str) -> Result<T, StorageError> {
    Err(StorageError::InvalidDomainValue {
        field,
        value: value.to_owned(),
    })
}
