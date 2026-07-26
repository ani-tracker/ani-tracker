use ani_contracts::{AppCommandError, DesktopMediaToolsStatus};
use ani_domain::MediaFile;
use ani_media::MediaScanResult;
use tauri::State;

use crate::media::AppMediaState;

/// 读取全部已登记媒体文件。
#[tauri::command]
pub(crate) async fn list_media_files(
    state: State<'_, AppMediaState>,
) -> Result<Vec<MediaFile>, AppCommandError> {
    state
        .list_media_files()
        .map_err(|error| media_error("读取媒体文件", error))
}

/// 手动扫描一个下载任务中的已完成视频文件。
#[tauri::command]
pub(crate) async fn scan_download_media(
    task_id: String,
    state: State<'_, AppMediaState>,
) -> Result<MediaScanResult, AppCommandError> {
    state
        .scan_download_task(&task_id)
        .await
        .map_err(|error| media_error("扫描下载媒体", error))
}

/// 读取桌面 FFprobe 与 FFmpeg 的解析和版本状态。
#[tauri::command]
pub(crate) async fn get_desktop_media_tools_status(
    state: State<'_, AppMediaState>,
) -> Result<DesktopMediaToolsStatus, AppCommandError> {
    Ok(state.media_tools_status().await)
}

fn media_error(action: &str, error: impl std::fmt::Display) -> AppCommandError {
    log::error!("Tauri 媒体命令失败 action={action} error={error}");
    AppCommandError {
        code: "media_operation_failed".to_owned(),
        message: format!("{action}失败：{error}"),
    }
}
