use ani_domain::{NotificationKind, NotificationRecord, NotificationSeverity};
use ani_repository::{DashboardRepository, NotificationRepository, RepositoryResult};
use chrono::{DateTime, SecondsFormat, Utc};

/// 每日提醒依赖的窄 Repository 端口。
pub trait DailyReminderStore {
    /// 读取首页聚合数据。
    fn get_reminder_dashboard(&self) -> RepositoryResult<ani_domain::DashboardData>;

    /// 读取全部通知。
    fn list_reminder_notifications(&self) -> RepositoryResult<Vec<NotificationRecord>>;

    /// 增量写入通知。
    fn add_reminder_notifications(
        &self,
        records: &[NotificationRecord],
    ) -> RepositoryResult<Vec<NotificationRecord>>;
}

impl<T> DailyReminderStore for T
where
    T: DashboardRepository + NotificationRepository,
{
    /// 将完整 Repository 组合适配为每日提醒端口。
    fn get_reminder_dashboard(&self) -> RepositoryResult<ani_domain::DashboardData> {
        DashboardRepository::get_dashboard(self)
    }

    /// 将完整 Repository 组合适配为每日提醒端口。
    fn list_reminder_notifications(&self) -> RepositoryResult<Vec<NotificationRecord>> {
        NotificationRepository::list_notifications(self)
    }

    /// 将完整 Repository 组合适配为每日提醒端口。
    fn add_reminder_notifications(
        &self,
        records: &[NotificationRecord],
    ) -> RepositoryResult<Vec<NotificationRecord>> {
        NotificationRepository::add_notifications(self, records)
    }
}

/// 根据首页当天聚合数据幂等生成追番提醒。
pub struct DailyReminderService;

impl DailyReminderService {
    /// 当天存在追番更新且尚未提醒时写入一条通知。
    pub fn run_once<S>(
        store: &S,
        now: DateTime<Utc>,
    ) -> RepositoryResult<Option<NotificationRecord>>
    where
        S: DailyReminderStore,
    {
        let dashboard = store.get_reminder_dashboard()?;
        let summary = dashboard.daily_reminder;
        if summary.total == 0 {
            return Ok(None);
        }
        let notification_id = format!("notification-daily-reminder-{}", summary.date);
        if store
            .list_reminder_notifications()?
            .iter()
            .any(|record| record.id == notification_id)
        {
            return Ok(None);
        }
        let record = NotificationRecord {
            id: notification_id,
            kind: NotificationKind::Reminder,
            title: "今日追番提醒".to_owned(),
            body: build_reminder_body(
                summary.total,
                summary.upcoming,
                summary.aired,
                summary.downloading,
                summary.downloaded,
            ),
            severity: if summary.aired > 0 || summary.downloading > 0 {
                NotificationSeverity::Success
            } else {
                NotificationSeverity::Info
            },
            anime_id: None,
            episode_id: None,
            download_task_id: None,
            created_at: now.to_rfc3339_opts(SecondsFormat::Millis, true),
            read_at: None,
        };
        store.add_reminder_notifications(std::slice::from_ref(&record))?;
        log::info!(
            "Rust 每日追番提醒已创建：date={}, total={}",
            summary.date,
            summary.total
        );
        Ok(Some(record))
    }
}

/// 组装每日追番提醒正文。
fn build_reminder_body(
    total: usize,
    upcoming: usize,
    aired: usize,
    downloading: usize,
    downloaded: usize,
) -> String {
    let mut parts = vec![format!("今日 {total} 部追番更新")];
    if upcoming > 0 {
        parts.push(format!("{upcoming} 部待播"));
    }
    if aired > 0 {
        parts.push(format!("{aired} 部待处理"));
    }
    if downloading > 0 {
        parts.push(format!("{downloading} 部下载中"));
    }
    if downloaded > 0 {
        parts.push(format!("{downloaded} 部已完成"));
    }
    parts.join("，")
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use ani_domain::{DailyReminderSummary, DashboardData, NotificationRecord};
    use ani_repository::RepositoryResult;
    use chrono::{TimeZone, Utc};

    use super::{build_reminder_body, DailyReminderService, DailyReminderStore};

    struct MemoryReminderStore {
        dashboard: DashboardData,
        notifications: Mutex<Vec<NotificationRecord>>,
    }

    impl DailyReminderStore for MemoryReminderStore {
        /// 读取测试首页。
        fn get_reminder_dashboard(&self) -> RepositoryResult<DashboardData> {
            Ok(self.dashboard.clone())
        }

        /// 读取测试通知。
        fn list_reminder_notifications(&self) -> RepositoryResult<Vec<NotificationRecord>> {
            Ok(self
                .notifications
                .lock()
                .expect("lock notifications")
                .clone())
        }

        /// 保存测试通知。
        fn add_reminder_notifications(
            &self,
            records: &[NotificationRecord],
        ) -> RepositoryResult<Vec<NotificationRecord>> {
            let mut notifications = self.notifications.lock().expect("lock notifications");
            notifications.extend_from_slice(records);
            Ok(notifications.clone())
        }
    }

    /// 验证提醒正文只包含非零状态。
    #[test]
    fn builds_daily_reminder_body() {
        assert_eq!(
            build_reminder_body(3, 1, 1, 0, 1),
            "今日 3 部追番更新，1 部待播，1 部待处理，1 部已完成"
        );
    }

    /// 验证同一天的每日提醒只写入一次。
    #[test]
    fn creates_daily_reminder_idempotently() {
        let store = MemoryReminderStore {
            dashboard: DashboardData {
                daily_reminder: DailyReminderSummary {
                    date: "2026-07-25".to_owned(),
                    total: 2,
                    upcoming: 1,
                    aired: 1,
                    downloading: 0,
                    downloaded: 0,
                    items: Vec::new(),
                },
                ..DashboardData::default()
            },
            notifications: Mutex::new(Vec::new()),
        };
        let now = Utc
            .with_ymd_and_hms(2026, 7, 25, 1, 0, 0)
            .single()
            .expect("fixed time");
        let first = DailyReminderService::run_once(&store, now)
            .expect("create reminder")
            .expect("reminder record");
        assert_eq!(first.id, "notification-daily-reminder-2026-07-25");
        assert!(DailyReminderService::run_once(&store, now)
            .expect("skip duplicate reminder")
            .is_none());
        assert_eq!(
            store
                .notifications
                .lock()
                .expect("lock notifications")
                .len(),
            1
        );
    }
}
