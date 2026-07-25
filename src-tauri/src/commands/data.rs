use std::sync::{Arc, Mutex};

use ani_contracts::AppCommandError;
use ani_domain::{AppSettings, DashboardData, MyAnime, NotificationRecord};
use ani_storage::{Storage, StorageError};
use tauri::State;

use crate::storage::AppStorageState;

/// 将数据层错误转换为稳定的 Tauri 命令错误。
fn map_storage_error(action: &str, error: impl std::fmt::Display) -> AppCommandError {
    log::error!("Tauri 数据命令失败 action={action} error={error}");
    AppCommandError {
        code: "storage_operation_failed".to_owned(),
        message: format!("{action}失败：{error}"),
    }
}

/// 在线程池执行 SQLite 查询，避免阻塞 WebView 调用线程。
async fn run_query<T, F>(
    action: &'static str,
    storage: Arc<Mutex<Storage>>,
    query: F,
) -> Result<T, AppCommandError>
where
    T: Send + 'static,
    F: FnOnce(&Storage) -> Result<T, StorageError> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || {
        let guard = storage
            .lock()
            .map_err(|error| map_storage_error(action, error))?;
        query(&guard).map_err(|error| map_storage_error(action, error))
    })
    .await
    .map_err(|error| map_storage_error(action, error))?
}

/// 读取首页聚合数据。
#[tauri::command]
pub(crate) async fn get_dashboard(
    state: State<'_, AppStorageState>,
) -> Result<DashboardData, AppCommandError> {
    run_query("读取首页", Arc::clone(state.storage()), |storage| {
        storage.repository().get_dashboard()
    })
    .await
}

/// 读取当前平台完整设置。
#[tauri::command]
pub(crate) async fn get_settings(
    state: State<'_, AppStorageState>,
) -> Result<AppSettings, AppCommandError> {
    let defaults = state.platform_defaults().clone();
    run_query("读取设置", Arc::clone(state.storage()), move |storage| {
        storage.repository().get_settings(&defaults)
    })
    .await
}

/// 按创建时间倒序读取通知。
#[tauri::command]
pub(crate) async fn list_notifications(
    state: State<'_, AppStorageState>,
) -> Result<Vec<NotificationRecord>, AppCommandError> {
    run_query("读取通知", Arc::clone(state.storage()), |storage| {
        storage.repository().list_notifications()
    })
    .await
}

/// 读取未读通知数量。
#[tauri::command]
pub(crate) async fn get_unread_notification_count(
    state: State<'_, AppStorageState>,
) -> Result<u64, AppCommandError> {
    run_query(
        "读取未读通知数量",
        Arc::clone(state.storage()),
        |storage| storage.repository().get_unread_notification_count(),
    )
    .await
}

/// 读取我的追番列表。
#[tauri::command]
pub(crate) async fn list_my_anime(
    state: State<'_, AppStorageState>,
) -> Result<Vec<MyAnime>, AppCommandError> {
    run_query(
        "读取我的追番",
        Arc::clone(state.storage()),
        |storage| storage.repository().list_my_anime(),
    )
    .await
}
