use ani_contracts::AppCommandError;
use ani_domain::{AutomationRunResult, AutomationSchedulerStatus};
use tauri::State;

use crate::automation::AppAutomationState;

/// 读取自动扫描调度器状态。
#[tauri::command]
pub(crate) async fn get_automation_scheduler_status(
    state: State<'_, AppAutomationState>,
) -> Result<AutomationSchedulerStatus, AppCommandError> {
    Ok(state.status().await)
}

/// 手动执行一次自动扫描，并应用一分钟冷却。
#[tauri::command]
pub(crate) async fn run_automation_once(
    state: State<'_, AppAutomationState>,
) -> Result<AutomationRunResult, AppCommandError> {
    state
        .run_now(true, "manual")
        .await
        .map_err(|message| AppCommandError {
            code: if message.contains("正在运行") {
                "automation_in_flight"
            } else if message.contains("过于频繁") {
                "automation_cooldown"
            } else {
                "automation_failed"
            }
            .to_owned(),
            message,
        })
}

/// 按最新设置重新安排自动扫描调度器。
#[tauri::command]
pub(crate) async fn restart_automation_scheduler(
    state: State<'_, AppAutomationState>,
) -> Result<AutomationSchedulerStatus, AppCommandError> {
    state.restart().await.map_err(|message| AppCommandError {
        code: "automation_restart_failed".to_owned(),
        message,
    })
}
