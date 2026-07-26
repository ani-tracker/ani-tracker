use std::sync::Arc;

use ani_contracts::{AppCommandError, PlayerDetectionResult, SelectPlayerExecutableInput};
use ani_domain::AppSettings;
use ani_repository::SettingsRepository;
use serde_json::Value;
use tauri::{AppHandle, State};
#[cfg(mobile)]
use tauri_plugin_ani_mobile::AniMobileExt;
use url::Url;

use crate::media::AppMediaState;
use crate::storage::AppStorageState;

/// 将桌面外部播放器错误转换为稳定命令错误。
fn map_external_error(action: &str, error: impl std::fmt::Display) -> AppCommandError {
    log::error!("Tauri 外部能力失败 action={action} error={error}");
    AppCommandError {
        code: "desktop_external_operation_failed".to_owned(),
        message: format!("{action}失败：{error}"),
    }
}

/// 在线程池读取播放器所需的完整设置。
async fn load_settings(state: &AppStorageState) -> Result<AppSettings, AppCommandError> {
    let storage = Arc::clone(state.storage());
    let defaults = state.platform_defaults().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let storage = storage
            .lock()
            .map_err(|error| map_external_error("读取播放器设置", error))?;
        storage
            .repository()
            .get_settings(&defaults)
            .map_err(|error| map_external_error("读取播放器设置", error))
    })
    .await
    .map_err(|error| map_external_error("读取播放器设置", error))?
}

/// 解析并校验允许交给系统处理的外部链接。
fn validate_external_url(url: &str) -> Result<Url, AppCommandError> {
    let parsed = Url::parse(url).map_err(|error| AppCommandError {
        code: "invalid_external_url".to_string(),
        message: format!("外部链接格式无效: {error}"),
    })?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err(AppCommandError {
            code: "unsupported_external_url_scheme".to_string(),
            message: "仅允许打开包含有效主机的 HTTP 或 HTTPS 外部链接".to_string(),
        });
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(AppCommandError {
            code: "external_url_credentials_forbidden".to_string(),
            message: "外部链接不能包含用户名或密码".to_string(),
        });
    }
    Ok(parsed)
}

/// 使用系统默认程序打开经过协议白名单校验的外部链接。
#[tauri::command]
pub(crate) fn open_external(url: String, app: AppHandle) -> Result<(), AppCommandError> {
    let parsed = validate_external_url(&url)?;

    log::info!(
        "准备打开外部链接 scheme={} host={}",
        parsed.scheme(),
        parsed.host_str().unwrap_or("unknown")
    );

    #[cfg(desktop)]
    {
        let _ = app;
        open::that_detached(parsed.as_str()).map_err(|error| AppCommandError {
            code: "open_external_failed".to_string(),
            message: format!("系统无法打开外部链接: {error}"),
        })?;
        Ok(())
    }

    #[cfg(mobile)]
    {
        app.ani_mobile()
            .open_external(parsed.as_str())
            .map_err(|error| AppCommandError {
                code: "open_external_failed".to_string(),
                message: format!("系统无法打开外部链接: {error}"),
            })
    }
}

/// 探测当前桌面平台的外部播放器。
#[tauri::command]
pub(crate) async fn detect_players(
    profiles: Option<Vec<Value>>,
    storage: State<'_, AppStorageState>,
) -> Result<PlayerDetectionResult, AppCommandError> {
    #[cfg(desktop)]
    {
        let settings = load_settings(&storage).await?;
        crate::external_player::detect_players(&settings, profiles)
            .map_err(|error| map_external_error("探测播放器", error))
    }
    #[cfg(not(desktop))]
    {
        let _ = (profiles, storage);
        Err(map_external_error("探测播放器", "移动端不支持外部播放器"))
    }
}

/// 使用系统文件选择器选择外部播放器程序。
#[tauri::command]
pub(crate) async fn select_player_executable(
    input: SelectPlayerExecutableInput,
    app: AppHandle,
) -> Result<Option<String>, AppCommandError> {
    #[cfg(desktop)]
    {
        crate::external_player::select_player_executable(app, input)
            .await
            .map_err(|error| map_external_error("选择播放器程序", error))
    }
    #[cfg(not(desktop))]
    {
        let _ = (input, app);
        Err(map_external_error(
            "选择播放器程序",
            "移动端不支持外部播放器",
        ))
    }
}

/// 使用设置中的外部播放器播放受控媒体。
#[tauri::command]
pub(crate) async fn play_media(
    file_path: String,
    profile_id: Option<String>,
    storage: State<'_, AppStorageState>,
    media: State<'_, AppMediaState>,
) -> Result<(), AppCommandError> {
    #[cfg(desktop)]
    {
        let settings = load_settings(&storage).await?;
        crate::external_player::play_media(
            media.inner(),
            &settings,
            &file_path,
            profile_id.as_deref(),
        )
        .map_err(|error| map_external_error("启动外部播放器", error))
    }
    #[cfg(not(desktop))]
    {
        let _ = (file_path, profile_id, storage, media);
        Err(map_external_error(
            "启动外部播放器",
            "移动端仅支持内置 libVLC",
        ))
    }
}

/// 在文件管理器中定位受控媒体文件。
#[tauri::command]
pub(crate) fn reveal_media(
    file_path: String,
    media: State<'_, AppMediaState>,
) -> Result<(), AppCommandError> {
    #[cfg(desktop)]
    {
        crate::external_player::reveal_media(media.inner(), &file_path)
            .map_err(|error| map_external_error("定位媒体文件", error))
    }
    #[cfg(not(desktop))]
    {
        let _ = (file_path, media);
        Err(map_external_error(
            "定位媒体文件",
            "移动端不提供桌面文件管理器",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::validate_external_url;

    /// 验证外链命令只接受 HTTP 与 HTTPS 协议。
    #[test]
    fn validates_external_url_scheme() {
        assert!(validate_external_url("https://example.com/anime/1").is_ok());
        assert!(validate_external_url("https://用户:密码@example.com/anime/1").is_err());
        assert!(validate_external_url("https://").is_err());
        assert!(validate_external_url("file:///C:/sensitive.txt").is_err());
        assert!(validate_external_url("javascript:alert(1)").is_err());
    }
}
