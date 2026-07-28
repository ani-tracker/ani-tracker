use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration as StdDuration, Instant};

use ani_automation::{is_same_local_day, months_for_season, AnimeDiscoverySyncService};
use ani_domain::{
    AnimeDiscoverySeasonQuery, AnimeDiscoverySeasonResult, AnimeDiscoverySyncPhase,
    AnimeDiscoverySyncTaskResult, AnimeDiscoverySyncTaskStatus, AppSettings, NotificationKind,
    NotificationRecord, NotificationSeverity,
};
use ani_repository::prelude::*;
use ani_storage::Storage;
use chrono::{DateTime, Datelike, Days, Local, NaiveTime, SecondsFormat, TimeZone, Utc};
use tauri::AppHandle;
use tokio::sync::{Mutex as AsyncMutex, Notify};

use crate::sources::{AppSourceState, SharedReleaseSearchStore};

const DISCOVERY_DAILY_TIME: &str = "06:00";
const DETAIL_BATCH_SIZE: usize = 12;
const SEASONS: [(&str, u32); 4] = [("winter", 1), ("spring", 4), ("summer", 7), ("fall", 10)];

/// Tauri 生命周期内的新番季度同步调度器。
#[derive(Clone)]
pub(crate) struct AppDiscoverySyncState {
    inner: Arc<DiscoverySyncRuntime>,
}

struct DiscoverySyncRuntime {
    app: AppHandle,
    storage: Arc<Mutex<Storage>>,
    platform_defaults: AppSettings,
    source_state: AppSourceState,
    wake: Notify,
    started: AtomicBool,
    in_flight: AtomicBool,
    status: AsyncMutex<AnimeDiscoverySyncTaskStatus>,
}

impl AppDiscoverySyncState {
    /// 创建尚未启动的新番季度同步调度器。
    pub(crate) fn new(
        app: AppHandle,
        storage: Arc<Mutex<Storage>>,
        platform_defaults: AppSettings,
        source_state: AppSourceState,
    ) -> Self {
        Self {
            inner: Arc::new(DiscoverySyncRuntime {
                app,
                storage,
                platform_defaults,
                source_state,
                wake: Notify::new(),
                started: AtomicBool::new(false),
                in_flight: AtomicBool::new(false),
                status: AsyncMutex::new(AnimeDiscoverySyncTaskStatus {
                    in_flight: false,
                    phase: None,
                    active_query: None,
                    started_at: None,
                    finished_at: None,
                    catalog_finished_at: None,
                    detail_completed_count: 0,
                    detail_total_count: 0,
                    detail_error_count: 0,
                    last_result: None,
                    last_error: None,
                }),
            }),
        }
    }

    /// 启动每日 06:00 调度，并立即检查启动补跑。
    pub(crate) fn start(&self) {
        if self.inner.started.swap(true, Ordering::AcqRel) {
            return;
        }
        let state = self.clone();
        tauri::async_runtime::spawn(async move {
            state.run_loop().await;
        });
    }

    /// 应用恢复前台时唤醒调度器检查漏跑。
    pub(crate) fn wake(&self) {
        self.inner.wake.notify_one();
    }

    /// 返回季度同步后台任务的当前状态快照。
    pub(crate) async fn status(&self) -> AnimeDiscoverySyncTaskStatus {
        self.inner.status.lock().await.clone()
    }

    /// 将人工季度采集加入宿主后台任务并立即返回。
    pub(crate) async fn start_sync(
        &self,
        query: AnimeDiscoverySeasonQuery,
    ) -> Result<AnimeDiscoverySyncTaskStatus, String> {
        self.reserve_sync(Some(query.clone())).await?;
        let state = self.clone();
        tauri::async_runtime::spawn(async move {
            let outcome = state.execute_query(query, None, "manual-background").await;
            state.record_outcome(&outcome).await;
            state.finish_sync().await;
            state.inner.wake.notify_one();
        });
        Ok(self.status().await)
    }

