use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};

use ani_domain::{
    Anime, AnimeAlias, AnimeAliasLanguage, AnimeDetailPartialError, AnimeDetailResult,
    AnimeDiscoverySearchResult, AnimeRating, AnimeRssSubscription, AnimeStatus, AnimeWatchProgress,
    AppSettings, DailyReminderItem, DailyReminderSummary, DashboardData, DownloadStatus,
    DownloadTask, Episode, EpisodePreference, EpisodeStatus, EpisodeSummary, FansubGroup,
    MediaFile, MyAnime, NotificationKind, NotificationRecord, NotificationSeverity, PendingAction,
    PlaybackCheckpoint, ReportPlaybackProgressInput, SavePlaybackCheckpointInput,
    SetAnimeWatchProgressInput, SourceHealth, TorrentEngineKind, TorrentFile, WeeklyScheduleDay,
};
use chrono::{DateTime, Duration, Local, Utc};
use log::{debug, info, warn};
use rusqlite::{params, Connection, OptionalExtension, Params, Row};
use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::{now_iso, StorageError};

/// 提供 P2 首批设置、通知、追番和首页只读查询。
pub struct AppRepository<'connection> {
    connection: &'connection Connection,
}

/// 番剧目录批量写入后的计数和完整目录。
#[derive(Debug, Clone, PartialEq)]
pub struct AnimeCatalogWriteResult {
    pub items: Vec<Anime>,
    pub added_count: usize,
    pub existing_count: usize,
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
        preserve_host_storage_paths(&mut merged, platform_defaults);
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

    /// 按可选年月读取并排序本地番剧目录。
    pub fn list_anime_catalog(
        &self,
        year: Option<i64>,
        month: Option<i64>,
    ) -> Result<Vec<Anime>, StorageError> {
        if month.is_some_and(|value| !(1..=12).contains(&value)) {
            return invalid_input("month", "月份必须在 1 到 12 之间");
        }
        let aliases = self.list_aliases_by_anime()?;
        let rows = match (year, month) {
            (Some(year), Some(month)) => query_all_with_params(
                self.connection,
                "SELECT * FROM anime_catalog WHERE premiere_year = ?1 AND premiere_month = ?2",
                params![year, month],
                map_anime_row,
            )?,
            _ => query_all(
                self.connection,
                "SELECT * FROM anime_catalog",
                map_anime_row,
            )?,
        };
        let mut items = rows
            .into_iter()
            .map(|row| {
                let anime_aliases = aliases.get(&row.id).cloned().unwrap_or_default();
                row.into_domain(anime_aliases)
            })
            .collect::<Result<Vec<_>, _>>()?;
        sort_anime_catalog(&mut items);
        Ok(items)
    }

    /// 按目录标识读取一部番剧及其别名。
    pub fn get_anime_catalog_by_id(&self, anime_id: &str) -> Result<Option<Anime>, StorageError> {
        let row = self
            .connection
            .query_row(
                "SELECT * FROM anime_catalog WHERE id = ?1",
                [anime_id],
                map_anime_row,
            )
            .optional()?;
        let Some(row) = row else {
            return Ok(None);
        };
        let aliases = query_all_with_params(
            self.connection,
            "SELECT * FROM anime_alias WHERE anime_id = ?1 ORDER BY priority DESC",
            [anime_id],
            map_alias_row,
        )?
        .into_iter()
        .map(AnimeAliasRow::into_domain)
        .collect::<Result<Vec<_>, _>>()?;
        row.into_domain(aliases).map(Some)
    }

    /// 按标题、原名和别名搜索本地番剧目录。
    pub fn search_anime_catalog(
        &self,
        keyword: &str,
    ) -> Result<AnimeDiscoverySearchResult, StorageError> {
        let keyword = keyword.trim();
        let normalized = keyword.to_lowercase();
        let items = self
            .list_anime_catalog(None, None)?
            .into_iter()
            .filter(|anime| {
                normalized.is_empty()
                    || anime.title.to_lowercase().contains(&normalized)
                    || anime
                        .original_title
                        .as_deref()
                        .is_some_and(|title| title.to_lowercase().contains(&normalized))
                    || anime
                        .aliases
                        .iter()
                        .any(|alias| alias.alias.to_lowercase().contains(&normalized))
            })
            .collect();
        Ok(AnimeDiscoverySearchResult {
            keyword: keyword.to_owned(),
            items,
            source: "local".to_owned(),
            errors: Vec::new(),
        })
    }

    /// 合并并原子保存一批番剧目录记录。
    pub fn upsert_anime_catalog(
        &self,
        items: &[Anime],
    ) -> Result<AnimeCatalogWriteResult, StorageError> {
        self.persist_anime_catalog(items, None)
    }

    /// 原子替换指定月份的未引用缓存，并保留业务引用记录。
    pub fn replace_anime_catalog_month(
        &self,
        year: i64,
        month: i64,
        items: &[Anime],
    ) -> Result<AnimeCatalogWriteResult, StorageError> {
        if !(1..=12).contains(&month) {
            return invalid_input("month", "月份必须在 1 到 12 之间");
        }
        self.persist_anime_catalog(items, Some((year, month)))
    }

    /// 聚合本地番剧、追番、单集和字幕组供详情页首屏使用。
    pub fn get_anime_detail(&self, anime_id: &str) -> Result<AnimeDetailResult, StorageError> {
        let anime = self.get_anime_catalog_by_id(anime_id)?.ok_or_else(|| {
            StorageError::RecordNotFound {
                entity: "番剧",
                id: anime_id.to_owned(),
            }
        })?;
        let my_anime = self
            .list_my_anime()?
            .into_iter()
            .find(|item| item.anime.id == anime_id);
        let episodes = self.list_episodes(anime_id)?;
        let fansub_groups = self.list_fansubs(Some(anime_id))?;
        let refreshed_at = anime
            .detail
            .as_ref()
            .and_then(|detail| detail.get("refreshedAt"))
            .and_then(Value::as_str)
            .and_then(parse_timestamp);
        let stale = match refreshed_at {
            Some(value) => Utc::now() - value > Duration::hours(24),
            None => true,
        };
        debug!(
            "Rust 番剧详情聚合完成：anime_id={}, followed={}, episodes={}, fansubs={}, stale={}",
            anime_id,
            my_anime.is_some(),
            episodes.len(),
            fansub_groups.len(),
            stale
        );
        Ok(AnimeDetailResult {
            anime,
            my_anime,
            episodes,
            fansub_groups,
            stale,
            partial_errors: Vec::<AnimeDetailPartialError>::new(),
        })
    }

