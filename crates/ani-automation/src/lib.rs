use std::collections::HashMap;
use std::sync::Arc;

use ani_domain::{
    AnimeSourceBinding, FansubGroup, MyAnime, NotificationKind, NotificationRecord,
    NotificationSeverity, Release, ReleaseSourceConfig, ReleaseSourceSyncState,
    RequestCircuitState, SourceSyncError, SourceSyncRunResult,
};
use ani_repository::{
    AnimeCatalogRepository, AnimeSourceBindingRepository, AnimeTrackingRepository,
    NotificationRepository, ReleaseCacheRepository, ReleaseSourceRepository, RepositoryResult,
};
use ani_sources::{
    is_supported_source, ReleaseSearchService, ReleaseSearchStore, SourceError,
    SourceNetworkService,
};
use chrono::{DateTime, Datelike, Duration, Local, SecondsFormat, Utc};
use futures_util::future::join_all;

mod discovery_sync;
mod episode_sync;
mod reminder;
mod scan;

pub use discovery_sync::{
    months_for_season, AnimeDiscoveryDetailBatchResult, AnimeDiscoverySyncService,
    AnimeDiscoverySyncStore,
};
pub use episode_sync::{EpisodeSyncResult, EpisodeSyncService, EpisodeSyncStore};
pub use reminder::{DailyReminderService, DailyReminderStore};
pub use scan::{
    build_automation_notifications, AutomaticDownloadExecutor, AutomaticDownloadReceipt,
    AutomaticDownloadRequest, AutomationDownloadReference, AutomationRunOptions,
    AutomationRunService, AutomationScanStore,
};

const CACHE_RETENTION_DAYS: i64 = 90;
const RELEASE_SOURCE_CIRCUIT_GROUP: &str = "release-source-background";

/// 来源同步运行参数。
#[derive(Debug, Clone, Default)]
pub struct SourceSyncRunOptions {
    pub force: bool,
    pub now: Option<DateTime<Utc>>,
}

/// 来源同步依赖的最小持久化端口。
pub trait SourceSyncStore: ReleaseSearchStore {
    /// 读取全部来源同步游标。
    fn list_sync_states(&self) -> RepositoryResult<Vec<ReleaseSourceSyncState>>;

    /// 保存一个来源同步游标。
    fn save_sync_state(&self, state: &ReleaseSourceSyncState) -> RepositoryResult<()>;

    /// 读取全部追番。
    fn list_sync_anime(&self) -> RepositoryResult<Vec<MyAnime>>;

    /// 读取指定番剧的已确认来源绑定。
    fn list_sync_bindings(&self, anime_id: &str) -> RepositoryResult<Vec<AnimeSourceBinding>>;

    /// 保存同步采集的资源。
    fn save_synced_releases(&self, releases: &[Release]) -> RepositoryResult<usize>;

    /// 观察并合并番剧字幕组。
    fn observe_sync_fansubs(
        &self,
        anime_id: &str,
        releases: &[Release],
    ) -> RepositoryResult<Vec<FansubGroup>>;

    /// 清理过期资源缓存。
    fn prune_synced_releases(&self, before: &str) -> RepositoryResult<usize>;

    /// 写入同步失败通知。
    fn add_sync_notifications(
        &self,
        records: &[NotificationRecord],
    ) -> RepositoryResult<Vec<NotificationRecord>>;
}