    /// 执行并等待一次季度采集，供兼容命令复用同一防重状态。
    pub(crate) async fn run_now(
        &self,
        query: AnimeDiscoverySeasonQuery,
        trigger: &'static str,
    ) -> Result<AnimeDiscoverySeasonResult, String> {
        self.reserve_sync(Some(query.clone())).await?;
        let outcome = self.execute_query(query, None, trigger).await;
        self.record_outcome(&outcome).await;
        self.finish_sync().await;
        self.inner.wake.notify_one();
        outcome
    }

    /// 串行补齐当年过去季度，再按天同步当前季度。
    async fn run_due(&self, trigger: &'static str) {
        if self.reserve_sync(None).await.is_err() {
            return;
        }
        let outcome = self.execute_due(trigger).await;
        if let Err(error) = outcome {
            log::error!("Tauri 新番季度后台同步失败 trigger={trigger} error={error}");
            self.record_error(error).await;
        }
        self.finish_sync().await;
    }

    /// 读取季度标记并执行本次到期同步。
    async fn execute_due(&self, trigger: &'static str) -> Result<(), String> {
        let now = Utc::now();
        let local_now = now.with_timezone(&Local);
        let year = i64::from(local_now.year());
        let current_index = season_index(local_now.month());
        let storage = Arc::clone(&self.inner.storage);
        let defaults = self.inner.platform_defaults.clone();
        let (settings, states) = tauri::async_runtime::spawn_blocking(move || {
            let storage = storage
                .lock()
                .map_err(|error| format!("读取新番同步上下文失败：{error}"))?;
            let repository = storage.repository();
            let settings = repository
                .get_settings(&defaults)
                .map_err(|error| format!("读取新番同步设置失败：{error}"))?;
            let states = SEASONS
                .iter()
                .map(|(season, _)| {
                    repository
                        .get_anime_season_sync_state(year, season)
                        .map(|state| ((*season).to_owned(), state))
                })
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| format!("读取季度同步标记失败：{error}"))?;
            Ok::<_, String>((settings, states))
        })
        .await
        .map_err(|error| format!("读取新番同步上下文失败：{error}"))??;

        let mut due = Vec::new();
        for (index, (season, _)) in SEASONS.iter().enumerate() {
            let state = states
                .iter()
                .find(|(candidate, _)| candidate == season)
                .and_then(|(_, state)| state.as_ref());
            if index < current_index
                && state
                    .and_then(|state| state.completed_at.as_ref())
                    .is_none()
            {
                due.push((*season).to_owned());
            }
        }
        let current_season = SEASONS[current_index].0;
        let current_state = states
            .iter()
            .find(|(season, _)| season == current_season)
            .and_then(|(_, state)| state.as_ref());
        if !is_same_local_day(
            current_state.and_then(|state| state.last_successful_sync_at.as_deref()),
            now,
        ) {
            due.push(current_season.to_owned());
        }
        if due.is_empty() {
            log::info!("Tauri 新番季度同步无需补跑 trigger={trigger}");
            return Ok(());
        }

