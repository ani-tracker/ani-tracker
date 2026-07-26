use ani_contracts::AppCommandError;
use tauri::AppHandle;
use tauri_plugin_ani_mobile::{AniMobileExt, MobileNavigationIntent, MobilePlatformStatus};
use tauri_plugin_notification::{NotificationExt, PermissionState};

/// 读取移动端生命周期、网络、存储、方向和通知权限状态。
#[tauri::command]
pub(crate) fn get_mobile_platform_status(
    app: AppHandle,
) -> Result<MobilePlatformStatus, AppCommandError> {
    app.ani_mobile()
        .status()
        .map_err(|error| mobile_error("读取移动运行状态", error))
}

/// 原子读取并清除原生通知要求打开的页面。
#[tauri::command]
pub(crate) fn consume_mobile_navigation(
    app: AppHandle,
) -> Result<Option<MobileNavigationIntent>, AppCommandError> {
    app.ani_mobile()
        .consume_navigation()
        .map_err(|error| mobile_error("读取移动导航", error))
}

/// 原子读取并清除移动原生调度要求的前台补跑标记。
#[tauri::command]
pub(crate) fn consume_mobile_background_refresh(app: AppHandle) -> Result<bool, AppCommandError> {
    app.ani_mobile()
        .consume_background_refresh()
        .map_err(|error| mobile_error("读取移动后台补跑标记", error))
}

/// 由明确用户操作请求移动通知权限，并返回归一化结果。
#[tauri::command]
pub(crate) fn request_mobile_notification_permission(
    app: AppHandle,
) -> Result<String, AppCommandError> {
    app.notification()
        .request_permission()
        .map(permission_state_value)
        .map(str::to_owned)
        .map_err(|error| mobile_error("请求通知权限", error))
}

/// 将 Tauri 权限枚举映射为 Renderer 使用的稳定字符串。
fn permission_state_value(state: PermissionState) -> &'static str {
    match state {
        PermissionState::Granted => "granted",
        PermissionState::Denied => "denied",
        PermissionState::Prompt => "prompt",
        PermissionState::PromptWithRationale => "prompt-with-rationale",
    }
}

/// 将移动平台错误转换为稳定命令错误。
fn mobile_error(action: &str, error: impl std::fmt::Display) -> AppCommandError {
    log::error!("Tauri 移动平台命令失败 action={action} error={error}");
    AppCommandError {
        code: "mobile_platform_failed".to_owned(),
        message: format!("{action}失败：{error}"),
    }
}
