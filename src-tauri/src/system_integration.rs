use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use ani_domain::{AppSettings, AutomationRunResult, NotificationRecord};
use tauri::{AppHandle, Manager, Runtime, Theme, Window, WindowEvent};
use tauri_plugin_notification::NotificationExt;

#[cfg(desktop)]
use tauri::{
    menu::MenuBuilder,
    tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent},
    window::Color,
};
#[cfg(desktop)]
use tauri_plugin_autostart::ManagerExt;

#[cfg(desktop)]
const MAIN_WINDOW_LABEL: &str = "main";
#[cfg(desktop)]
const TRAY_SHOW_ID: &str = "tray-show-main";
#[cfg(desktop)]
const TRAY_SCAN_ID: &str = "tray-run-automation";
#[cfg(desktop)]
const TRAY_QUIT_ID: &str = "tray-quit";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct DesktopRuntimeSettings {
    minimize_to_tray: bool,
    launch_at_login: bool,
    theme: NativeThemeSetting,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NativeThemeSetting {
    System,
    Light,
    Dark,
}

impl DesktopRuntimeSettings {
    /// 从版本化设置 JSON 中提取桌面系统集成字段。
    fn from_settings(settings: &AppSettings) -> Self {
        let theme = match settings
            .pointer("/appearance/themeMode")
            .and_then(serde_json::Value::as_str)
        {
            Some("light") => NativeThemeSetting::Light,
            Some("dark") => NativeThemeSetting::Dark,
            _ => NativeThemeSetting::System,
        };
        Self {
            minimize_to_tray: settings
                .pointer("/desktop/minimizeToTray")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(true),
            launch_at_login: settings
                .pointer("/desktop/launchAtLogin")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false),
            theme,
        }
    }
}

/// 保存 Tauri 宿主级托盘、退出策略和原生主题状态。
pub(crate) struct AppSystemIntegrationState {
    settings: Mutex<DesktopRuntimeSettings>,
    quitting: AtomicBool,
    #[cfg(desktop)]
    tray: Option<TrayIcon>,
}

impl AppSystemIntegrationState {
    /// 创建系统集成状态，并按持久化设置初始化平台能力。
    pub(crate) fn initialize(app: &AppHandle, settings: &AppSettings) -> Self {
        let runtime_settings = DesktopRuntimeSettings::from_settings(settings);
        #[cfg(desktop)]
        let tray = match build_tray(app) {
            Ok(tray) => Some(tray),
            Err(error) => {
                log::error!("Tauri 托盘初始化失败 error={error}");
                None
            }
        };
        let state = Self {
            settings: Mutex::new(runtime_settings),
            quitting: AtomicBool::new(false),
            #[cfg(desktop)]
            tray,
        };
        state.apply_settings(app, settings);
        state
    }

    /// 设置保存后同步托盘、开机启动和原生主题。
    pub(crate) fn apply_settings(&self, app: &AppHandle, settings: &AppSettings) {
        let next = DesktopRuntimeSettings::from_settings(settings);
        let previous = match self.settings.lock() {
            Ok(mut current) => {
                let previous = *current;
                *current = next;
                previous
            }
            Err(error) => {
                log::error!("Tauri 系统集成设置锁失败 error={error}");
                next
            }
        };

        #[cfg(desktop)]
        {
            if let Some(tray) = &self.tray {
                if let Err(error) = tray.set_visible(next.minimize_to_tray) {
                    log::error!("Tauri 托盘可见性更新失败 error={error}");
                }
            } else if next.minimize_to_tray {
                log::warn!("Tauri 托盘不可用，关闭到托盘策略不会生效");
            }
            if previous.launch_at_login != next.launch_at_login {
                apply_launch_at_login(app, next.launch_at_login);
            } else {
                reconcile_launch_at_login(app, next.launch_at_login);
            }
            apply_native_theme(app, next.theme);
        }

        log::info!(
            "Tauri 系统集成设置已应用 minimize_to_tray={} launch_at_login={} theme={:?}",
            next.minimize_to_tray,
            next.launch_at_login,
            next.theme
        );
    }

    /// 标记应用进入真实退出流程，后续关闭事件不再隐藏窗口。
    pub(crate) fn prepare_to_quit(&self) {
        self.quitting.store(true, Ordering::Release);
    }

