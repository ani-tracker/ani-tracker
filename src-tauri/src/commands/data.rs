use std::sync::{Arc, Mutex};

use ani_contracts::AppCommandError;
use ani_domain::{
    Anime, AnimeDetailResult, AnimeDiscoverySearchResult, AnimeWatchProgress, AppSettings,
    DashboardData, Episode, EpisodePreference, FansubGroup, MyAnime, NotificationRecord,
    PlaybackCheckpoint, ReleaseSourceConfig, ReportPlaybackProgressInput,
    SavePlaybackCheckpointInput, SetAnimeWatchProgressInput,
};
use ani_repository::{prelude::*, RepositoryError};
use ani_storage::Storage;
use serde_json::Value;
use tauri::{AppHandle, State};

use crate::automation::AppAutomationState;
use crate::downloads::AppDownloadState;
use crate::source_sync::AppSourceSyncState;
use crate::storage::AppStorageState;

/// 将数据层错误转换为稳定的 Tauri 命令错误。
fn map_repository_error(action: &str, error: RepositoryError) -> AppCommandError {
    log::error!("Tauri 数据命令失败 action={action} error={error}");
    let code = match &error {
        RepositoryError::InvalidInput { .. } => "invalid_input",
        RepositoryError::RecordNotFound { .. } => "record_not_found",
        RepositoryError::BackendUnavailable { .. } => "storage_unavailable",
        _ => "storage_operation_failed",
    };
    AppCommandError {
        code: code.to_owned(),
        message: format!("{action}失败：{error}"),
    }
}

