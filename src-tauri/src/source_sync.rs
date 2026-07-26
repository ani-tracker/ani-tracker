use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration as StdDuration;

use ani_automation::{SourceSyncRunOptions, SourceSyncService};
use ani_domain::{
    AppSettings, ReleaseSourceConfig, SourceSyncRunResult, SourceSyncSchedulerStatus,
};
use ani_repository::prelude::*;
use ani_storage::Storage;
use chrono::{DateTime, Days, Local, NaiveTime, SecondsFormat, TimeZone, Utc};
use tokio::sync::{Mutex as AsyncMutex, Notify};

use crate::sources::{AppSourceState, SharedReleaseSearchStore};

const DEFAULT_DAILY_TIME: &str = "09:00";

/// Tauri 生命周期内持有来源每日同步状态和唤醒信号。
#[derive(Clone)]
pub(crate) struct AppSourceSyncState {
    inner: Arc<SourceSyncRuntime>,
}

struct SourceSyncRuntime {
    storage: Arc<Mutex<Storage>>,
    platform_defaults: AppSettings,
    source_state: AppSourceState,
    status: AsyncMutex<SourceSyncSchedulerStatus>,
    wake: Notify,
    started: AtomicBool,
    in_flight: AtomicBool,
}

impl AppSourceSyncState {
    /// 创建尚未启动后台循环的来源同步状态。
    pub(crate) fn new(
        storage: Arc<Mutex<Storage>>,
        platform_defaults: AppSettings,
        source_state: AppSourceState,
    ) -> Self {
        Self {
            inner: Arc::new(SourceSyncRuntime {
                storage,
                platform_defaults,
                source_state,
                status: AsyncMutex::new(SourceSyncSchedulerStatus {
                    enabled: false,
                    running: false,
                    in_flight: false,
                    daily_time: DEFAULT_DAILY_TIME.to_owned(),
                    next_run_at: None,
                    last_run_at: None,
                    last_result: None,
                    last_error: None,
                }),
                wake: Notify::new(),
                started: AtomicBool::new(false),
                in_flight: AtomicBool::new(false),
            }),
        }
    }

    /// 启动每日调度循环，并在当天未成功同步时补跑。
    pub(crate) fn start(&self) {
        if self.inner.started.swap(true, Ordering::AcqRel) {
            return;
        }
        let state = self.clone();
        tauri::async_runtime::spawn(async move {
            state.run_loop().await;
        });
    }

    /// 读取当前调度器状态快照。
    pub(crate) async fn status(&self) -> SourceSyncSchedulerStatus {
        self.inner.status.lock().await.clone()
    }

    /// 在设置保存后立即刷新开关和每日时间。
    pub(crate) async fn refresh_from_settings(&self, settings: &AppSettings) {
        let enabled = settings
            .pointer("/sourceSync/enabled")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(true);
        let daily_time = normalize_daily_time(
            settings
                .pointer("/sourceSync/dailyTime")
                .and_then(serde_json::Value::as_str),
        );
        {
            let mut status = self.inner.status.lock().await;
            status.enabled = enabled;
            status.daily_time = daily_time;
            if !enabled {
                status.running = false;
                status.next_run_at = None;
            }
        }
        self.inner.wake.notify_one();
    }

