use std::sync::Arc;

use ani_contracts::AppCommandError;
use ani_domain::AppSettings;
use ani_repository::SettingsRepository;
use tauri::{AppHandle, State};
#[cfg(mobile)]
use tauri_plugin_ani_mobile::AniMobileExt;
use tauri_plugin_dialog::{DialogExt, FilePath};

use crate::automation::AppAutomationState;
use crate::downloads::AppDownloadState;
use crate::player::AppPlayerState;
use crate::source_sync::AppSourceSyncState;
use crate::storage::AppStorageState;

/// 通过系统保存面板导出包含 WAL 内容的一致性 SQLite 备份。
#[tauri::command]
pub(crate) async fn export_database_backup(
    app: AppHandle,
    state: State<'_, AppStorageState>,
) -> Result<Option<String>, AppCommandError> {
    let file_name = format!(
        "ani-tracker-backup-{}.sqlite",
        chrono::Utc::now().format("%Y%m%d-%H%M%S")
    );
    let dialog_app = app.clone();
    let dialog_file_name = file_name.clone();
    let selected = tauri::async_runtime::spawn_blocking(move || {
        dialog_app
            .dialog()
            .file()
            .set_title("导出 Ani Tracker 数据备份")
            .set_file_name(dialog_file_name)
            .add_filter("SQLite 数据库", &["sqlite"])
            .blocking_save_file()
    })
    .await
    .map_err(|error| runtime_error("打开备份导出面板", error))?;
    let Some(selected) = selected else {
        return Ok(None);
    };

    match selected {
        FilePath::Path(path) => {
            #[cfg(target_os = "ios")]
            {
                let url = url::Url::from_file_path(&path)
                    .map_err(|_| runtime_error("导出 iOS 数据备份", "路径无法转换为 file URL"))?;
                export_mobile_document(&app, state.inner(), url.as_str()).await?;
            }
            #[cfg(not(target_os = "ios"))]
            export_to_path(state.inner(), path).await?;
        }
        FilePath::Url(url) if url.scheme() == "file" => {
            #[cfg(target_os = "ios")]
            export_mobile_document(&app, state.inner(), url.as_str()).await?;
            #[cfg(not(target_os = "ios"))]
            {
                let path = url
                    .to_file_path()
                    .map_err(|_| runtime_error("导出数据备份", "file URL 无法转换为本地路径"))?;
                export_to_path(state.inner(), path).await?;
            }
        }
        #[cfg(target_os = "android")]
        FilePath::Url(url) if url.scheme() == "content" => {
            let storage = Arc::clone(state.storage());
            let snapshot = tauri::async_runtime::spawn_blocking(move || {
                storage
                    .lock()
                    .map_err(|error| error.to_string())?
                    .create_manual_backup()
                    .map_err(|error| error.to_string())
            })
            .await
            .map_err(|error| runtime_error("创建 Android 数据快照", error))?
            .map_err(|error| runtime_error("创建 Android 数据快照", error))?;
            app.ani_mobile()
                .export_document(url.as_str(), &snapshot.to_string_lossy())
                .map_err(|error| runtime_error("写入 Android 系统文档", error))?;
        }
        FilePath::Url(url) => {
            return Err(runtime_error(
                "导出数据备份",
                format!("不支持的文档协议：{}", url.scheme()),
            ));
        }
    }
    log::info!("Tauri 数据备份已导出 file={file_name}");
    Ok(Some(file_name))
}

