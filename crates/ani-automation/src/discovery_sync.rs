use std::sync::Arc;

use ani_domain::{
    Anime, AnimeDiscoverySeasonQuery, AnimeDiscoverySeasonResult, AnimeSeasonSyncState,
};
use ani_repository::{
    AnimeCatalogRepository, AnimeCatalogWriteResult, ReleaseSourceRepository, RepositoryResult,
};
use ani_sources::{AnimeMetadataService, CircuitStateStore, SourceError, SourceNetworkService};
use chrono::{DateTime, SecondsFormat, Utc};

/// 新番季度同步所需的目录与网络状态窄端口。
pub trait AnimeDiscoverySyncStore: CircuitStateStore {
    /// 读取指定季度同步状态。
    fn get_season_sync_state(
        &self,
        year: i64,
        season: &str,
    ) -> RepositoryResult<Option<AnimeSeasonSyncState>>;

    /// 保存指定季度同步状态。
    fn save_season_sync_state(&self, state: &AnimeSeasonSyncState) -> RepositoryResult<()>;

    /// 合并采集到的季度目录。
    fn save_season_catalog(&self, items: &[Anime]) -> RepositoryResult<AnimeCatalogWriteResult>;

    /// 读取指定月份目录。
    fn list_season_catalog_month(&self, year: i64, month: i64) -> RepositoryResult<Vec<Anime>>;
}

impl<T> AnimeDiscoverySyncStore for T
where
    T: AnimeCatalogRepository + ReleaseSourceRepository,
{
    fn get_season_sync_state(
        &self,
        year: i64,
        season: &str,
    ) -> RepositoryResult<Option<AnimeSeasonSyncState>> {
        AnimeCatalogRepository::get_anime_season_sync_state(self, year, season)
    }

    fn save_season_sync_state(&self, state: &AnimeSeasonSyncState) -> RepositoryResult<()> {
        AnimeCatalogRepository::upsert_anime_season_sync_state(self, state)
    }

    fn save_season_catalog(&self, items: &[Anime]) -> RepositoryResult<AnimeCatalogWriteResult> {
        AnimeCatalogRepository::upsert_anime_catalog(self, items)
    }

    fn list_season_catalog_month(&self, year: i64, month: i64) -> RepositoryResult<Vec<Anime>> {
        AnimeCatalogRepository::list_anime_catalog(self, Some(year), Some(month))
    }
}

/// 复用同一季度采集与持久化流程，支持交互和后台独立网络通道。
pub struct AnimeDiscoverySyncService {
    collector: AnimeMetadataService,
}

impl AnimeDiscoverySyncService {
    /// 创建手动采集服务。
    pub fn new(network: Arc<SourceNetworkService>) -> Self {
        Self {
            collector: AnimeMetadataService::new(network),
        }
    }

    /// 创建后台采集服务，避免采集间隔阻塞用户搜索。
    pub fn new_background(network: Arc<SourceNetworkService>) -> Self {
        Self {
            collector: AnimeMetadataService::new_background(network),
        }
    }

    /// 采集、合并并记录一个季度；仅 AniList 成功才写入季度完成标记。
    pub async fn sync_season<S>(
        &self,
        store: &S,
        query: AnimeDiscoverySeasonQuery,
        now: Option<DateTime<Utc>>,
    ) -> Result<AnimeDiscoverySeasonResult, SourceError>
    where
        S: AnimeDiscoverySyncStore + Sync,
    {
        let months = months_for_season(&query.season)?;
        let now = now.unwrap_or_else(Utc::now);
        let attempt_at = to_iso(now);
        let mut state = store
            .get_season_sync_state(query.year, &query.season)?
            .unwrap_or_else(|| AnimeSeasonSyncState {
                year: query.year,
                season: query.season.clone(),
                last_attempt_at: None,
                last_successful_sync_at: None,
                completed_at: None,
                last_anilist_error: None,
            });
        state.last_attempt_at = Some(attempt_at.clone());
        store.save_season_sync_state(&state)?;

        let collected = self
            .collector
            .collect_season(store, query.year, &query.season)
            .await?;
        for error in &collected.errors {
            log::warn!(
                "Rust 新番季度来源采集失败：year={}, season={}, error={}",
                query.year,
                query.season,
                error
            );
        }

        let anilist_succeeded = collected
            .successful_sources
            .iter()
            .any(|source| source == "anilist");
        let anilist_error = collected
            .errors
            .iter()
            .find(|error| error.starts_with("anilist:"))
            .cloned();
        let persisted = if collected.items.is_empty() {
            None
        } else {
            Some(store.save_season_catalog(&collected.items)?)
        };

        if anilist_succeeded {
            state.last_successful_sync_at = Some(attempt_at.clone());
            state.completed_at.get_or_insert(attempt_at);
            state.last_anilist_error = None;
        } else {
            state.last_anilist_error = anilist_error
                .clone()
                .or_else(|| Some("anilist: 未返回新番数据".to_owned()));
        }
        store.save_season_sync_state(&state)?;

        let (mut items, added_count, existing_count) = match persisted {
            Some(result) => (result.items, result.added_count, result.existing_count),
            None => {
                let mut existing = Vec::new();
                for month in months {
                    existing.extend(store.list_season_catalog_month(query.year, month)?);
                }
                let existing_count = existing.len();
                (existing, 0, existing_count)
            }
        };
        items.retain(|item| {
            item.premiere_year == query.year && months.contains(&item.premiere_month)
        });
        log::info!(
            "Rust 新番季度同步完成：year={}, season={}, items={}, added={}, anilist_succeeded={}",
            query.year,
            query.season,
            items.len(),
            added_count,
            anilist_succeeded
        );
        Ok(AnimeDiscoverySeasonResult {
            query,
            items,
            added_count,
            existing_count,
            source: collected.source,
            errors: collected.errors,
        })
    }
}

/// 返回季度对应的三个自然月。
pub fn months_for_season(season: &str) -> Result<[i64; 3], SourceError> {
    match season {
        "winter" => Ok([1, 2, 3]),
        "spring" => Ok([4, 5, 6]),
        "summer" => Ok([7, 8, 9]),
        "fall" => Ok([10, 11, 12]),
        _ => Err(SourceError::Parse(format!("季度无效：{season}"))),
    }
}

/// 将 UTC 时间序列化为毫秒精度 ISO 字符串。
fn to_iso(value: DateTime<Utc>) -> String {
    value.to_rfc3339_opts(SecondsFormat::Millis, true)
}