impl<T> SourceSyncStore for T
where
    T: ReleaseSearchStore
        + ReleaseSourceRepository
        + ReleaseCacheRepository
        + AnimeTrackingRepository
        + AnimeSourceBindingRepository
        + AnimeCatalogRepository
        + NotificationRepository,
{
    /// 将完整 Repository 组合适配为来源同步端口。
    fn list_sync_states(&self) -> RepositoryResult<Vec<ReleaseSourceSyncState>> {
        ReleaseSourceRepository::list_source_sync_states(self)
    }

    /// 将完整 Repository 组合适配为来源同步端口。
    fn save_sync_state(&self, state: &ReleaseSourceSyncState) -> RepositoryResult<()> {
        ReleaseSourceRepository::upsert_source_sync_state(self, state)
    }

    /// 将完整 Repository 组合适配为来源同步端口。
    fn list_sync_anime(&self) -> RepositoryResult<Vec<MyAnime>> {
        AnimeTrackingRepository::list_my_anime(self)
    }

    /// 将完整 Repository 组合适配为来源同步端口。
    fn list_sync_bindings(&self, anime_id: &str) -> RepositoryResult<Vec<AnimeSourceBinding>> {
        AnimeSourceBindingRepository::list_anime_source_bindings(self, anime_id)
    }

    /// 将完整 Repository 组合适配为来源同步端口。
    fn save_synced_releases(&self, releases: &[Release]) -> RepositoryResult<usize> {
        ReleaseCacheRepository::upsert_cached_releases(self, releases)
    }

    /// 将完整 Repository 组合适配为来源同步端口。
    fn observe_sync_fansubs(
        &self,
        anime_id: &str,
        releases: &[Release],
    ) -> RepositoryResult<Vec<FansubGroup>> {
        AnimeCatalogRepository::observe_anime_fansubs(self, anime_id, releases)
    }

    /// 将完整 Repository 组合适配为来源同步端口。
    fn prune_synced_releases(&self, before: &str) -> RepositoryResult<usize> {
        ReleaseCacheRepository::prune_cached_releases(self, before)
    }

    /// 将完整 Repository 组合适配为来源同步端口。
    fn add_sync_notifications(
        &self,
        records: &[NotificationRecord],
    ) -> RepositoryResult<Vec<NotificationRecord>> {
        NotificationRepository::add_notifications(self, records)
    }
}

/// 执行来源条件请求、增量缓存、失败隔离和提醒写入。
pub struct SourceSyncService {
    collector: ReleaseSearchService,
}

impl SourceSyncService {
    /// 创建复用来源网络连接池的同步服务。
    pub fn new(network: Arc<SourceNetworkService>) -> Self {
        Self {
            collector: ReleaseSearchService::new_background(network),
        }
    }

    /// 对所有启用来源执行一次增量同步。
    pub async fn run<S>(
        &self,
        store: &S,
        sources: &[ReleaseSourceConfig],
        options: SourceSyncRunOptions,
    ) -> Result<SourceSyncRunResult, SourceError>
    where
        S: SourceSyncStore + Sync,
    {
        let now = options.now.unwrap_or_else(Utc::now);
        let started_at = to_iso(now);
        let states = store.list_sync_states()?;
        let state_by_source_id = states
            .into_iter()
            .map(|state| (state.source_id.clone(), state))
            .collect::<HashMap<_, _>>();
        let tracked_anime = store.list_sync_anime()?;
        let bindings = tracked_anime
            .iter()
            .map(|item| store.list_sync_bindings(&item.anime.id))
            .collect::<RepositoryResult<Vec<_>>>()?
            .into_iter()
            .flatten()
            .collect::<Vec<_>>();
        let candidates = sources
            .iter()
            .filter(|source| source.enabled && is_supported_source(source))
            .collect::<Vec<_>>();
        let tracked_anime = &tracked_anime;
        let bindings = &bindings;
        let force = options.force;
        let outcomes = join_all(candidates.iter().map(|source| {
            let state = state_by_source_id
                .get(&source.id)
                .cloned()
                .unwrap_or_else(|| empty_sync_state(&source.id));
            async move {
                if !force && is_same_local_day(state.last_successful_sync_at.as_deref(), now) {
                    return SourceOutcome::Skipped(source.id.clone());
                }
                self.sync_source(store, source, state, tracked_anime, bindings, now)
                    .await
            }
        }))
        .await;

        let mut result = SourceSyncRunResult {
            started_at,
            finished_at: to_iso(Utc::now()),
            synced_source_ids: Vec::new(),
            skipped_source_ids: Vec::new(),
            added_release_count: 0,
            errors: Vec::new(),
        };
        for outcome in outcomes {
            match outcome {
                SourceOutcome::Synced {
                    source_id,
                    added_count,
                } => {
                    result.synced_source_ids.push(source_id);
                    result.added_release_count += added_count;
                }
                SourceOutcome::Skipped(source_id) => {
                    result.skipped_source_ids.push(source_id);
                }
                SourceOutcome::Failed(error) => result.errors.push(error),
            }
        }

        let retention_before = to_iso(now - Duration::days(CACHE_RETENTION_DAYS));
        let pruned_count = store.prune_synced_releases(&retention_before)?;
        self.add_failure_notification(store, sources, &result)?;
        log::info!(
            "Rust 来源增量同步完成：synced={}, skipped={}, added={}, failed={}, pruned={}",
            result.synced_source_ids.len(),
            result.skipped_source_ids.len(),
            result.added_release_count,
            result.errors.len(),
            pruned_count
        );
        Ok(result)
    }