        let network = self
            .inner
            .source_state
            .network_service(&settings)
            .await
            .map_err(|error| format!("初始化新番元数据网络失败：{error}"))?;
        let service = AnimeDiscoverySyncService::new_background(network);
        let store = SharedReleaseSearchStore::new(Arc::clone(&self.inner.storage));
        for season in due {
            let query = AnimeDiscoverySeasonQuery {
                year,
                season: season.clone(),
                force_refresh: false,
            };
            self.set_active_query(query.clone()).await;
            let started = Instant::now();
            log::info!("Tauri 新番季度后台同步开始 trigger={trigger} year={year} season={season}");
            match self
                .execute_with_service(&service, &store, query, Some(now), trigger)
                .await
            {
                Ok(result) => {
                    self.record_result(&result).await;
                    log::info!(
                        "Tauri 新番季度后台同步结束 year={} season={} count={} errors={} duration_ms={}",
                        year,
                        season,
                        result.items.len(),
                        result.errors.len(),
                        started.elapsed().as_millis()
                    );
                }
                Err(error) => {
                    let message = error.to_string();
                    self.record_error(message.clone()).await;
                    log::error!(
                        "Tauri 新番季度后台同步异常 year={year} season={season} duration_ms={} error={message}",
                        started.elapsed().as_millis()
                    );
                }
            }
        }
        Ok(())
    }

    /// 为一次同步抢占全局执行权并初始化可查询状态。
    async fn reserve_sync(&self, query: Option<AnimeDiscoverySeasonQuery>) -> Result<(), String> {
        if let Some(query) = query.as_ref() {
            months_for_season(&query.season).map_err(|error| error.to_string())?;
        }
        self.inner
            .in_flight
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| "新番季度同步正在运行".to_owned())?;
        let mut status = self.inner.status.lock().await;
        status.in_flight = true;
        status.phase = Some(AnimeDiscoverySyncPhase::Catalog);
        status.active_query = query;
        status.started_at = Some(to_iso(Utc::now()));
        status.finished_at = None;
        status.catalog_finished_at = None;
        status.detail_completed_count = 0;
        status.detail_total_count = 0;
        status.detail_error_count = 0;
        status.last_result = None;
        status.last_error = None;
        Ok(())
    }

    /// 使用当前设置执行一个季度，并记录端到端耗时。
    async fn execute_query(
        &self,
        query: AnimeDiscoverySeasonQuery,
        now: Option<DateTime<Utc>>,
        trigger: &'static str,
    ) -> Result<AnimeDiscoverySeasonResult, String> {
        let storage = Arc::clone(&self.inner.storage);
        let defaults = self.inner.platform_defaults.clone();
        let settings = tauri::async_runtime::spawn_blocking(move || {
            let storage = storage
                .lock()
                .map_err(|error| format!("读取季度采集上下文失败：{error}"))?;
            storage
                .repository()
                .get_settings(&defaults)
                .map_err(|error| format!("读取季度采集设置失败：{error}"))
        })
        .await
        .map_err(|error| format!("读取季度采集上下文失败：{error}"))??;
        let network = self
            .inner
            .source_state
            .network_service(&settings)
            .await
            .map_err(|error| format!("初始化季度元数据网络失败：{error}"))?;
        let service = AnimeDiscoverySyncService::new_background(network);
        let store = SharedReleaseSearchStore::new(Arc::clone(&self.inner.storage));
        let started = Instant::now();
        log::info!(
            "Tauri 新番季度同步开始 trigger={trigger} year={} season={}",
            query.year,
            query.season
        );
        let result = self
            .execute_with_service(&service, &store, query, now, trigger)
            .await;
        match &result {
            Ok(result) => log::info!(
                "Tauri 新番季度同步结束 trigger={trigger} year={} season={} count={} errors={} duration_ms={}",
                result.query.year,
                result.query.season,
                result.items.len(),
                result.errors.len(),
                started.elapsed().as_millis()
            ),
            Err(error) => log::error!(
                "Tauri 新番季度同步异常 trigger={trigger} duration_ms={} error={error}",
                started.elapsed().as_millis()
            ),
        }
        result
    }

    /// 先发布基础目录，再分批补全详情并持续更新可查询进度。
    async fn execute_with_service(
        &self,
        service: &AnimeDiscoverySyncService,
        store: &SharedReleaseSearchStore,
        query: AnimeDiscoverySeasonQuery,
        now: Option<DateTime<Utc>>,
        trigger: &'static str,
    ) -> Result<AnimeDiscoverySeasonResult, String> {
        self.set_active_query(query.clone()).await;
        let result = service
            .sync_season_catalog(store, query, now)
            .await
            .map_err(|error| format!("采集季度新番失败：{error}"))?;
        self.record_result(&result).await;
        self.begin_detail_phase(result.items.len()).await;

        let manual = trigger.starts_with("manual");
        let notification = manual.then(|| {
            (
                format!(
                    "discovery-sync-{}-{}-{}",
                    result.query.year,
                    result.query.season,
                    Utc::now().timestamp_millis()
                ),
                to_iso(Utc::now()),
            )
        });
        if let Some((id, created_at)) = notification.as_ref() {
            self.save_discovery_notification(&result, id, created_at, false)
                .await;
        }

        for chunk in result.items.chunks(DETAIL_BATCH_SIZE) {
            let (completed, errors) = match service.enrich_detail_batch(store, chunk).await {
                Ok(batch) => (batch.completed_count, batch.error_count),
                Err(error) => {
                    log::error!(
                        "Tauri 新番季度详情批次保存失败 year={} season={} count={} error={error}",
                        result.query.year,
                        result.query.season,
                        chunk.len()
                    );
                    (chunk.len(), chunk.len())
                }
            };
            self.advance_detail_progress(completed, errors).await;
        }
        self.record_result(&result).await;
        if let Some((id, created_at)) = notification.as_ref() {
            self.save_discovery_notification(&result, id, created_at, true)
                .await;
        }
        Ok(result)
    }

    /// 标记基础目录已经可用，并进入详情补全阶段。
    async fn begin_detail_phase(&self, total_count: usize) {
        let mut status = self.inner.status.lock().await;
        status.phase = Some(AnimeDiscoverySyncPhase::Details);
        status.catalog_finished_at = Some(to_iso(Utc::now()));
        status.detail_completed_count = 0;
        status.detail_total_count = total_count;
        status.detail_error_count = 0;
    }

    /// 累加详情批次进度，并同步紧凑结果中的错误数。
    async fn advance_detail_progress(&self, completed_count: usize, error_count: usize) {
        let mut status = self.inner.status.lock().await;
        status.detail_completed_count = status
            .detail_completed_count
            .saturating_add(completed_count)
            .min(status.detail_total_count);
        status.detail_error_count = status.detail_error_count.saturating_add(error_count);
        let detail_error_count = status.detail_error_count;
        if let Some(result) = status.last_result.as_mut() {
            result.error_count = result.error_count.saturating_add(error_count);
        }
        log::info!(
            "Tauri 新番季度详情进度 completed={}/{} errors={}",
            status.detail_completed_count,
            status.detail_total_count,
            detail_error_count
        );
    }

    /// 写入或更新同一次手动采集通知，首阶段按设置发送一次系统通知。
    async fn save_discovery_notification(
        &self,
        result: &AnimeDiscoverySeasonResult,
        notification_id: &str,
        created_at: &str,
        details_complete: bool,
    ) {
        let status = self.status().await;
        let total_errors = result
            .errors
            .len()
            .saturating_add(status.detail_error_count);
        let title = format!(
            "{} {}新番同步完成",
            result.query.year,
            season_label(&result.query.season)
        );
        let body = if details_complete {
            if total_errors == 0 {
                format!("已同步 {} 部，详情补全完成", result.items.len())
            } else {
                format!(
                    "已同步 {} 部，详情补全完成，{} 项来源请求失败",
                    result.items.len(),
                    total_errors
                )
            }
        } else {
            format!("已同步 {} 部，详情正在后台补全", result.items.len())
        };
        let record = NotificationRecord {
            id: notification_id.to_owned(),
            kind: NotificationKind::System,
            title,
            body,
            severity: if total_errors == 0 {
                NotificationSeverity::Success
            } else {
                NotificationSeverity::Warning
            },
            anime_id: None,
            episode_id: None,
            download_task_id: None,
            created_at: created_at.to_owned(),
            read_at: None,
        };
        let storage = Arc::clone(&self.inner.storage);
        let defaults = self.inner.platform_defaults.clone();
        let outcome = tauri::async_runtime::spawn_blocking(move || {
            let storage = storage
                .lock()
                .map_err(|error| format!("写入季度同步通知失败：{error}"))?;
            let repository = storage.repository();
            let settings = repository
                .get_settings(&defaults)
                .map_err(|error| format!("读取通知设置失败：{error}"))?;
            repository
                .add_notifications(std::slice::from_ref(&record))
                .map_err(|error| format!("写入季度同步通知失败：{error}"))?;
            Ok::<_, String>((record, settings))
        })
        .await;
        match outcome {
            Ok(Ok((record, settings))) => {
                log::info!(
                    "Tauri 新番季度同步通知已保存 id={} details_complete={details_complete}",
                    record.id
                );
                if !details_complete {
                    crate::system_integration::notify_discovery_result(
                        &self.inner.app,
                        &settings,
                        &record,
                    );
                }
            }
            Ok(Err(error)) => log::error!("{error}"),
            Err(error) => log::error!("写入季度同步通知任务失败 error={error}"),
        }
    }

    /// 更新多季度补跑时当前正在处理的季度。
    async fn set_active_query(&self, query: AnimeDiscoverySeasonQuery) {
        let mut status = self.inner.status.lock().await;
        status.phase = Some(AnimeDiscoverySyncPhase::Catalog);
        status.active_query = Some(query);
        status.catalog_finished_at = None;
        status.detail_completed_count = 0;
        status.detail_total_count = 0;
        status.detail_error_count = 0;
        status.last_result = None;
        status.last_error = None;
    }

    /// 将完整季度结果压缩成轮询状态需要的计数。
    async fn record_result(&self, result: &AnimeDiscoverySeasonResult) {
        let mut status = self.inner.status.lock().await;
        let error_count = result
            .errors
            .len()
            .saturating_add(status.detail_error_count);
        status.last_result = Some(AnimeDiscoverySyncTaskResult {
            query: result.query.clone(),
            item_count: result.items.len(),
            added_count: result.added_count,
            existing_count: result.existing_count,
            error_count,
        });
    }

    /// 记录最近一次不可恢复的季度同步错误。
    async fn record_error(&self, error: String) {
        self.inner.status.lock().await.last_error = Some(error);
    }

    /// 将一次季度执行结果写入状态。
    async fn record_outcome(&self, outcome: &Result<AnimeDiscoverySeasonResult, String>) {
        match outcome {
            Ok(result) => self.record_result(result).await,
            Err(error) => self.record_error(error.clone()).await,
        }
    }

    /// 释放执行权并保留最近结果供页面完成刷新。
    async fn finish_sync(&self) {
        {
            let mut status = self.inner.status.lock().await;
            status.in_flight = false;
            status.phase = None;
            status.active_query = None;
            status.finished_at = Some(to_iso(Utc::now()));
        }
        self.inner.in_flight.store(false, Ordering::Release);
    }

    /// 按下一次 06:00 或生命周期唤醒持续调度。
    async fn run_loop(&self) {
        self.run_due("startup").await;
        loop {
            let next = resolve_next_run_at(Local::now());
            let wait = next
                .signed_duration_since(Local::now())
                .to_std()
                .unwrap_or_else(|_| StdDuration::from_secs(1))
                .max(StdDuration::from_secs(1));
            tokio::select! {
                _ = tokio::time::sleep(wait) => self.run_due("scheduled").await,
                _ = self.inner.wake.notified() => self.run_due("resume").await,
            }
        }
    }
}