    /// 读取全部或指定番剧已观察到的字幕组。
    pub fn list_fansubs(&self, anime_id: Option<&str>) -> Result<Vec<FansubGroup>, StorageError> {
        match anime_id {
            Some(anime_id) => query_all_with_params(
                self.connection,
                "SELECT fansub_group.*
                 FROM fansub_group
                 INNER JOIN anime_fansub_group
                   ON anime_fansub_group.fansub_group_id = fansub_group.id
                 WHERE anime_fansub_group.anime_id = ?1
                 ORDER BY anime_fansub_group.last_seen_at DESC, fansub_group.name",
                [anime_id],
                map_fansub_group_row,
            )?
            .into_iter()
            .map(FansubGroupRow::into_domain)
            .collect(),
            None => query_all(
                self.connection,
                "SELECT * FROM fansub_group ORDER BY name",
                map_fansub_group_row,
            )?
            .into_iter()
            .map(FansubGroupRow::into_domain)
            .collect(),
        }
    }

    /// 读取并按季度、标题排序我的追番。
    pub fn list_my_anime(&self) -> Result<Vec<MyAnime>, StorageError> {
        let anime = self.list_anime_catalog(None, None)?;
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

    /// 在单个事务中保存番剧目录、追番规则和 RSS 订阅。
    pub fn upsert_my_anime(&self, mut item: MyAnime) -> Result<Vec<MyAnime>, StorageError> {
        validate_identifier("myAnime.id", &item.id)?;
        validate_identifier("myAnime.anime.id", &item.anime.id)?;
        if item.anime.title.trim().is_empty() {
            return invalid_input("myAnime.anime.title", "番剧标题不能为空");
        }

        let timestamp = now_iso();
        if item.added_at.trim().is_empty() {
            item.added_at = timestamp.clone();
        }
        item.updated_at = timestamp.clone();
        if matches!(item.status, AnimeStatus::Completed | AnimeStatus::Dropped) {
            item.auto_download = false;
        }

        let transaction = self.connection.unchecked_transaction()?;
        upsert_anime_row(&transaction, &item.anime, &timestamp)?;
        upsert_my_anime_row(&transaction, &item, &timestamp)?;
        transaction.commit()?;
        info!(
            "Rust 追番保存完成：item_id={}, anime_id={}, status={}",
            item.id,
            item.anime.id,
            anime_status_value(&item.status)
        );
        self.list_my_anime()
    }

    /// 删除追番及其单集业务数据，保留可复用的番剧目录记录。
    pub fn remove_my_anime(&self, item_id: &str) -> Result<Vec<MyAnime>, StorageError> {
        validate_identifier("itemId", item_id)?;
        let anime_id = self
            .connection
            .query_row(
                "SELECT anime_id FROM my_anime WHERE id = ?1",
                [item_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        let transaction = self.connection.unchecked_transaction()?;
        transaction.execute("DELETE FROM my_anime WHERE id = ?1", [item_id])?;
        if let Some(anime_id) = anime_id.as_deref() {
            transaction.execute("DELETE FROM episode WHERE anime_id = ?1", [anime_id])?;
        }
        transaction.commit()?;
        info!("Rust 追番删除完成：item_id={item_id}");
        self.list_my_anime()
    }

    /// 读取指定番剧的全部单集。
    pub fn list_episodes(&self, anime_id: &str) -> Result<Vec<Episode>, StorageError> {
        query_all_with_params(
            self.connection,
            "SELECT * FROM episode WHERE anime_id = ?1 ORDER BY episode_no",
            [anime_id],
            map_episode_row,
        )?
        .into_iter()
        .map(EpisodeRow::into_domain)
        .collect()
    }

    /// 新增或更新一条单集记录。
    pub fn upsert_episode(&self, episode: &Episode) -> Result<Vec<Episode>, StorageError> {
        validate_episode(episode)?;
        upsert_episode_row(self.connection, episode, &now_iso())?;
        self.list_episodes(&episode.anime_id)
    }

    /// 汇总全部追番的连续观看进度。
    pub fn list_my_anime_watch_progress(&self) -> Result<Vec<AnimeWatchProgress>, StorageError> {
        self.list_my_anime()?
            .into_iter()
            .map(|item| {
                let episodes = self.list_episodes(&item.anime.id)?;
                Ok(build_anime_watch_progress(&item, &episodes))
            })
            .collect()
    }

    /// 在单个事务中补齐单集并批量调整已看状态。
    pub fn set_anime_watch_progress(
        &self,
        input: &SetAnimeWatchProgressInput,
    ) -> Result<AnimeWatchProgress, StorageError> {
        if !(0..=10_000).contains(&input.watched_episode_count) {
            return invalid_input(
                "watchedEpisodeCount",
                "观看进度必须是 0 到 10000 之间的整数",
            );
        }
        let item = self
            .list_my_anime()?
            .into_iter()
            .find(|item| item.anime.id == input.anime_id)
            .ok_or_else(|| StorageError::RecordNotFound {
                entity: "追番",
                id: input.anime_id.clone(),
            })?;
        let episodes = self.list_episodes(&input.anime_id)?;
        let episode_by_number = episodes
            .iter()
            .filter(|episode| is_positive_integer(episode.episode_no))
            .map(|episode| (episode.episode_no as i64, episode.clone()))
            .collect::<HashMap<_, _>>();
        let timestamp = now_iso();
        let transaction = self.connection.unchecked_transaction()?;

        for episode_no in 1..=input.watched_episode_count {
            let mut episode = episode_by_number
                .get(&episode_no)
                .cloned()
                .unwrap_or_else(|| Episode {
                    id: create_download_episode_id(&input.anime_id, episode_no),
                    anime_id: input.anime_id.clone(),
                    episode_no: episode_no as f64,
                    title: None,
                    air_time: None,
                    status: EpisodeStatus::Aired,
                });
            episode.status = EpisodeStatus::Watched;
            upsert_episode_row(&transaction, &episode, &timestamp)?;
        }

        for episode in episodes.iter().filter(|episode| {
            episode.episode_no > input.watched_episode_count as f64
                && episode.status == EpisodeStatus::Watched
        }) {
            let mut episode = episode.clone();
            episode.status = resolve_episode_status_after_unwatch(&transaction, &episode)?;
            upsert_episode_row(&transaction, &episode, &timestamp)?;
        }
        transaction.execute(
            "UPDATE my_anime SET updated_at = ?1 WHERE anime_id = ?2",
            params![&timestamp, &input.anime_id],
        )?;
        transaction.commit()?;

        let progress = build_anime_watch_progress(&item, &self.list_episodes(&input.anime_id)?);
        info!(
            "Rust 观看进度更新完成：anime_id={}, watched={}, total={}",
            progress.anime_id, progress.watched_episode_count, progress.total_episode_count
        );
        Ok(progress)
    }

    /// 按下载任务和文件关联将达到阈值的单集标记为已看。
    pub fn report_playback_progress(
        &self,
        input: &ReportPlaybackProgressInput,
    ) -> Result<bool, StorageError> {
        if !input.percent.is_finite() || input.percent < 90.0 {
            return Ok(false);
        }
        if input.file_index.is_some_and(|index| index < 0) {
            return invalid_input("fileIndex", "播放文件索引必须是非负整数");
        }
        let task = self
            .list_downloads()?
            .into_iter()
            .find(|task| task.id == input.task_id);
        let Some(task) = task else {
            warn!(
                "Rust 播放进度未找到下载任务：task_id={}, file_index={:?}",
                input.task_id, input.file_index
            );
            return Ok(false);
        };

        let task_file = input
            .file_index
            .and_then(|index| task.files.iter().find(|file| file.index == index));
        let media_file = self.list_media_files()?.into_iter().find(|media| {
            media.download_task_id.as_deref() == Some(task.id.as_str())
                && task_file
                    .map(|file| {
                        media.file_name == file.name || media.file_path.ends_with(&file.name)
                    })
                    .unwrap_or(true)
        });
        let anime_id = media_file
            .as_ref()
            .map(|media| media.anime_id.as_str())
            .or(task.anime_id.as_deref());
        let Some(anime_id) = anime_id else {
            warn!("Rust 播放进度缺少番剧关联：task_id={}", input.task_id);
            return Ok(false);
        };
        let episode_id = media_file
            .as_ref()
            .and_then(|media| media.episode_id.as_deref())
            .or_else(|| task_file.and_then(|file| file.episode_id.as_deref()))
            .or(task.episode_id.as_deref());
        let episode_no = task_file
            .and_then(|file| file.episode_no)
            .or(task.episode_no);
        let episode = self.list_episodes(anime_id)?.into_iter().find(|episode| {
            episode_id == Some(episode.id.as_str()) || episode_no == Some(episode.episode_no)
        });
        let Some(mut episode) = episode else {
            warn!(
                "Rust 播放进度缺少单集关联：task_id={}, anime_id={}",
                input.task_id, anime_id
            );
            return Ok(false);
        };
        if episode.status != EpisodeStatus::Watched {
            episode.status = EpisodeStatus::Watched;
            upsert_episode_row(self.connection, &episode, &now_iso())?;
            info!(
                "Rust 播放进度已标记单集：task_id={}, episode_id={}, percent={}",
                input.task_id, episode.id, input.percent
            );
        }
        Ok(true)
    }

    /// 读取指定下载文件最近一次可靠的播放位置。
    pub fn get_playback_checkpoint(
        &self,
        task_id: &str,
        file_index: Option<i64>,
    ) -> Result<Option<PlaybackCheckpoint>, StorageError> {
        let file_index = normalize_checkpoint_file_index(file_index);
        self.connection
            .query_row(
                "SELECT * FROM playback_checkpoint WHERE task_id = ?1 AND file_index = ?2",
                params![task_id, file_index],
                map_playback_checkpoint_row,
            )
            .optional()
            .map_err(StorageError::from)
    }

    /// 校验并保存续播位置，首次跨过 90% 时同步已看状态。
    pub fn save_playback_checkpoint(
        &self,
        input: &SavePlaybackCheckpointInput,
    ) -> Result<PlaybackCheckpoint, StorageError> {
        let normalized = normalize_playback_checkpoint_input(input)?;
        let existing = self.get_playback_checkpoint(&normalized.task_id, normalized.file_index)?;
        let percent =
            calculate_playback_percent(normalized.position_seconds, normalized.duration_seconds);
        let mut watched_reported = existing
            .as_ref()
            .is_some_and(|checkpoint| checkpoint.watched_reported);
        if !watched_reported && percent >= 90.0 {
            watched_reported = self.report_playback_progress(&ReportPlaybackProgressInput {
                task_id: normalized.task_id.clone(),
                file_index: normalized.file_index,
                percent,
            })?;
        }
        let checkpoint = PlaybackCheckpoint {
            task_id: normalized.task_id,
            file_index: normalized.file_index,
            position_seconds: normalized.position_seconds,
            duration_seconds: normalized.duration_seconds,
            completed: normalized.completed.unwrap_or(false),
            watched_reported,
            updated_at: now_iso(),
        };
        self.connection.execute(
            "INSERT INTO playback_checkpoint (
               task_id, file_index, position_seconds, duration_seconds, completed, watched_reported, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(task_id, file_index) DO UPDATE SET
               position_seconds = excluded.position_seconds,
               duration_seconds = excluded.duration_seconds,
               completed = excluded.completed,
               watched_reported = excluded.watched_reported,
               updated_at = excluded.updated_at",
            params![
                &checkpoint.task_id,
                normalize_checkpoint_file_index(checkpoint.file_index),
                checkpoint.position_seconds,
                checkpoint.duration_seconds,
                i64::from(checkpoint.completed),
                i64::from(checkpoint.watched_reported),
                &checkpoint.updated_at,
            ],
        )?;
        info!(
            "Rust 续播位置保存完成：task_id={}, file_index={:?}, watched_reported={}",
            checkpoint.task_id, checkpoint.file_index, checkpoint.watched_reported
        );
        Ok(checkpoint)
    }

    /// 读取指定番剧的单集级偏好。
    pub fn list_episode_preferences(
        &self,
        anime_id: &str,
    ) -> Result<Vec<EpisodePreference>, StorageError> {
        query_all_with_params(
            self.connection,
            "SELECT * FROM episode_preference WHERE anime_id = ?1 ORDER BY episode_id",
            [anime_id],
            map_episode_preference_row,
        )
    }

    /// 新增或更新一条单集级偏好。
    pub fn upsert_episode_preference(
        &self,
        preference: &EpisodePreference,
    ) -> Result<Vec<EpisodePreference>, StorageError> {
        validate_identifier("preference.id", &preference.id)?;
        validate_identifier("preference.animeId", &preference.anime_id)?;
        validate_identifier("preference.episodeId", &preference.episode_id)?;
        let timestamp = now_iso();
        let transaction = self.connection.unchecked_transaction()?;
        upsert_episode_preference_row(&transaction, preference, &timestamp)?;
        transaction.commit()?;
        self.list_episode_preferences(&preference.anime_id)
    }

    /// 删除一条单集级偏好并返回同番剧剩余项。
    pub fn remove_episode_preference(
        &self,
        episode_id: &str,
    ) -> Result<Vec<EpisodePreference>, StorageError> {
        let anime_id = self
            .connection
            .query_row(
                "SELECT anime_id FROM episode_preference WHERE episode_id = ?1",
                [episode_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        self.connection.execute(
            "DELETE FROM episode_preference WHERE episode_id = ?1",
            [episode_id],
        )?;
        match anime_id {
            Some(anime_id) => self.list_episode_preferences(&anime_id),
            None => Ok(Vec::new()),
        }
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
        let episodes = self.list_all_episodes()?;
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

    /// 读取全部单集供跨番剧聚合。
    fn list_all_episodes(&self) -> Result<Vec<Episode>, StorageError> {
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

    /// 合并目录写入；指定月份时先移除该月未引用缓存。
    fn persist_anime_catalog(
        &self,
        items: &[Anime],
        replace_month: Option<(i64, i64)>,
    ) -> Result<AnimeCatalogWriteResult, StorageError> {
        let current = self.list_anime_catalog(None, None)?;
        let referenced_ids = self.read_referenced_anime_ids()?;
        let followed_ids = query_all(self.connection, "SELECT anime_id FROM my_anime", |row| {
            row.get::<_, String>(0)
        })?
        .into_iter()
        .collect::<HashSet<_>>();
        let mut catalog = match replace_month {
            Some((year, month)) => current
                .into_iter()
                .filter(|anime| {
                    anime.premiere_year != year
                        || anime.premiere_month != month
                        || referenced_ids.contains(&anime.id)
                })
                .collect::<Vec<_>>(),
            None => current,
        };
        let mut added_count = 0;
        let mut existing_count = 0;
        for item in items {
            validate_identifier("anime.id", &item.id)?;
            if item.title.trim().is_empty() {
                return invalid_input("anime.title", "番剧标题不能为空");
            }
            if let Some(index) = catalog
                .iter()
                .position(|existing| is_same_anime(existing, item))
            {
                let preserve_rating = followed_ids.contains(&catalog[index].id);
                catalog[index] = merge_anime(&catalog[index], item, preserve_rating);
                existing_count += 1;
            } else {
                catalog.push(item.clone());
                added_count += 1;
            }
        }

        let keep_ids = catalog
            .iter()
            .map(|anime| anime.id.clone())
            .chain(referenced_ids.iter().cloned())
            .collect::<HashSet<_>>();
        let delete_ids = query_all(self.connection, "SELECT id FROM anime_catalog", |row| {
            row.get::<_, String>(0)
        })?
        .into_iter()
        .filter(|id| !keep_ids.contains(id))
        .collect::<Vec<_>>();
        let timestamp = now_iso();
        let transaction = self.connection.unchecked_transaction()?;
        for id in &delete_ids {
            transaction.execute("DELETE FROM anime_catalog WHERE id = ?1", [id])?;
        }
        for anime in &catalog {
            upsert_anime_row(&transaction, anime, &timestamp)?;
        }
        transaction.commit()?;
        if let Some((year, month)) = replace_month {
            info!(
                "Rust 番剧月度目录替换完成：year={}, month={}, removed={}, collected={}, retained_referenced={}",
                year,
                month,
                delete_ids.len(),
                items.len(),
                referenced_ids.len()
            );
        }
        Ok(AnimeCatalogWriteResult {
            items: self.list_anime_catalog(None, None)?,
            added_count,
            existing_count,
        })
    }

    /// 读取不能随目录缓存清理的番剧标识。
    fn read_referenced_anime_ids(&self) -> Result<HashSet<String>, StorageError> {
        Ok(query_all(
            self.connection,
            "SELECT anime_id AS id FROM my_anime
             UNION SELECT anime_id AS id FROM episode
             UNION SELECT anime_id AS id FROM download_task WHERE anime_id IS NOT NULL
             UNION SELECT anime_id AS id FROM media_file WHERE anime_id IS NOT NULL",
            |row| row.get::<_, String>(0),
        )?
        .into_iter()
        .collect())
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

/// 读取带参数查询的全部结果。
fn query_all_with_params<T, P: Params>(
    connection: &Connection,
    sql: &str,
    params: P,
    mut mapper: impl FnMut(&Row<'_>) -> rusqlite::Result<T>,
) -> Result<Vec<T>, StorageError> {
    let mut statement = connection.prepare(sql)?;
    let rows = statement.query_map(params, |row| mapper(row))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(StorageError::from)
}

/// 写入番剧目录和规范化别名。
fn upsert_anime_row(
    connection: &Connection,
    anime: &Anime,
    timestamp: &str,
) -> Result<(), StorageError> {
    let external_ids_json =
        serde_json::to_string(&anime.external_ids).map_err(|source| StorageError::JsonData {
            context: "番剧外部标识",
            source,
        })?;
    let detail_json = serde_json::to_string(
        anime
            .detail
            .as_ref()
            .unwrap_or(&Value::Object(Default::default())),
    )
    .map_err(|source| StorageError::JsonData {
        context: "番剧详情",
        source,
    })?;
    connection.execute(
        "INSERT INTO anime_catalog (
           id, title, original_title, premiere_date, premiere_year, premiere_month, season, summary,
           cover_url, rating_score, rating_count, rating_source, external_ids_json, detail_json,
           created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?15)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title, original_title = excluded.original_title,
           premiere_date = excluded.premiere_date, premiere_year = excluded.premiere_year,
           premiere_month = excluded.premiere_month, season = excluded.season,
           summary = excluded.summary, cover_url = excluded.cover_url,
           rating_score = excluded.rating_score, rating_count = excluded.rating_count,
           rating_source = excluded.rating_source, external_ids_json = excluded.external_ids_json,
           detail_json = excluded.detail_json, updated_at = excluded.updated_at",
        params![
            &anime.id,
            anime.title.trim(),
            anime.original_title.as_deref(),
            anime.premiere_date.as_deref(),
            anime.premiere_year,
            anime.premiere_month,
            anime.season.as_deref(),
            anime.summary.as_deref(),
            anime.cover_url.as_deref(),
            anime.rating.as_ref().map(|rating| rating.score),
            anime.rating.as_ref().and_then(|rating| rating.count),
            anime.rating.as_ref().map(|rating| rating.source.as_str()),
            external_ids_json,
            detail_json,
            timestamp,
        ],
    )?;

    connection.execute("DELETE FROM anime_alias WHERE anime_id = ?1", [&anime.id])?;
    for alias in normalize_anime_aliases(anime) {
        connection.execute(
            "INSERT INTO anime_alias (id, anime_id, alias, language, priority)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                alias.id,
                alias.anime_id,
                alias.alias,
                alias_language_value(&alias.language),
                alias.priority,
            ],
        )?;
    }
    Ok(())
}

/// 写入追番规则并以当前草稿替换 RSS 订阅。
fn upsert_my_anime_row(
    connection: &Connection,
    item: &MyAnime,
    timestamp: &str,
) -> Result<(), StorageError> {
    let subtitle_languages = resolve_subtitle_languages(
        item.preferred_subtitle_languages.clone(),
        item.preferred_subtitle.as_deref(),
    );
    let subtitle_languages_json =
        serde_json::to_string(&subtitle_languages).map_err(|source| StorageError::JsonData {
            context: "追番字幕语言",
            source,
        })?;
    connection.execute(
        "INSERT INTO my_anime (
           id, anime_id, status, default_fansub_group_id, auto_download, download_dir,
           preferred_resolution, preferred_codec, preferred_subtitle,
           preferred_subtitle_languages_json, preferred_bit_depth, added_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
         ON CONFLICT(id) DO UPDATE SET
           anime_id = excluded.anime_id, status = excluded.status,
           default_fansub_group_id = excluded.default_fansub_group_id,
           auto_download = excluded.auto_download, download_dir = excluded.download_dir,
           preferred_resolution = excluded.preferred_resolution,
           preferred_codec = excluded.preferred_codec,
           preferred_subtitle = excluded.preferred_subtitle,
           preferred_subtitle_languages_json = excluded.preferred_subtitle_languages_json,
           preferred_bit_depth = excluded.preferred_bit_depth, updated_at = excluded.updated_at",
        params![
            &item.id,
            &item.anime.id,
            anime_status_value(&item.status),
            item.default_fansub_group_id.as_deref(),
            i64::from(item.auto_download),
            item.download_dir.as_deref(),
            item.preferred_resolution.as_deref(),
            item.preferred_codec.as_deref(),
            to_legacy_subtitle_preference(&subtitle_languages),
            subtitle_languages_json,
            item.preferred_bit_depth,
            &item.added_at,
            &item.updated_at,
        ],
    )?;
    if let Some(fansub_group_id) = item.default_fansub_group_id.as_deref() {
        connection.execute(
            "INSERT INTO anime_fansub_group (
               anime_id, fansub_group_id, first_seen_at, last_seen_at
             ) VALUES (?1, ?2, ?3, ?3)
             ON CONFLICT(anime_id, fansub_group_id) DO UPDATE SET last_seen_at = excluded.last_seen_at",
            params![&item.anime.id, fansub_group_id, timestamp],
        )?;
    }

    connection.execute(
        "DELETE FROM my_anime_rss_subscription WHERE my_anime_id = ?1",
        [&item.id],
    )?;
    for subscription in &item.rss_subscriptions {
        validate_identifier("rssSubscription.id", &subscription.id)?;
        let languages = resolve_subtitle_languages(
            subscription.preferred_subtitle_languages.clone(),
            subscription.preferred_subtitle.as_deref(),
        );
        let languages_json =
            serde_json::to_string(&languages).map_err(|source| StorageError::JsonData {
                context: "RSS 字幕语言",
                source,
            })?;
        let created_at = if subscription.created_at.trim().is_empty() {
            timestamp
        } else {
            &subscription.created_at
        };
        let updated_at = if subscription.updated_at.trim().is_empty() {
            timestamp
        } else {
            &subscription.updated_at
        };
        connection.execute(
            "INSERT INTO my_anime_rss_subscription (
               id, my_anime_id, name, url, enabled, preferred_subtitle,
               preferred_subtitle_languages_json, refresh_interval_minutes, last_fetched_at,
               created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                &subscription.id,
                &item.id,
                subscription.name.trim(),
                subscription.url.trim(),
                i64::from(subscription.enabled),
                to_legacy_subtitle_preference(&languages),
                languages_json,
                subscription.refresh_interval_minutes,
                subscription.last_fetched_at.as_deref(),
                created_at,
                updated_at,
            ],
        )?;
    }
    Ok(())
}

/// 写入一条单集记录并保留首次创建时间。
fn upsert_episode_row(
    connection: &Connection,
    episode: &Episode,
    timestamp: &str,
) -> Result<(), StorageError> {
    validate_episode(episode)?;
    connection.execute(
        "INSERT INTO episode (
           id, anime_id, episode_no, title, air_time, status, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
         ON CONFLICT(id) DO UPDATE SET
           anime_id = excluded.anime_id, episode_no = excluded.episode_no,
           title = excluded.title, air_time = excluded.air_time,
           status = excluded.status, updated_at = excluded.updated_at",
        params![
            &episode.id,
            &episode.anime_id,
            episode.episode_no,
            episode.title.as_deref(),
            episode.air_time.as_deref(),
            episode_status_value(&episode.status),
            timestamp,
        ],
    )?;
    Ok(())
}

/// 写入单集偏好并维护番剧与字幕组的发现关联。
fn upsert_episode_preference_row(
    connection: &Connection,
    preference: &EpisodePreference,
    timestamp: &str,
) -> Result<(), StorageError> {
    connection.execute(
        "INSERT INTO episode_preference (
           id, anime_id, episode_id, fansub_group_id, release_id, is_manual_override, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(episode_id) DO UPDATE SET
           id = excluded.id, anime_id = excluded.anime_id,
           fansub_group_id = excluded.fansub_group_id, release_id = excluded.release_id,
           is_manual_override = excluded.is_manual_override, updated_at = excluded.updated_at",
        params![
            &preference.id,
            &preference.anime_id,
            &preference.episode_id,
            preference.fansub_group_id.as_deref(),
            preference.release_id.as_deref(),
            i64::from(preference.is_manual_override),
            timestamp,
        ],
    )?;
    if let Some(fansub_group_id) = preference.fansub_group_id.as_deref() {
        connection.execute(
            "INSERT INTO anime_fansub_group (
               anime_id, fansub_group_id, first_seen_at, last_seen_at
             ) VALUES (?1, ?2, ?3, ?3)
             ON CONFLICT(anime_id, fansub_group_id) DO UPDATE SET last_seen_at = excluded.last_seen_at",
            params![&preference.anime_id, fansub_group_id, timestamp],
        )?;
    }
    Ok(())
}

/// 将 SQLite 单集偏好行映射为领域对象。
fn map_episode_preference_row(row: &Row<'_>) -> rusqlite::Result<EpisodePreference> {
    Ok(EpisodePreference {
        id: row.get("id")?,
        anime_id: row.get("anime_id")?,
        episode_id: row.get("episode_id")?,
        fansub_group_id: row.get("fansub_group_id")?,
        release_id: row.get("release_id")?,
        is_manual_override: row.get::<_, i64>("is_manual_override")? != 0,
    })
}

/// 将 SQLite 续播位置行映射为领域对象。
fn map_playback_checkpoint_row(row: &Row<'_>) -> rusqlite::Result<PlaybackCheckpoint> {
    let file_index = row.get::<_, i64>("file_index")?;
    Ok(PlaybackCheckpoint {
        task_id: row.get("task_id")?,
        file_index: (file_index >= 0).then_some(file_index),
        position_seconds: row.get("position_seconds")?,
        duration_seconds: row.get("duration_seconds")?,
        completed: row.get::<_, i64>("completed")? != 0,
        watched_reported: row.get::<_, i64>("watched_reported")? != 0,
        updated_at: row.get("updated_at")?,
    })
}

/// 根据单集状态和元数据生成观看进度摘要。
fn build_anime_watch_progress(item: &MyAnime, episodes: &[Episode]) -> AnimeWatchProgress {
    let known_episode_count = episodes
        .iter()
        .filter(|episode| is_positive_integer(episode.episode_no))
        .map(|episode| episode.episode_no as i64)
        .max()
        .unwrap_or_default();
    let watched_episode_count = episodes
        .iter()
        .filter(|episode| {
            episode.status == EpisodeStatus::Watched && is_positive_integer(episode.episode_no)
        })
        .map(|episode| episode.episode_no as i64)
        .max()
        .unwrap_or_default();
    let metadata_episode_count = item
        .anime
        .detail
        .as_ref()
        .and_then(|detail| detail.get("episodeCount"))
        .and_then(Value::as_i64)
        .filter(|count| *count > 0)
        .unwrap_or_default();
    AnimeWatchProgress {
        anime_id: item.anime.id.clone(),
        watched_episode_count,
        total_episode_count: metadata_episode_count
            .max(known_episode_count)
            .max(watched_episode_count),
    }
}

/// 取消已看时根据下载关联和放送时间恢复单集状态。
fn resolve_episode_status_after_unwatch(
    connection: &Connection,
    episode: &Episode,
) -> Result<EpisodeStatus, StorageError> {
    let rows = query_all_with_params(
        connection,
        "SELECT download_task.status, download_task.progress,
                torrent_file.progress AS file_progress
         FROM download_task
         LEFT JOIN torrent_file
           ON torrent_file.download_task_id = download_task.id
          AND torrent_file.selected = 1
          AND (torrent_file.episode_id = ?1 OR torrent_file.episode_no = ?2)
         WHERE download_task.anime_id = ?3
           AND (download_task.episode_id = ?1 OR download_task.episode_no = ?2 OR torrent_file.id IS NOT NULL)",
        params![&episode.id, episode.episode_no, &episode.anime_id],
        |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, f64>(1)?,
                row.get::<_, Option<f64>>(2)?,
            ))
        },
    )?;
    if rows.iter().any(|(status, progress, file_progress)| {
        !matches!(status.as_str(), "error" | "missing_files")
            && (matches!(status.as_str(), "completed" | "seeding")
                || progress.max(file_progress.unwrap_or_default()) >= 1.0)
    }) {
        return Ok(EpisodeStatus::Downloaded);
    }
    if rows.iter().any(|(status, progress, file_progress)| {
        matches!(
            status.as_str(),
            "queued"
                | "fetching_metadata"
                | "downloading"
                | "stalled"
                | "paused"
                | "checking"
                | "moving"
        ) && progress.max(file_progress.unwrap_or_default()) < 1.0
    }) {
        return Ok(EpisodeStatus::Downloading);
    }
    if episode
        .air_time
        .as_deref()
        .and_then(parse_timestamp)
        .is_some_and(|air_time| air_time > Utc::now())
    {
        return Ok(EpisodeStatus::Upcoming);
    }
    Ok(EpisodeStatus::Aired)
}

/// 校验并规范化续播写入参数。
fn normalize_playback_checkpoint_input(
    input: &SavePlaybackCheckpointInput,
) -> Result<SavePlaybackCheckpointInput, StorageError> {
    let task_id = input.task_id.trim();
    if task_id.is_empty()
        || task_id.len() > 160
        || !task_id
            .bytes()
            .all(|value| value.is_ascii_alphanumeric() || b"._:-".contains(&value))
    {
        return invalid_input("taskId", "下载任务标识格式无效");
    }
    if input.file_index.is_some_and(|index| index < 0) {
        return invalid_input("fileIndex", "播放文件索引必须是非负整数");
    }
    if !is_playback_seconds(input.position_seconds) || !is_playback_seconds(input.duration_seconds)
    {
        return invalid_input("playbackSeconds", "播放位置和时长必须是有效的非负秒数");
    }
    let position_seconds = if input.duration_seconds > 0.0 {
        input.position_seconds.min(input.duration_seconds)
    } else {
        input.position_seconds
    };
    Ok(SavePlaybackCheckpointInput {
        task_id: task_id.to_owned(),
        file_index: input.file_index,
        position_seconds,
        duration_seconds: input.duration_seconds,
        completed: Some(input.completed == Some(true)),
    })
}

/// 将播放位置换算为受限百分比。
fn calculate_playback_percent(position_seconds: f64, duration_seconds: f64) -> f64 {
    if !position_seconds.is_finite() || !duration_seconds.is_finite() || duration_seconds <= 0.0 {
        return 0.0;
    }
    (position_seconds / duration_seconds * 100.0).clamp(0.0, 100.0)
}

/// 判断秒数是否处于播放器允许持久化的范围。
fn is_playback_seconds(value: f64) -> bool {
    const MAX_PLAYBACK_SECONDS: f64 = 31.0 * 24.0 * 60.0 * 60.0;
    value.is_finite() && (0.0..=MAX_PLAYBACK_SECONDS).contains(&value)
}

/// 使用 -1 表示未指定文件索引，确保复合主键稳定去重。
fn normalize_checkpoint_file_index(file_index: Option<i64>) -> i64 {
    file_index.unwrap_or(-1)
}

/// 写库前按别名文本去重并重建番剧内稳定标识。
fn normalize_anime_aliases(anime: &Anime) -> Vec<AnimeAlias> {
    let mut aliases = Vec::<AnimeAlias>::new();
    let mut index_by_key = HashMap::<String, usize>::new();
    for alias in &anime.aliases {
        let value = alias.alias.trim();
        if value.is_empty() {
            continue;
        }
        let key = value.to_lowercase();
        if let Some(index) = index_by_key.get(&key).copied() {
            if alias.priority > aliases[index].priority {
                aliases[index] = AnimeAlias {
                    alias: value.to_owned(),
                    ..alias.clone()
                };
            }
            continue;
        }
        index_by_key.insert(key, aliases.len());
        aliases.push(AnimeAlias {
            alias: value.to_owned(),
            ..alias.clone()
        });
    }
    aliases
        .into_iter()
        .enumerate()
        .map(|(index, alias)| AnimeAlias {
            id: format!("{}-alias-{}", anime.id, index + 1),
            anime_id: anime.id.clone(),
            ..alias
        })
        .collect()
}

/// 将字幕语言集合转换为旧单值字段。
fn to_legacy_subtitle_preference(values: &[String]) -> Option<&str> {
    match values {
        [] => None,
        [value] => Some(value.as_str()),
        _ => Some("multi"),
    }
}

/// 校验业务标识符不为空且长度受限。
fn validate_identifier(field: &'static str, value: &str) -> Result<(), StorageError> {
    if value.trim().is_empty() || value.len() > 200 {
        return invalid_input(field, "标识不能为空且不能超过 200 个字符");
    }
    Ok(())
}

/// 校验单集标识、番剧关联和集数。
fn validate_episode(episode: &Episode) -> Result<(), StorageError> {
    validate_identifier("episode.id", &episode.id)?;
    validate_identifier("episode.animeId", &episode.anime_id)?;
    if !episode.episode_no.is_finite() || episode.episode_no <= 0.0 {
        return invalid_input("episode.episodeNo", "单集编号必须是正数");
    }
    Ok(())
}

/// 创建统一的业务输入错误。
fn invalid_input<T>(field: &'static str, message: &str) -> Result<T, StorageError> {
    Err(StorageError::InvalidInput {
        field,
        message: message.to_owned(),
    })
}

/// 判断集数是否为正整数。
fn is_positive_integer(value: f64) -> bool {
    value.is_finite() && value > 0.0 && value.fract() == 0.0
}

/// 为观看进度补建单集生成稳定标识。
fn create_download_episode_id(anime_id: &str, episode_no: i64) -> String {
    format!("episode-{anime_id}-{episode_no}")
}

/// 返回追番状态的 SQLite 字面量。
fn anime_status_value(status: &AnimeStatus) -> &'static str {
    match status {
        AnimeStatus::Watching => "watching",
        AnimeStatus::Planned => "planned",
        AnimeStatus::Completed => "completed",
        AnimeStatus::Paused => "paused",
        AnimeStatus::Dropped => "dropped",
    }
}

/// 返回单集状态的 SQLite 字面量。
fn episode_status_value(status: &EpisodeStatus) -> &'static str {
    match status {
        EpisodeStatus::Upcoming => "upcoming",
        EpisodeStatus::Aired => "aired",
        EpisodeStatus::Matched => "matched",
        EpisodeStatus::Downloading => "downloading",
        EpisodeStatus::Downloaded => "downloaded",
        EpisodeStatus::Watched => "watched",
    }
}