    /// 同步单个来源，并将来源失败收敛为可合并结果。
    async fn sync_source<S>(
        &self,
        store: &S,
        source: &ReleaseSourceConfig,
        mut state: ReleaseSourceSyncState,
        tracked_anime: &[MyAnime],
        bindings: &[AnimeSourceBinding],
        now: DateTime<Utc>,
    ) -> SourceOutcome
    where
        S: SourceSyncStore + Sync,
    {
        let attempt_at = to_iso(now);
        state.last_sync_attempt_at = Some(attempt_at.clone());
        if let Err(error) = store.save_sync_state(&state) {
            return SourceOutcome::Failed(SourceSyncError {
                source_id: source.id.clone(),
                message: error.to_string(),
            });
        }

        match self
            .collector
            .collect_source_for_sync(store, source, tracked_anime, bindings, &state)
            .await
        {
            Ok(fetched) => {
                let added_count = match store.save_synced_releases(&fetched.releases) {
                    Ok(count) => count,
                    Err(error) => {
                        return self.record_failure(
                            store,
                            source,
                            state,
                            attempt_at,
                            error.to_string(),
                        )
                    }
                };
                for (anime_id, releases) in releases_by_anime(&fetched.releases) {
                    if let Err(error) = store.observe_sync_fansubs(&anime_id, &releases) {
                        return self.record_failure(
                            store,
                            source,
                            state,
                            attempt_at,
                            error.to_string(),
                        );
                    }
                }
                state.last_sync_attempt_at = Some(attempt_at.clone());
                state.last_successful_sync_at = Some(attempt_at);
                state.last_sync_error = None;
                state.etag = fetched.etag.or(state.etag);
                state.last_modified = fetched.last_modified.or(state.last_modified);
                if let Err(error) = store.save_sync_state(&state) {
                    return SourceOutcome::Failed(SourceSyncError {
                        source_id: source.id.clone(),
                        message: error.to_string(),
                    });
                }
                log::info!(
                    "Rust 单来源同步完成：source_id={}, count={}, added={}, not_modified={}",
                    source.id,
                    fetched.releases.len(),
                    added_count,
                    fetched.not_modified
                );
                SourceOutcome::Synced {
                    source_id: source.id.clone(),
                    added_count,
                }
            }
            Err(error) => {
                let message =
                    preserve_root_cause(&error.to_string(), state.last_sync_error.as_deref());
                self.record_failure(store, source, state, attempt_at, message)
            }
        }
    }

    /// 保存单来源失败游标，并保留原始失败作为结果。
    fn record_failure<S>(
        &self,
        store: &S,
        source: &ReleaseSourceConfig,
        mut state: ReleaseSourceSyncState,
        attempt_at: String,
        message: String,
    ) -> SourceOutcome
    where
        S: SourceSyncStore + Sync,
    {
        state.last_sync_attempt_at = Some(attempt_at);
        state.last_sync_error = Some(message.clone());
        if let Err(error) = store.save_sync_state(&state) {
            log::error!(
                "Rust 来源同步失败状态保存失败：source_id={}, error={}",
                source.id,
                error
            );
        }
        log::warn!(
            "Rust 单来源同步失败：source_id={}, error={}",
            source.id,
            message
        );
        SourceOutcome::Failed(SourceSyncError {
            source_id: source.id.clone(),
            message,
        })
    }

