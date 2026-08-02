use ani_contracts::{
    AppCommandError, DesktopMediaToolsStatus, LocalMediaImportJobStatus, LocalMediaImportSelection,
    LocalMediaSourceSummary,
};
use ani_domain::MediaFile;
use ani_media::MediaScanResult;
use tauri::{AppHandle, State};
#[cfg(desktop)]
use tauri_plugin_dialog::{DialogExt, FilePath};

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

/// 选择本机目录并立即启动后台媒体扫描。
#[cfg(desktop)]
#[tauri::command]
pub(crate) async fn start_local_media_import(
    app: AppHandle,
    state: State<'_, AppMediaState>,
) -> Result<Option<LocalMediaImportJobStatus>, AppCommandError> {
    let dialog_app = app.clone();
    let selected = tauri::async_runtime::spawn_blocking(move || {
        dialog_app
            .dialog()
            .file()
            .set_title("选择本地番剧目录")
            .blocking_pick_folder()
    })
    .await
    .map_err(|error| media_error("打开本地媒体目录选择器", error))?;
    let Some(selected) = selected else {
        return Ok(None);
    };
    let FilePath::Path(source_root) = selected else {
        return Err(media_error("扫描本地媒体", "只支持本机文件系统目录"));
    };
    log::info!(
        "Tauri 本地媒体后台扫描已请求 source_root={}",
        source_root.display()
    );
    state
        .start_local_media_import(source_root)
        .map(Some)
        .map_err(|error| media_error("扫描本地媒体", error))
}

/// 移动端暂不开放跨目录原地导入。
#[cfg(mobile)]
#[tauri::command]
pub(crate) async fn start_local_media_import(
    _app: AppHandle,
    _state: State<'_, AppMediaState>,
) -> Result<Option<LocalMediaImportJobStatus>, AppCommandError> {
    Err(media_error(
        "扫描本地媒体",
        "Android 与 iOS 暂不支持选择外部目录原地导入",
    ))
}

/// 读取当前本地媒体后台任务状态。
#[tauri::command]
pub(crate) async fn get_local_media_import_status(
    state: State<'_, AppMediaState>,
) -> Result<LocalMediaImportJobStatus, AppCommandError> {
    Ok(state.local_media_import_status())
}

/// 按用户选择继续导入低置信度候选。
#[cfg(desktop)]
#[tauri::command]
pub(crate) async fn confirm_local_media_import(
    job_id: String,
    selections: Vec<LocalMediaImportSelection>,
    state: State<'_, AppMediaState>,
) -> Result<LocalMediaImportJobStatus, AppCommandError> {
    state
        .confirm_local_media_import(&job_id, selections)
        .map_err(|error| media_error("确认本地媒体匹配", error))
}

/// 移动端拒绝桌面目录导入确认请求。
#[cfg(mobile)]
#[tauri::command]
pub(crate) async fn confirm_local_media_import(
    _job_id: String,
    _selections: Vec<LocalMediaImportSelection>,
    _state: State<'_, AppMediaState>,
) -> Result<LocalMediaImportJobStatus, AppCommandError> {
    Err(media_error(
        "确认本地媒体匹配",
        "Android 与 iOS 暂不支持外部目录原地导入",
    ))
}

/// 请求取消当前扫描、导入或校验任务。
#[tauri::command]
pub(crate) async fn cancel_local_media_import(
    state: State<'_, AppMediaState>,
) -> Result<LocalMediaImportJobStatus, AppCommandError> {
    Ok(state.cancel_local_media_import())
}

/// 启动全部已登记媒体的后台可用性校验。
#[tauri::command]
pub(crate) async fn start_media_availability_check(
    state: State<'_, AppMediaState>,
) -> Result<LocalMediaImportJobStatus, AppCommandError> {
    state
        .start_media_availability_check()
        .map_err(|error| media_error("校验媒体可用性", error))
}

/// 汇总原地导入目录及问题文件数量。
#[tauri::command]
pub(crate) async fn list_local_media_sources(
    state: State<'_, AppMediaState>,
) -> Result<Vec<LocalMediaSourceSummary>, AppCommandError> {
    state
        .list_local_media_sources()
        .map_err(|error| media_error("读取本地媒体目录", error))
}

fn media_error(action: &str, error: impl std::fmt::Display) -> AppCommandError {
    log::error!("Tauri 媒体命令失败 action={action} error={error}");
    AppCommandError {
        code: "media_operation_failed".to_owned(),
        message: format!("{action}失败：{error}"),
    }
}
