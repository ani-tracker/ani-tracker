use std::collections::HashSet;
use std::sync::Arc;
use std::time::{Duration, Instant};

use ani_domain::{
    Anime, AnimeDiscoverySeasonQuery, AnimeDiscoverySeasonResult, AnimeSeasonSyncState,
};
use ani_repository::{
    AnimeCatalogRepository, AnimeCatalogWriteResult, ReleaseSourceRepository, RepositoryResult,
};
use ani_sources::{AnimeMetadataService, CircuitStateStore, SourceError, SourceNetworkService};
use chrono::{DateTime, SecondsFormat, Utc};

const DETAIL_COMPENSATION_MAX_ATTEMPTS: usize = 3;
const DETAIL_COMPENSATION_MIN_DELAY_MS: u64 = 500;
const DETAIL_COMPENSATION_MAX_DELAY_MS: u64 = 120_500;

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

    /// 替换指定月份中未引用的目录缓存。
    fn replace_season_catalog_month(
        &self,
        year: i64,
        month: i64,
        items: &[Anime],
    ) -> RepositoryResult<AnimeCatalogWriteResult>;

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

    fn replace_season_catalog_month(
        &self,
        year: i64,
        month: i64,
        items: &[Anime],
    ) -> RepositoryResult<AnimeCatalogWriteResult> {
        AnimeCatalogRepository::replace_anime_catalog_month(self, year, month, items)
    }

    fn list_season_catalog_month(&self, year: i64, month: i64) -> RepositoryResult<Vec<Anime>> {
        AnimeCatalogRepository::list_anime_catalog(self, Some(year), Some(month))
    }
}

/// 复用同一季度采集与持久化流程，支持交互和后台独立网络通道。
pub struct AnimeDiscoverySyncService {
    collector: AnimeMetadataService,
}

/// 一批季度详情补全及持久化结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AnimeDiscoveryDetailBatchResult {
    pub completed_count: usize,
    pub error_count: usize,
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

    /// 完整同步一个季度，供需要等待详情的兼容调用复用。
    pub async fn sync_season<S>(
        &self,
        store: &S,
        query: AnimeDiscoverySeasonQuery,
        now: Option<DateTime<Utc>>,
    ) -> Result<AnimeDiscoverySeasonResult, SourceError>
    where
        S: AnimeDiscoverySyncStore + Sync,
    {
        let mut result = self.sync_season_catalog(store, query, now).await?;
        if !result.items.is_empty() {
            let detail = self.enrich_detail_batch(store, &result.items).await?;
            if detail.error_count > 0 {
                result.errors.push(format!(
                    "details: {} 个来源详情补全失败",
                    detail.error_count
                ));
            }
            let months = months_for_season(&result.query.season)?;
            result.items.clear();
            for month in months {
                result
                    .items
                    .extend(store.list_season_catalog_month(result.query.year, month)?);
            }
        }
        Ok(result)
    }

    /// 采集并替换季度基础目录；仅 AniList 成功才写入季度完成标记。
    pub async fn sync_season_catalog<S>(
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
            .collect_season_catalog(store, query.year, &query.season)
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
        let mut added_count = 0usize;
        let mut existing_count = 0usize;
        let catalog_write_started = Instant::now();
        if !collected.items.is_empty() {
            for month in months {
                let month_items = collected
                    .items
                    .iter()
                    .filter(|item| item.premiere_year == query.year && item.premiere_month == month)
                    .cloned()
                    .collect::<Vec<_>>();
                if month_items.is_empty() {
                    continue;
                }
                let month_write_started = Instant::now();
                let persisted =
                    store.replace_season_catalog_month(query.year, month, &month_items)?;
                log::info!(
                    "Rust 新番阶段耗时 phase=sqlite-catalog-write year={} month={} items={} added={} existing={} duration_ms={}",
                    query.year,
                    month,
                    month_items.len(),
                    persisted.added_count,
                    persisted.existing_count,
                    month_write_started.elapsed().as_millis()
                );
                added_count = added_count.saturating_add(persisted.added_count);
                existing_count = existing_count.saturating_add(persisted.existing_count);
            }
        }
        log::info!(
            "Rust 新番阶段耗时 phase=sqlite-catalog-write-total year={} season={} items={} duration_ms={}",
            query.year,
            query.season,
            collected.items.len(),
            catalog_write_started.elapsed().as_millis()
        );

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

        let catalog_read_started = Instant::now();
        let mut items = Vec::new();
        for month in months {
            items.extend(store.list_season_catalog_month(query.year, month)?);
        }
        log::info!(
            "Rust 新番阶段耗时 phase=sqlite-catalog-read year={} season={} items={} duration_ms={}",
            query.year,
            query.season,
            items.len(),
            catalog_read_started.elapsed().as_millis()
        );
        if collected.items.is_empty() {
            existing_count = items.len();
        }
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

    /// 补全一批目录详情并增量写回，不替换其他月份缓存。
    pub async fn enrich_detail_batch<S>(
        &self,
        store: &S,
        items: &[Anime],
    ) -> Result<AnimeDiscoveryDetailBatchResult, SourceError>
    where
        S: AnimeDiscoverySyncStore + Sync,
    {
        let mut pending = items.to_vec();
        let mut error_count = 0usize;
        for attempt in 1..=DETAIL_COMPENSATION_MAX_ATTEMPTS {
            let collected = self.collector.enrich_details(store, &pending).await;
            if !collected.items.is_empty() {
                let detail_write_started = Instant::now();
                let persisted = store.save_season_catalog(&collected.items)?;
                log::info!(
                    "Rust 新番阶段耗时 phase=sqlite-detail-write attempt={attempt} items={} added={} existing={} duration_ms={}",
                    collected.items.len(),
                    persisted.added_count,
                    persisted.existing_count,
                    detail_write_started.elapsed().as_millis()
                );
            }
            error_count = error_count.saturating_add(collected.settled_error_count);
            if collected.retryable_item_ids.is_empty() {
                log::info!(
                    "Rust 新番季度详情批次完成：count={}, errors={}, attempts={attempt}",
                    items.len(),
                    error_count
                );
                return Ok(AnimeDiscoveryDetailBatchResult {
                    completed_count: items.len(),
                    error_count,
                });
            }
            if attempt == DETAIL_COMPENSATION_MAX_ATTEMPTS {
                error_count = error_count.saturating_add(collected.deferred_error_count);
                log::warn!(
                    "Rust 新番季度详情补偿耗尽：count={}, deferred={}, errors={}",
                    pending.len(),
                    collected.retryable_item_ids.len(),
                    error_count
                );
                break;
            }

            let retryable_ids = collected
                .retryable_item_ids
                .into_iter()
                .collect::<HashSet<_>>();
            pending.retain(|item| retryable_ids.contains(&item.id));
            let delay_ms = collected.retry_after_ms.clamp(
                DETAIL_COMPENSATION_MIN_DELAY_MS,
                DETAIL_COMPENSATION_MAX_DELAY_MS,
            );
            log::warn!(
                "Rust 新番季度详情批次暂停补偿：attempt={attempt}, deferred={}, delay_ms={delay_ms}",
                pending.len()
            );
            tokio::time::sleep(Duration::from_millis(delay_ms)).await;
        }

        log::info!(
            "Rust 新番季度详情批次完成：count={}, errors={}, attempts={}",
            items.len(),
            error_count,
            DETAIL_COMPENSATION_MAX_ATTEMPTS
        );
        Ok(AnimeDiscoveryDetailBatchResult {
            completed_count: items.len(),
            error_count,
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