    /// 将失败来源、根因和熔断状态写入提醒中心。
    fn add_failure_notification<S>(
        &self,
        store: &S,
        sources: &[ReleaseSourceConfig],
        result: &SourceSyncRunResult,
    ) -> Result<(), SourceError>
    where
        S: SourceSyncStore + Sync,
    {
        if result.errors.is_empty() {
            return Ok(());
        }
        let source_by_id = sources
            .iter()
            .map(|source| (source.id.as_str(), source))
            .collect::<HashMap<_, _>>();
        let mut details = Vec::new();
        for error in &result.errors {
            let source = source_by_id.get(error.source_id.as_str()).copied();
            let circuit_key = format!("{RELEASE_SOURCE_CIRCUIT_GROUP}:{}", error.source_id);
            let circuit = store.get_circuit_state(&circuit_key)?;
            details.push(format_sync_failure(error, source, circuit.as_ref()));
        }
        let title = if result.errors.len() == 1 {
            let error = &result.errors[0];
            format!(
                "{} 同步失败",
                source_by_id
                    .get(error.source_id.as_str())
                    .map_or(error.source_id.as_str(), |source| source.name.as_str())
            )
        } else {
            format!("{} 个下载源同步失败", result.errors.len())
        };
        let record = NotificationRecord {
            id: format!("source-sync-{}", result.finished_at),
            kind: NotificationKind::System,
            title,
            body: details.join("\n"),
            severity: NotificationSeverity::Warning,
            anime_id: None,
            episode_id: None,
            download_task_id: None,
            created_at: result.finished_at.clone(),
            read_at: None,
        };
        store.add_sync_notifications(&[record])?;
        Ok(())
    }
}

enum SourceOutcome {
    Synced {
        source_id: String,
        added_count: usize,
    },
    Skipped(String),
    Failed(SourceSyncError),
}

/// 返回指定时间是否与当前时刻处于本地同一天。
pub fn is_same_local_day(value: Option<&str>, now: DateTime<Utc>) -> bool {
    let Some(value) = value else {
        return false;
    };
    let Ok(parsed) = DateTime::parse_from_rfc3339(value) else {
        return false;
    };
    let left = parsed.with_timezone(&Local);
    let right = now.with_timezone(&Local);
    left.year() == right.year() && left.month() == right.month() && left.day() == right.day()
}

/// 创建尚未同步过的来源游标。
fn empty_sync_state(source_id: &str) -> ReleaseSourceSyncState {
    ReleaseSourceSyncState {
        source_id: source_id.to_owned(),
        request_host: None,
        last_request_at: None,
        request_failure_count: 0,
        backoff_until: None,
        last_sync_attempt_at: None,
        last_successful_sync_at: None,
        last_sync_error: None,
        etag: None,
        last_modified: None,
    }
}

/// 按番剧标识分组同步采集的资源。
fn releases_by_anime(releases: &[Release]) -> HashMap<String, Vec<Release>> {
    let mut grouped = HashMap::<String, Vec<Release>>::new();
    for release in releases {
        if let Some(anime_id) = release.anime_id.as_ref() {
            grouped
                .entry(anime_id.clone())
                .or_default()
                .push(release.clone());
        }
    }
    grouped
}

/// 熔断拒绝后沿用上一次真实网络根因。
fn preserve_root_cause(current: &str, previous: Option<&str>) -> String {
    if current.contains("正在熔断保护中") {
        if let Some(previous) = previous.filter(|value| !value.contains("正在熔断保护中")) {
            return previous.to_owned();
        }
    }
    current.to_owned()
}

/// 组装单个失败来源的通知正文。
fn format_sync_failure(
    error: &SourceSyncError,
    source: Option<&ReleaseSourceConfig>,
    circuit: Option<&RequestCircuitState>,
) -> String {
    let mut parts = vec![
        format!(
            "失败来源：{}（{}）",
            source.map_or(error.source_id.as_str(), |source| source.name.as_str()),
            error.source_id
        ),
        format!("原因：{}", trim_terminal_punctuation(&error.message)),
    ];
    if let Some(circuit) = circuit.filter(|state| state.failure_count > 0) {
        parts.push(format!("连续失败 {} 次", circuit.failure_count));
        if let Some(backoff_until) = circuit.backoff_until.as_deref() {
            parts.push(format!("熔断至 {backoff_until}"));
        }
    }
    parts.push("将在下次计划同步时自动重试".to_owned());
    format!("{}。", parts.join("。"))
}

/// 去除错误消息末尾重复标点。
fn trim_terminal_punctuation(value: &str) -> &str {
    value.trim_end_matches(['。', '；', ';', '，', ',', ' '])
}

/// 将 UTC 时间序列化为毫秒精度 ISO 字符串。
fn to_iso(value: DateTime<Utc>) -> String {
    value.to_rfc3339_opts(SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests;
