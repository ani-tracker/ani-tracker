use ani_contracts::AppCommandError;
use ani_domain::{SourceSyncRunResult, SourceSyncSchedulerStatus};
use tauri::State;

use crate::source_sync::AppSourceSyncState;

/// 读取来源每日同步调度器状态。
#[tauri::command]
pub(crate) async fn get_source_sync_status(
    state: State<'_, AppSourceSyncState>,
) -> Result<SourceSyncSchedulerStatus, AppCommandError> {
    Ok(state.status().await)
}

/// 手动强制执行一次来源增量同步。
#[tauri::command]
pub(crate) async fn sync_sources_now(
    state: State<'_, AppSourceSyncState>,
) -> Result<SourceSyncRunResult, AppCommandError> {
    state
        .run_now(true, "manual")
        .await
        .map_err(|message| AppCommandError {
            code: if message.contains("正在运行") {
                "source_sync_in_flight".to_owned()
            } else {
                "source_sync_failed".to_owned()
            },
            message,
        })
}