    /// 立即执行一次来源同步，拒绝并发重复运行。
    pub(crate) async fn run_now(
        &self,
        force: bool,
        trigger: &'static str,
    ) -> Result<SourceSyncRunResult, String> {
        if self
            .inner
            .in_flight
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return Err("下载源增量同步正在运行".to_owned());
        }
        {
            let mut status = self.inner.status.lock().await;
            status.in_flight = true;
            status.running = false;
            status.next_run_at = None;
            status.last_error = None;
        }
        log::info!("Tauri 来源增量同步开始 trigger={trigger} force={force}");
        let outcome = self.execute_sync(force).await;
        {
            let mut status = self.inner.status.lock().await;
            status.in_flight = false;
            match &outcome {
                Ok(result) => {
                    status.last_run_at = Some(result.finished_at.clone());
                    status.last_result = Some(result.clone());
                }
                Err(error) => status.last_error = Some(error.clone()),
            }
        }
        self.inner.in_flight.store(false, Ordering::Release);
        self.inner.wake.notify_one();
        outcome
    }

    /// 从 Repository 与来源连接池装配并执行同步服务。
    async fn execute_sync(&self, force: bool) -> Result<SourceSyncRunResult, String> {
        let storage = Arc::clone(&self.inner.storage);
        let defaults = self.inner.platform_defaults.clone();
        let (settings, sources) = tauri::async_runtime::spawn_blocking(move || {
            let storage = storage
                .lock()
                .map_err(|error| format!("读取来源同步上下文失败：{error}"))?;
            let repository = storage.repository();
            let settings = repository
                .get_settings(&defaults)
                .map_err(|error| format!("读取来源同步设置失败：{error}"))?;
            let sources = repository
                .list_sources()
                .map_err(|error| format!("读取下载源失败：{error}"))?;
            Ok::<(AppSettings, Vec<ReleaseSourceConfig>), String>((settings, sources))
        })
        .await
        .map_err(|error| format!("读取来源同步上下文失败：{error}"))??;
        let network = self
            .inner
            .source_state
            .network_service(&settings)
            .await
            .map_err(|error| format!("初始化来源网络失败：{error}"))?;
        let store = SharedReleaseSearchStore::new(Arc::clone(&self.inner.storage));
        SourceSyncService::new(network)
            .run(&store, &sources, SourceSyncRunOptions { force, now: None })
            .await
            .map_err(|error| format!("同步下载源失败：{error}"))
    }

    /// 按当前设置持续安排下一次运行。
    async fn run_loop(&self) {
        match self.load_settings().await {
            Ok(settings) => self.refresh_from_settings(&settings).await,
            Err(error) => {
                log::error!("Tauri 来源同步调度器读取设置失败 error={error}");
                self.inner.status.lock().await.last_error = Some(error);
            }
        }
        if self.inner.status.lock().await.enabled {
            if let Err(error) = self.run_now(false, "startup").await {
                log::error!("Tauri 启动补跑来源同步失败 error={error}");
            }
        }

        loop {
            let (enabled, daily_time) = {
                let status = self.inner.status.lock().await;
                (status.enabled, status.daily_time.clone())
            };
            if !enabled {
                self.inner.wake.notified().await;
                continue;
            }
            let next = resolve_next_run_at(Local::now(), &daily_time);
            {
                let mut status = self.inner.status.lock().await;
                status.running = true;
                status.next_run_at = Some(
                    next.with_timezone(&Utc)
                        .to_rfc3339_opts(SecondsFormat::Millis, true),
                );
            }
            let wait = next
                .signed_duration_since(Local::now())
                .to_std()
                .unwrap_or_else(|_| StdDuration::from_secs(1))
                .max(StdDuration::from_secs(1));
            tokio::select! {
                _ = tokio::time::sleep(wait) => {
                    if let Err(error) = self.run_now(false, "scheduled").await {
                        log::error!("Tauri 定时来源同步失败 error={error}");
                    }
                }
                _ = self.inner.wake.notified() => {}
            }
        }
    }

    /// 从 SQLite 读取当前来源同步设置。
    async fn load_settings(&self) -> Result<AppSettings, String> {
        let storage = Arc::clone(&self.inner.storage);
        let defaults = self.inner.platform_defaults.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let storage = storage
                .lock()
                .map_err(|error| format!("读取来源同步设置失败：{error}"))?;
            storage
                .repository()
                .get_settings(&defaults)
                .map_err(|error| format!("读取来源同步设置失败：{error}"))
        })
        .await
        .map_err(|error| format!("读取来源同步设置失败：{error}"))?
    }
}

/// 规范每日同步时间，非法值回退到 09:00。
pub(crate) fn normalize_daily_time(value: Option<&str>) -> String {
    value
        .filter(|value| NaiveTime::parse_from_str(value, "%H:%M").is_ok())
        .unwrap_or(DEFAULT_DAILY_TIME)
        .to_owned()
}

/// 计算本地时区的下一次每日运行时间。
fn resolve_next_run_at(now: DateTime<Local>, daily_time: &str) -> DateTime<Local> {
    let time = NaiveTime::parse_from_str(&normalize_daily_time(Some(daily_time)), "%H:%M")
        .expect("normalized daily time must parse");
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
    use super::normalize_daily_time;

    /// 验证非法每日时间稳定回退，合法值保持不变。
    #[test]
    fn normalizes_daily_sync_time() {
        assert_eq!(normalize_daily_time(Some("23:45")), "23:45");
        assert_eq!(normalize_daily_time(Some("24:00")), "09:00");
        assert_eq!(normalize_daily_time(None), "09:00");
    }
}