/// 将线程池或锁错误转换为稳定的内部错误。
fn map_runtime_error(action: &str, error: impl std::fmt::Display) -> AppCommandError {
    log::error!("Tauri 数据运行时失败 action={action} error={error}");
    AppCommandError {
        code: "storage_runtime_failed".to_owned(),
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
    F: FnOnce(&Storage) -> Result<T, RepositoryError> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || {
        let guard = storage
            .lock()
            .map_err(|error| map_runtime_error(action, error))?;
        query(&guard).map_err(|error| map_repository_error(action, error))
    })
    .await
    .map_err(|error| map_runtime_error(action, error))?
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

/// 递归合并应用设置，并保护宿主路径字段。
#[tauri::command]
pub(crate) async fn update_settings(
    patch: Value,
    app: AppHandle,
    state: State<'_, AppStorageState>,
    source_sync_state: State<'_, AppSourceSyncState>,
    automation_state: State<'_, AppAutomationState>,
    download_state: State<'_, AppDownloadState>,
) -> Result<AppSettings, AppCommandError> {
    let defaults = state.platform_defaults().clone();
    let settings = run_query("更新设置", Arc::clone(state.storage()), move |storage| {
        storage.repository().update_settings(&patch, &defaults)
    })
    .await?;
    source_sync_state.refresh_from_settings(&settings).await;
    automation_state.refresh_from_settings(&settings).await;
    if let Err(error) = download_state.refresh_from_settings(&settings).await {
        log::error!("Tauri 下载设置应用失败 error={error}");
    }
    crate::system_integration::apply_settings(&app, &settings);
    crate::commands::downloads::emit_download_service_status_changed(&app);
    Ok(settings)
}

/// 恢复当前平台默认设置。
#[tauri::command]
pub(crate) async fn reset_settings_to_defaults(
    app: AppHandle,
    state: State<'_, AppStorageState>,
    source_sync_state: State<'_, AppSourceSyncState>,
    automation_state: State<'_, AppAutomationState>,
    download_state: State<'_, AppDownloadState>,
) -> Result<AppSettings, AppCommandError> {
    let defaults = state.platform_defaults().clone();
    let settings = run_query(
        "恢复默认设置",
        Arc::clone(state.storage()),
        move |storage| storage.repository().reset_settings(&defaults),
    )
    .await?;
    source_sync_state.refresh_from_settings(&settings).await;
    automation_state.refresh_from_settings(&settings).await;
    if let Err(error) = download_state.refresh_from_settings(&settings).await {
        log::error!("Tauri 默认下载设置应用失败 error={error}");
    }
    crate::system_integration::apply_settings(&app, &settings);
    crate::commands::downloads::emit_download_service_status_changed(&app);
    Ok(settings)
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

/// 将指定通知标记为已读。
#[tauri::command]
pub(crate) async fn mark_notification_read(
    notification_id: String,
    state: State<'_, AppStorageState>,
) -> Result<Vec<NotificationRecord>, AppCommandError> {
    run_query(
        "标记通知已读",
        Arc::clone(state.storage()),
        move |storage| {
            NotificationRepository::mark_notification_read(&storage.repository(), &notification_id)
        },
    )
    .await
}

/// 将全部通知标记为已读。
#[tauri::command]
pub(crate) async fn mark_all_notifications_read(
    state: State<'_, AppStorageState>,
) -> Result<Vec<NotificationRecord>, AppCommandError> {
    run_query(
        "标记全部通知已读",
        Arc::clone(state.storage()),
        |storage| NotificationRepository::mark_all_notifications_read(&storage.repository()),
    )
    .await
}

/// 清空提醒中心全部通知。
#[tauri::command]
pub(crate) async fn clear_notifications(
    state: State<'_, AppStorageState>,
) -> Result<Vec<NotificationRecord>, AppCommandError> {
    run_query("清空通知", Arc::clone(state.storage()), |storage| {
        NotificationRepository::clear_notifications(&storage.repository())
    })
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

/// 新增或更新追番规则。
#[tauri::command]
pub(crate) async fn upsert_my_anime(
    item: MyAnime,
    state: State<'_, AppStorageState>,
) -> Result<Vec<MyAnime>, AppCommandError> {
    run_query("保存追番", Arc::clone(state.storage()), move |storage| {
        storage.repository().upsert_my_anime(item)
    })
    .await
}

/// 删除追番及其单集业务数据。
#[tauri::command]
pub(crate) async fn remove_my_anime(
    item_id: String,
    state: State<'_, AppStorageState>,
) -> Result<Vec<MyAnime>, AppCommandError> {
    run_query("删除追番", Arc::clone(state.storage()), move |storage| {
        storage.repository().remove_my_anime(&item_id)
    })
    .await
}

/// 读取全部追番观看进度。
#[tauri::command]
pub(crate) async fn list_my_anime_watch_progress(
    state: State<'_, AppStorageState>,
) -> Result<Vec<AnimeWatchProgress>, AppCommandError> {
    run_query(
        "读取观看进度",
        Arc::clone(state.storage()),
        |storage| storage.repository().list_my_anime_watch_progress(),
    )
    .await
}

/// 原子更新单部追番观看进度。
#[tauri::command]
pub(crate) async fn set_anime_watch_progress(
    input: SetAnimeWatchProgressInput,
    state: State<'_, AppStorageState>,
) -> Result<AnimeWatchProgress, AppCommandError> {
    run_query(
        "更新观看进度",
        Arc::clone(state.storage()),
        move |storage| storage.repository().set_anime_watch_progress(&input),
    )
    .await
}

/// 按播放百分比回写单集已看状态。
#[tauri::command]
pub(crate) async fn report_playback_progress(
    input: ReportPlaybackProgressInput,
    state: State<'_, AppStorageState>,
) -> Result<bool, AppCommandError> {
    run_query(
        "回写播放进度",
        Arc::clone(state.storage()),
        move |storage| storage.repository().report_playback_progress(&input),
    )
    .await
}

/// 保存下载文件的续播检查点。
#[tauri::command]
pub(crate) async fn save_playback_checkpoint(
    input: SavePlaybackCheckpointInput,
    state: State<'_, AppStorageState>,
) -> Result<PlaybackCheckpoint, AppCommandError> {
    run_query(
        "保存续播位置",
        Arc::clone(state.storage()),
        move |storage| storage.repository().save_playback_checkpoint(&input),
    )
    .await
}

/// 读取指定番剧单集。
#[tauri::command]
pub(crate) async fn list_episodes(
    anime_id: String,
    state: State<'_, AppStorageState>,
) -> Result<Vec<Episode>, AppCommandError> {
    run_query("读取单集", Arc::clone(state.storage()), move |storage| {
        storage.repository().list_episodes(&anime_id)
    })
    .await
}

/// 新增或更新单集。
#[tauri::command]
pub(crate) async fn upsert_episode(
    episode: Episode,
    state: State<'_, AppStorageState>,
) -> Result<Vec<Episode>, AppCommandError> {
    run_query("保存单集", Arc::clone(state.storage()), move |storage| {
        storage.repository().upsert_episode(&episode)
    })
    .await
}

/// 读取指定番剧单集偏好。
#[tauri::command]
pub(crate) async fn list_episode_preferences(
    anime_id: String,
    state: State<'_, AppStorageState>,
) -> Result<Vec<EpisodePreference>, AppCommandError> {
    run_query(
        "读取单集偏好",
        Arc::clone(state.storage()),
        move |storage| storage.repository().list_episode_preferences(&anime_id),
    )
    .await
}

/// 新增或更新单集偏好。
#[tauri::command]
pub(crate) async fn upsert_episode_preference(
    preference: EpisodePreference,
    state: State<'_, AppStorageState>,
) -> Result<Vec<EpisodePreference>, AppCommandError> {
    run_query(
        "保存单集偏好",
        Arc::clone(state.storage()),
        move |storage| storage.repository().upsert_episode_preference(&preference),
    )
    .await
}

/// 删除单集偏好。
#[tauri::command]
pub(crate) async fn remove_episode_preference(
    episode_id: String,
    state: State<'_, AppStorageState>,
) -> Result<Vec<EpisodePreference>, AppCommandError> {
    run_query(
        "删除单集偏好",
        Arc::clone(state.storage()),
        move |storage| storage.repository().remove_episode_preference(&episode_id),
    )
    .await
}

/// 按可选年月读取本地番剧目录。
#[tauri::command]
pub(crate) async fn list_anime_catalog(
    year: Option<i64>,
    month: Option<i64>,
    state: State<'_, AppStorageState>,
) -> Result<Vec<Anime>, AppCommandError> {
    run_query(
        "读取番剧目录",
        Arc::clone(state.storage()),
        move |storage| storage.repository().list_anime_catalog(year, month),
    )
    .await
}

/// 按标题、原名和别名搜索本地番剧目录。
#[tauri::command]
pub(crate) async fn search_anime_catalog(
    keyword: String,
    state: State<'_, AppStorageState>,
) -> Result<AnimeDiscoverySearchResult, AppCommandError> {
    run_query(
        "搜索番剧目录",
        Arc::clone(state.storage()),
        move |storage| storage.repository().search_anime_catalog(&keyword),
    )
    .await
}

/// 读取本地番剧详情聚合数据。
#[tauri::command]
pub(crate) async fn get_anime_detail(
    anime_id: String,
    state: State<'_, AppStorageState>,
) -> Result<AnimeDetailResult, AppCommandError> {
    run_query(
        "读取番剧详情",
        Arc::clone(state.storage()),
        move |storage| storage.repository().get_anime_detail(&anime_id),
    )
    .await
}

/// 读取全部或指定番剧的字幕组。
#[tauri::command]
pub(crate) async fn list_fansubs(
    anime_id: Option<String>,
    state: State<'_, AppStorageState>,
) -> Result<Vec<FansubGroup>, AppCommandError> {
    run_query(
        "读取字幕组",
        Arc::clone(state.storage()),
        move |storage| storage.repository().list_fansubs(anime_id.as_deref()),
    )
    .await
}

/// 读取全部下载源配置。
#[tauri::command]
pub(crate) async fn list_sources(
    state: State<'_, AppStorageState>,
) -> Result<Vec<ReleaseSourceConfig>, AppCommandError> {
    run_query(
        "读取下载源",
        Arc::clone(state.storage()),
        move |storage| storage.repository().list_sources(),
    )
    .await
}

/// 启用或停用一个下载源。
#[tauri::command]
pub(crate) async fn set_source_enabled(
    source_id: String,
    enabled: bool,
    state: State<'_, AppStorageState>,
) -> Result<Vec<ReleaseSourceConfig>, AppCommandError> {
    run_query(
        "更新下载源状态",
        Arc::clone(state.storage()),
        move |storage| storage.repository().set_source_enabled(&source_id, enabled),
    )
    .await
}

/// 新增或更新一个下载源配置。
#[tauri::command]
pub(crate) async fn upsert_source(
    source: ReleaseSourceConfig,
    state: State<'_, AppStorageState>,
) -> Result<Vec<ReleaseSourceConfig>, AppCommandError> {
    run_query(
        "保存下载源",
        Arc::clone(state.storage()),
        move |storage| storage.repository().upsert_source(&source),
    )
    .await
}
