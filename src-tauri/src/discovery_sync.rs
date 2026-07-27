use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration as StdDuration;

use ani_automation::{is_same_local_day, AnimeDiscoverySyncService};
use ani_domain::{AnimeDiscoverySeasonQuery, AppSettings};
use ani_repository::prelude::*;
use ani_storage::Storage;
use chrono::{DateTime, Datelike, Days, Local, NaiveTime, TimeZone, Utc};
use tokio::sync::Notify;

use crate::sources::{AppSourceState, SharedReleaseSearchStore};

const DISCOVERY_DAILY_TIME: &str = "06:00";
const SEASONS: [(&str, u32); 4] = [("winter", 1), ("spring", 4), ("summer", 7), ("fall", 10)];

/// Tauri 生命周期内的新番季度同步调度器。
#[derive(Clone)]
pub(crate) struct AppDiscoverySyncState {
    inner: Arc<DiscoverySyncRuntime>,
}

struct DiscoverySyncRuntime {
    storage: Arc<Mutex<Storage>>,
    platform_defaults: AppSettings,
    source_state: AppSourceState,
    wake: Notify,
    started: AtomicBool,
    in_flight: AtomicBool,
}

impl AppDiscoverySyncState {
    /// 创建尚未启动的新番季度同步调度器。
    pub(crate) fn new(
        storage: Arc<Mutex<Storage>>,
        platform_defaults: AppSettings,
        source_state: AppSourceState,
    ) -> Self {
        Self {
            inner: Arc::new(DiscoverySyncRuntime {
                storage,
                platform_defaults,
                source_state,
                wake: Notify::new(),
                started: AtomicBool::new(false),
                in_flight: AtomicBool::new(false),
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

    /// 串行补齐当年过去季度，再按天同步当前季度。
    async fn run_due(&self, trigger: &'static str) {
        if self
            .inner
            .in_flight
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return;
        }
        let outcome = self.execute_due(trigger).await;
        if let Err(error) = outcome {
            log::error!("Tauri 新番季度后台同步失败 trigger={trigger} error={error}");
        }
        self.inner.in_flight.store(false, Ordering::Release);
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
            log::info!("Tauri 新番季度后台同步开始 trigger={trigger} year={year} season={season}");
            match service
                .sync_season(
                    &store,
                    AnimeDiscoverySeasonQuery {
                        year,
                        season: season.clone(),
                        force_refresh: false,
                    },
                    Some(now),
                )
                .await
            {
                Ok(result) => log::info!(
                    "Tauri 新番季度后台同步结束 year={} season={} count={} errors={}",
                    year,
                    season,
                    result.items.len(),
                    result.errors.len()
                ),
                Err(error) => log::error!(
                    "Tauri 新番季度后台同步异常 year={year} season={season} error={error}"
                ),
            }
        }
        Ok(())
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