    /// 判断主窗口关闭事件是否应转换为隐藏到托盘。
    #[cfg(desktop)]
    fn should_hide_main_window(&self) -> bool {
        let minimize_to_tray = self
            .settings
            .lock()
            .map(|settings| settings.minimize_to_tray)
            .unwrap_or(false);
        minimize_to_tray && self.tray.is_some() && !self.quitting.load(Ordering::Acquire)
    }
}

/// 将最新设置同步到已注册的宿主系统集成状态。
pub(crate) fn apply_settings(app: &AppHandle, settings: &AppSettings) {
    if let Some(state) = app.try_state::<AppSystemIntegrationState>() {
        state.apply_settings(app, settings);
    }
}

/// 处理关闭到托盘和系统主题变化。
pub(crate) fn handle_window_event<R: Runtime>(window: &Window<R>, event: &WindowEvent) {
    #[cfg(desktop)]
    match event {
        WindowEvent::CloseRequested { api, .. } if window.label() == MAIN_WINDOW_LABEL => {
            let should_hide = window
                .app_handle()
                .try_state::<AppSystemIntegrationState>()
                .is_some_and(|state| state.should_hide_main_window());
            if should_hide {
                api.prevent_close();
                if let Err(error) = window.hide() {
                    log::error!("Tauri 主窗口隐藏到托盘失败 error={error}");
                } else {
                    log::info!("Tauri 主窗口已隐藏到托盘");
                }
            }
        }
        WindowEvent::ThemeChanged(theme) => {
            apply_window_background(window, *theme);
        }
        _ => {}
    }
}

/// 显示自动扫描结果的原生系统通知。
pub(crate) fn notify_automation_result(
    app: &AppHandle,
    settings: &AppSettings,
    result: &AutomationRunResult,
) {
    let downloaded = result.downloaded.len();
    let errors = result.errors.len();
    if downloaded == 0 && errors == 0 {
        return;
    }
    let mut parts = Vec::new();
    if downloaded > 0 {
        parts.push(format!("已添加 {downloaded} 个下载任务"));
    }
    if errors > 0 {
        parts.push(format!("{errors} 个任务失败"));
    }
    notify(app, settings, "追番更新扫描完成", &parts.join("，"));
}

/// 显示自动扫描调度错误的原生系统通知。
pub(crate) fn notify_scheduler_error(app: &AppHandle, settings: &AppSettings, message: &str) {
    notify(app, settings, "追番更新扫描失败", message);
}

/// 显示提醒中心记录对应的原生系统通知。
pub(crate) fn notify_reminder(
    app: &AppHandle,
    settings: &AppSettings,
    record: &NotificationRecord,
) {
    notify(app, settings, &record.title, &record.body);
}

/// 根据通知设置发送平台原生通知，失败时保留应用内提醒记录。
fn notify(app: &AppHandle, settings: &AppSettings, title: &str, body: &str) {
    let enabled = settings
        .pointer("/automation/notifyOnNewEpisode")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(true);
    if !enabled {
        return;
    }
    if let Err(error) = app.notification().builder().title(title).body(body).show() {
        log::warn!("Tauri 系统通知发送失败 title={title} error={error}");
    }
}

#[cfg(desktop)]
/// 创建托盘菜单和图标，并绑定主窗口、扫描与退出动作。
fn build_tray(app: &AppHandle) -> tauri::Result<TrayIcon> {
    let menu = MenuBuilder::new(app)
        .text(TRAY_SHOW_ID, "显示主窗口")
        .text(TRAY_SCAN_ID, "扫描更新")
        .separator()
        .text(TRAY_QUIT_ID, "退出")
        .build()?;
    let mut builder = TrayIconBuilder::with_id("ani-tracker-tray")
        .menu(&menu)
        .tooltip("Ani Tracker")
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            TRAY_SHOW_ID => show_main_window(app),
            TRAY_SCAN_ID => run_automation_from_tray(app),
            TRAY_QUIT_ID => quit_from_tray(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                show_main_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    let tray = builder.build(app)?;
    tray.set_visible(false)?;
    Ok(tray)
}

#[cfg(desktop)]
/// 显示、还原并聚焦 Tauri 主窗口。
pub(crate) fn show_main_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        log::error!("Tauri 主窗口不存在，无法从托盘恢复");
        return;
    };
    for result in [window.show(), window.unminimize(), window.set_focus()] {
        if let Err(error) = result {
            log::warn!("Tauri 主窗口恢复操作失败 error={error}");
        }
    }
}