/// 按月份返回当前季度下标。
fn season_index(month: u32) -> usize {
    match month {
        1..=3 => 0,
        4..=6 => 1,
        7..=9 => 2,
        _ => 3,
    }
}

/// 将季度标识转换为通知标题使用的中文名称。
fn season_label(season: &str) -> &'static str {
    match season {
        "winter" => "冬季",
        "spring" => "春季",
        "summer" => "夏季",
        "fall" => "秋季",
        _ => "季度",
    }
}

/// 计算本地时区下一次 06:00。
fn resolve_next_run_at(now: DateTime<Local>) -> DateTime<Local> {
    let time = NaiveTime::parse_from_str(DISCOVERY_DAILY_TIME, "%H:%M")
        .expect("discovery daily time must parse");
    let mut date = now.date_naive();
    loop {
        let candidate = Local
            .from_local_datetime(&date.and_time(time))
            .earliest()
            .unwrap_or_else(|| now + chrono::Duration::hours(1));
        if candidate > now {
            return candidate;
        }
        date = date
            .checked_add_days(Days::new(1))
            .unwrap_or_else(|| now.date_naive());
    }
}

/// 将 UTC 时间序列化为毫秒精度 ISO 字符串。
fn to_iso(value: DateTime<Utc>) -> String {
    value.to_rfc3339_opts(SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use super::season_index;

    /// 验证自然月稳定映射到四个季度。
    #[test]
    fn maps_month_to_season_index() {
        assert_eq!(season_index(1), 0);
        assert_eq!(season_index(4), 1);
        assert_eq!(season_index(7), 2);
        assert_eq!(season_index(12), 3);
    }
}