/// 返回番剧别名语言的 SQLite 字面量。
fn alias_language_value(language: &AnimeAliasLanguage) -> &'static str {
    match language {
        AnimeAliasLanguage::Zh => "zh",
        AnimeAliasLanguage::Ja => "ja",
        AnimeAliasLanguage::En => "en",
        AnimeAliasLanguage::Romaji => "romaji",
        AnimeAliasLanguage::Custom => "custom",
    }
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

/// 强制使用当前宿主拥有的数据目录，避免复制旧库后继续暴露 Electron 路径。
fn preserve_host_storage_paths(settings: &mut Value, platform_defaults: &Value) {
    let Some(default_storage) = platform_defaults.get("storage").cloned() else {
        return;
    };
    if let Some(settings) = settings.as_object_mut() {
        settings.insert("storage".to_owned(), default_storage);
    }
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

/// 按季度和标题排序番剧目录。
fn sort_anime_catalog(items: &mut [Anime]) {
    items.sort_by(|left, right| {
        right
            .premiere_year
            .cmp(&left.premiere_year)
            .then_with(|| right.premiere_month.cmp(&left.premiere_month))
            .then_with(|| left.title.cmp(&right.title))
    });
}

/// 根据 ID、同来源外部 ID 或标题判断两条目录记录是否相同。
fn is_same_anime(left: &Anime, right: &Anime) -> bool {
    if left.id == right.id {
        return true;
    }
    let shared_external_id = right.external_ids.as_object().is_some_and(|right_ids| {
        left.external_ids.as_object().is_some_and(|left_ids| {
            right_ids
                .iter()
                .any(|(key, value)| left_ids.get(key) == Some(value))
        })
    });
    if shared_external_id {
        return true;
    }
    let left_titles = [Some(left.title.as_str()), left.original_title.as_deref()];
    let right_titles = [Some(right.title.as_str()), right.original_title.as_deref()];
    left_titles.into_iter().flatten().any(|left_title| {
        right_titles
            .into_iter()
            .flatten()
            .any(|right_title| left_title == right_title)
    })
}

/// 以新采集字段为主合并目录记录，同时保持已有稳定标识和业务保护字段。
fn merge_anime(existing: &Anime, incoming: &Anime, preserve_rating: bool) -> Anime {
    Anime {
        id: existing.id.clone(),
        title: incoming.title.clone(),
        original_title: incoming
            .original_title
            .clone()
            .or_else(|| existing.original_title.clone()),
        aliases: merge_anime_aliases(&existing.aliases, &incoming.aliases, &existing.id),
        premiere_date: incoming
            .premiere_date
            .clone()
            .or_else(|| existing.premiere_date.clone()),
        premiere_year: incoming.premiere_year,
        premiere_month: incoming.premiere_month,
        season: incoming.season.clone().or_else(|| existing.season.clone()),
        summary: incoming
            .summary
            .clone()
            .or_else(|| existing.summary.clone()),
        cover_url: incoming
            .cover_url
            .clone()
            .or_else(|| existing.cover_url.clone()),
        rating: if preserve_rating {
            existing.rating.clone().or_else(|| incoming.rating.clone())
        } else {
            incoming.rating.clone().or_else(|| existing.rating.clone())
        },
        external_ids: merge_json_objects(&existing.external_ids, &incoming.external_ids),
        detail: merge_optional_json_objects(existing.detail.as_ref(), incoming.detail.as_ref()),
    }
}

/// 合并别名并忽略大小写重复项。
fn merge_anime_aliases(
    existing: &[AnimeAlias],
    incoming: &[AnimeAlias],
    anime_id: &str,
) -> Vec<AnimeAlias> {
    let mut aliases = existing.to_vec();
    for alias in incoming {
        if !aliases
            .iter()
            .any(|item| item.alias.eq_ignore_ascii_case(&alias.alias))
        {
            aliases.push(AnimeAlias {
                anime_id: anime_id.to_owned(),
                ..alias.clone()
            });
        }
    }
    aliases
}

/// 浅合并两个 JSON 对象，非对象值由新值覆盖。
fn merge_json_objects(existing: &Value, incoming: &Value) -> Value {
    match (existing.as_object(), incoming.as_object()) {
        (Some(existing), Some(incoming)) => {
            let mut merged = existing.clone();
            merged.extend(incoming.clone());
            Value::Object(merged)
        }
        _ => incoming.clone(),
    }
}

/// 合并可选详情对象并保留任一侧已有字段。
fn merge_optional_json_objects(
    existing: Option<&Value>,
    incoming: Option<&Value>,
) -> Option<Value> {
    match (existing, incoming) {
        (Some(existing), Some(incoming)) => Some(merge_json_objects(existing, incoming)),
        (Some(existing), None) => Some(existing.clone()),
        (None, Some(incoming)) => Some(incoming.clone()),
        (None, None) => None,
    }
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

struct FansubGroupRow {
    id: String,
    name: String,
    aliases_json: String,
    source_ids_json: String,
}

impl FansubGroupRow {
    /// 将 SQLite 字幕组行转换为领域对象。
    fn into_domain(self) -> Result<FansubGroup, StorageError> {
        Ok(FansubGroup {
            id: self.id,
            name: self.name,
            aliases: parse_json(&self.aliases_json, "字幕组别名")?,
            source_ids: parse_json(&self.source_ids_json, "字幕组来源")?,
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

/// 映射 SQLite 字幕组行。
fn map_fansub_group_row(row: &Row<'_>) -> rusqlite::Result<FansubGroupRow> {
    Ok(FansubGroupRow {
        id: row.get("id")?,
        name: row.get("name")?,
        aliases_json: row.get("aliases_json")?,
        source_ids_json: row.get("source_ids_json")?,
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
