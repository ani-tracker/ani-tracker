use ani_contracts::{
    AppCommandError, DesktopPlaybackSessionInput, DesktopPlayerWindowDragInput,
    DesktopPlayerWindowInput, PlaybackSession, PlayerCapabilities, PlayerCommand,
    PlayerCommandResult,
};
use tauri::State;

use crate::player::AppPlayerState;

fn command_error(code: &str, message: String) -> AppCommandError {
    AppCommandError {
        code: code.to_owned(),
        message,
    }
}

/// 打开 Tauri 桌面 libVLC 双窗口。
#[tauri::command]
pub(crate) async fn open_desktop_player_window(
    input: DesktopPlayerWindowInput,
    state: State<'_, AppPlayerState>,
) -> Result<(), AppCommandError> {
    state
        .open_desktop_window(input)
        .await
        .map_err(|message| command_error("player_window_open_failed", message))
}

/// 关闭 Tauri 桌面 libVLC 双窗口。
#[tauri::command]
pub(crate) async fn close_desktop_player_window(
    state: State<'_, AppPlayerState>,
) -> Result<(), AppCommandError> {
    state
        .close_desktop_window()
        .await
        .map_err(|message| command_error("player_window_close_failed", message))
}

/// 将桌面播放器拖动阶段交给平台窗口协调器。
#[tauri::command]
pub(crate) fn drag_desktop_player_window(
    input: DesktopPlayerWindowDragInput,
    state: State<'_, AppPlayerState>,
) -> Result<(), AppCommandError> {
    state
        .drag_desktop_window(input)
        .map_err(|message| command_error("player_window_drag_failed", message))
}

/// 创建只向 Renderer 暴露临时 URI 的播放会话。
#[tauri::command]
pub(crate) fn create_desktop_playback_session(
    input: DesktopPlaybackSessionInput,
    state: State<'_, AppPlayerState>,
) -> Result<PlaybackSession, AppCommandError> {
    state
        .create_session(input)
        .map_err(|message| command_error("player_session_create_failed", message))
}

/// 关闭播放会话并移除真实路径映射。
#[tauri::command]
pub(crate) fn close_desktop_playback_session(
    session_id: String,
    state: State<'_, AppPlayerState>,
) -> Result<(), AppCommandError> {
    state
        .close_session(&session_id)
        .map_err(|message| command_error("player_session_close_failed", message))
}

/// 读取当前 Tauri libVLC 后端能力。
#[tauri::command]
pub(crate) async fn get_desktop_player_capabilities(
    state: State<'_, AppPlayerState>,
) -> Result<PlayerCapabilities, AppCommandError> {
    Ok(state.capabilities().await)
}

/// 向统一播放器服务发送一条命令。
#[tauri::command]
pub(crate) async fn dispatch_desktop_player_command(
    command: PlayerCommand,
    state: State<'_, AppPlayerState>,
) -> Result<PlayerCommandResult, AppCommandError> {
    Ok(state.dispatch(command).await)
}
