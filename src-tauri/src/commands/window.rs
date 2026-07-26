use ani_contracts::{AppCommandError, AppWindowState};
use tauri::{Emitter, Runtime, WebviewWindow, Window, WindowEvent};

const WINDOW_STATE_CHANGED_EVENT: &str = "window-state-changed";

/// 将 Tauri 窗口错误转换为稳定命令错误。
fn map_window_error(action: &str, error: tauri::Error) -> AppCommandError {
    AppCommandError {
        code: "window_operation_failed".to_string(),
        message: format!("{action}失败: {error}"),
    }
}

/// 返回移动端不支持桌面窗口操作的稳定命令错误。
#[cfg(mobile)]
fn unsupported_window_operation(action: &str) -> AppCommandError {
    log::warn!("移动端拒绝桌面窗口操作 action={action}");
    AppCommandError {
        code: "window_operation_unsupported".to_string(),
        message: format!("移动端不支持{action}"),
    }
}

/// 读取当前窗口是否最大化。
#[tauri::command]
pub(crate) fn get_window_state(window: WebviewWindow) -> Result<AppWindowState, AppCommandError> {
    window
        .is_maximized()
        .map(|maximized| AppWindowState { maximized })
        .map_err(|error| map_window_error("读取窗口状态", error))
}

/// 最小化当前 Tauri 窗口。
#[tauri::command]
pub(crate) fn minimize_window(window: WebviewWindow) -> Result<(), AppCommandError> {
    #[cfg(desktop)]
    {
        log::info!("执行窗口最小化 label={}", window.label());
        window
            .minimize()
            .map_err(|error| map_window_error("最小化窗口", error))
    }
    #[cfg(mobile)]
    {
        let _ = window;
        Err(unsupported_window_operation("最小化窗口"))
    }
}

/// 在最大化和还原状态之间切换当前 Tauri 窗口。
#[tauri::command]
pub(crate) fn toggle_maximize_window(
    window: WebviewWindow,
) -> Result<AppWindowState, AppCommandError> {
    #[cfg(desktop)]
    {
        let maximized = window
            .is_maximized()
            .map_err(|error| map_window_error("读取窗口状态", error))?;
        if maximized {
            window
                .unmaximize()
                .map_err(|error| map_window_error("还原窗口", error))?;
        } else {
            window
                .maximize()
                .map_err(|error| map_window_error("最大化窗口", error))?;
        }

        let next = AppWindowState {
            maximized: !maximized,
        };
        log::info!(
            "窗口最大化状态已切换 label={} maximized={}",
            window.label(),
            next.maximized
        );
        Ok(next)
    }
    #[cfg(mobile)]
    {
        let _ = window;
        Err(unsupported_window_operation("切换窗口最大化状态"))
    }
}

/// 关闭当前 Tauri 窗口。
#[tauri::command]
pub(crate) fn close_window(window: WebviewWindow) -> Result<(), AppCommandError> {
    log::info!("执行窗口关闭 label={}", window.label());
    window
        .close()
        .map_err(|error| map_window_error("关闭窗口", error))
}

/// 将系统窗口状态变化发布给 Renderer。
pub(crate) fn handle_window_event<R: Runtime>(window: &Window<R>, event: &WindowEvent) {
    if !matches!(event, WindowEvent::Resized(_)) {
        return;
    }

    match window.is_maximized() {
        Ok(maximized) => {
            if let Err(error) =
                window.emit(WINDOW_STATE_CHANGED_EVENT, AppWindowState { maximized })
            {
                log::warn!(
                    "窗口状态事件发布失败 label={} error={error}",
                    window.label()
                );
            }
        }
        Err(error) => {
            log::warn!(
                "窗口状态变化后读取失败 label={} error={error}",
                window.label()
            );
        }
    }
}