#[cfg(desktop)]
/// 从托盘触发一次带人工冷却保护的自动扫描。
fn run_automation_from_tray(app: &AppHandle) {
    let automation = app
        .state::<crate::automation::AppAutomationState>()
        .inner()
        .clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = automation.run_now(true, "tray").await {
            log::error!("Tauri 托盘自动扫描失败 error={error}");
        }
    });
}

#[cfg(desktop)]
/// 从托盘进入完整退出流程。
fn quit_from_tray(app: &AppHandle) {
    if let Some(state) = app.try_state::<AppSystemIntegrationState>() {
        state.prepare_to_quit();
    }
    log::info!("Tauri 托盘请求退出应用");
    app.exit(0);
}

#[cfg(desktop)]
/// 将开机启动状态与持久化设置对齐。
fn reconcile_launch_at_login(app: &AppHandle, enabled: bool) {
    match app.autolaunch().is_enabled() {
        Ok(current) if current == enabled => {}
        Ok(_) => apply_launch_at_login(app, enabled),
        Err(error) => log::warn!("Tauri 开机启动状态读取失败 error={error}"),
    }
}

#[cfg(desktop)]
/// 启用或停用当前平台开机启动项。
fn apply_launch_at_login(app: &AppHandle, enabled: bool) {
    let result = if enabled {
        app.autolaunch().enable()
    } else {
        app.autolaunch().disable()
    };
    match result {
        Ok(()) => log::info!("Tauri 开机启动设置已更新 enabled={enabled}"),
        Err(error) => log::error!("Tauri 开机启动设置更新失败 enabled={enabled} error={error}"),
    }
}

#[cfg(desktop)]
/// 将应用主题同步到全部原生窗口和 WebView 背景。
fn apply_native_theme(app: &AppHandle, setting: NativeThemeSetting) {
    let requested = match setting {
        NativeThemeSetting::System => None,
        NativeThemeSetting::Light => Some(Theme::Light),
        NativeThemeSetting::Dark => Some(Theme::Dark),
    };
    for window in app.webview_windows().values() {
        if let Err(error) = window.set_theme(requested) {
            log::warn!(
                "Tauri 原生窗口主题更新失败 label={} error={error}",
                window.label()
            );
            continue;
        }
        let resolved = requested
            .or_else(|| window.theme().ok())
            .unwrap_or(Theme::Light);
        if let Err(error) = window.set_background_color(Some(background_color(resolved))) {
            log::warn!(
                "Tauri WebView 背景更新失败 label={} error={error}",
                window.label()
            );
        }
    }
}

#[cfg(desktop)]
/// 更新原生窗口和 WebView 背景，避免主题切换时闪白。
fn apply_window_background<R: Runtime>(window: &Window<R>, theme: Theme) {
    if let Err(error) = window.set_background_color(Some(background_color(theme))) {
        log::warn!(
            "Tauri 窗口背景更新失败 label={} error={error}",
            window.label()
        );
    }
}

#[cfg(desktop)]
/// 返回与 Renderer 基础色一致的原生窗口背景色。
fn background_color(theme: Theme) -> Color {
    match theme {
        Theme::Dark => Color(21, 22, 25, 255),
        _ => Color(248, 250, 252, 255),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{DesktopRuntimeSettings, NativeThemeSetting};

    /// 验证桌面系统设置从公共 JSON 契约稳定解析。
    #[test]
    fn parses_desktop_runtime_settings() {
        let settings = json!({
            "desktop": { "minimizeToTray": false, "launchAtLogin": true },
            "appearance": { "themeMode": "dark" }
        });
        assert_eq!(
            DesktopRuntimeSettings::from_settings(&settings),
            DesktopRuntimeSettings {
                minimize_to_tray: false,
                launch_at_login: true,
                theme: NativeThemeSetting::Dark,
            }
        );
    }

    /// 验证缺失或无效字段回退到跨平台默认值。
    #[test]
    fn defaults_invalid_desktop_runtime_settings() {
        let settings = json!({ "appearance": { "themeMode": "unknown" } });
        assert_eq!(
            DesktopRuntimeSettings::from_settings(&settings),
            DesktopRuntimeSettings {
                minimize_to_tray: true,
                launch_at_login: false,
                theme: NativeThemeSetting::System,
            }
        );
    }
}