/// 创建一致性快照后交给移动原生插件写入系统文档。
#[cfg(mobile)]
async fn export_mobile_document(
    app: &AppHandle,
    state: &AppStorageState,
    uri: &str,
) -> Result<(), AppCommandError> {
    let storage = Arc::clone(state.storage());
    let snapshot = tauri::async_runtime::spawn_blocking(move || {
        storage
            .lock()
            .map_err(|error| error.to_string())?
            .create_manual_backup()
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| runtime_error("创建移动数据快照", error))?
    .map_err(|error| runtime_error("创建移动数据快照", error))?;
    app.ani_mobile()
        .export_document(uri, &snapshot.to_string_lossy())
        .map_err(|error| runtime_error("写入移动系统文档", error))
}

/// 选择并恢复 SQLite 备份，失败时重启原有下载配置。
#[tauri::command]
pub(crate) async fn restore_database_backup(
    app: AppHandle,
    state: State<'_, AppStorageState>,
    source_sync_state: State<'_, AppSourceSyncState>,
    automation_state: State<'_, AppAutomationState>,
    download_state: State<'_, AppDownloadState>,
    player_state: State<'_, AppPlayerState>,
) -> Result<Option<String>, AppCommandError> {
    let dialog_app = app.clone();
    let selected = tauri::async_runtime::spawn_blocking(move || {
        dialog_app
            .dialog()
            .file()
            .set_title("选择 Ani Tracker 数据备份")
            .add_filter("SQLite 数据库", &["sqlite", "db"])
            .blocking_pick_file()
    })
    .await
    .map_err(|error| runtime_error("打开备份恢复面板", error))?;
    let Some(selected) = selected else {
        return Ok(None);
    };
    let (source_path, _import_guard) =
        super::downloads::resolve_selected_document(&app, selected, "backup")?;
    let defaults = state.platform_defaults().clone();
    let previous_settings = read_settings(state.inner(), defaults.clone()).await?;

    player_state.shutdown().await;
    download_state.shutdown().await;
    let storage = Arc::clone(state.storage());
    let restore_defaults = defaults.clone();
    let restore_result = tauri::async_runtime::spawn_blocking(move || {
        let mut storage = storage.lock().map_err(|error| error.to_string())?;
        let rollback = storage
            .restore_from(&source_path)
            .map_err(|error| error.to_string())?;
        let settings = storage
            .repository()
            .update_settings(
                &crate::storage::platform_settings_constraints(),
                &restore_defaults,
            )
            .map_err(|error| error.to_string())?;
        Ok::<_, String>((rollback, settings))
    })
    .await
    .map_err(|error| runtime_error("恢复数据备份", error))?;

    let (rollback, settings) = match restore_result {
        Ok(result) => result,
        Err(error) => {
            if let Err(restart_error) = download_state
                .refresh_from_settings(&previous_settings)
                .await
            {
                log::error!("数据恢复失败后重启原下载配置失败 error={restart_error}");
            }
            return Err(runtime_error("恢复数据备份", error));
        }
    };
    apply_restored_settings(
        &app,
        &settings,
        &source_sync_state,
        &automation_state,
        &download_state,
    )
    .await;
    let rollback_name = rollback
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("pre-restore.sqlite")
        .to_owned();
    log::info!("Tauri 数据备份恢复完成 rollback={rollback_name}");
    Ok(Some(rollback_name))
}

/// 在线程池中将活动数据库导出到本地路径。
async fn export_to_path(
    state: &AppStorageState,
    target: std::path::PathBuf,
) -> Result<(), AppCommandError> {
    let storage = Arc::clone(state.storage());
    tauri::async_runtime::spawn_blocking(move || {
        storage
            .lock()
            .map_err(|error| error.to_string())?
            .export_to(&target)
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| runtime_error("导出数据备份", error))?
    .map_err(|error| runtime_error("导出数据备份", error))
}

/// 从 SQLite 读取当前设置，供恢复失败时重启原下载引擎。
async fn read_settings(
    state: &AppStorageState,
    defaults: AppSettings,
) -> Result<AppSettings, AppCommandError> {
    let storage = Arc::clone(state.storage());
    tauri::async_runtime::spawn_blocking(move || {
        storage
            .lock()
            .map_err(|error| error.to_string())?
            .repository()
            .get_settings(&defaults)
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| runtime_error("读取恢复前设置", error))?
    .map_err(|error| runtime_error("读取恢复前设置", error))
}

/// 将恢复后的设置同步到调度、下载、系统集成和桌面远程网关。
async fn apply_restored_settings(
    app: &AppHandle,
    settings: &AppSettings,
    source_sync_state: &AppSourceSyncState,
    automation_state: &AppAutomationState,
    download_state: &AppDownloadState,
) {
    source_sync_state.refresh_from_settings(settings).await;
    automation_state.refresh_from_settings(settings).await;
    if let Err(error) = download_state.refresh_from_settings(settings).await {
        log::error!("恢复备份后应用下载设置失败 error={error}");
    }
    crate::system_integration::apply_settings(app, settings);
    #[cfg(desktop)]
    crate::remote::apply_settings(app, settings).await;
    super::downloads::emit_download_service_status_changed(app);
}

/// 将备份命令失败转换为稳定错误。
fn runtime_error(action: &str, error: impl std::fmt::Display) -> AppCommandError {
    log::error!("Tauri 数据备份命令失败 action={action} error={error}");
    AppCommandError {
        code: "data_backup_failed".to_owned(),
        message: format!("{action}失败：{error}"),
    }
}
