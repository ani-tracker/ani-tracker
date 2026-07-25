use std::sync::Arc;

use log::LevelFilter;
use tauri::Manager;

mod automation;
mod commands;
mod downloads;
mod qbittorrent_managed;
mod source_sync;
mod sources;
mod storage;

/// 装配并启动 Tauri 应用宿主。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(LevelFilter::Info)
                .build(),
        )
        .setup(|app| {
            let storage_state = storage::initialize(app.handle())?;
            let source_state = sources::AppSourceState::new();
            let source_sync_state = source_sync::AppSourceSyncState::new(
                Arc::clone(storage_state.storage()),
                storage_state.platform_defaults().clone(),
                source_state.clone(),
            );
            source_sync_state.start();
            let download_state = downloads::AppDownloadState::new(
                app.handle(),
                Arc::clone(storage_state.storage()),
                storage_state.platform_defaults().clone(),
            )?;
            download_state.start();
            let automation_state = automation::AppAutomationState::new(
                Arc::clone(storage_state.storage()),
                storage_state.platform_defaults().clone(),
                source_state.clone(),
                Arc::new(automation::TauriAutomaticDownloadExecutor::new(
                    download_state.clone(),
                )),
            );
            automation_state.start();
            let reminder_storage = Arc::clone(storage_state.storage());
            tauri::async_runtime::spawn_blocking(move || {
                let result = reminder_storage
                    .lock()
                    .map_err(|error| error.to_string())
                    .and_then(|storage| {
                        ani_automation::DailyReminderService::run_once(
                            &storage.repository(),
                            chrono::Utc::now(),
                        )
                        .map_err(|error| error.to_string())
                    });
                match result {
                    Ok(Some(record)) => {
                        log::info!("Tauri 每日追番提醒已写入 id={}", record.id);
                    }
                    Ok(None) => {}
                    Err(error) => {
                        log::error!("Tauri 每日追番提醒执行失败 error={error}");
                    }
                }
            });
            app.manage(storage_state);
            app.manage(source_state);
            app.manage(source_sync_state);
            app.manage(download_state);
            app.manage(automation_state);
            log::info!(
                "Tauri 宿主初始化完成 platform={} arch={}",
                std::env::consts::OS,
                std::env::consts::ARCH
            );
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::data::get_dashboard,
            commands::data::get_settings,
            commands::data::update_settings,
            commands::data::reset_settings_to_defaults,
            commands::data::list_notifications,
            commands::data::get_unread_notification_count,
            commands::data::list_my_anime,
            commands::data::upsert_my_anime,
            commands::data::remove_my_anime,
            commands::data::list_my_anime_watch_progress,
            commands::data::set_anime_watch_progress,
            commands::data::report_playback_progress,
            commands::data::save_playback_checkpoint,
            commands::data::list_episodes,
            commands::data::upsert_episode,
            commands::data::list_episode_preferences,
            commands::data::upsert_episode_preference,
            commands::data::remove_episode_preference,
            commands::data::list_anime_catalog,
            commands::data::search_anime_catalog,
            commands::data::get_anime_detail,
            commands::data::list_fansubs,
            commands::data::list_sources,
            commands::data::set_source_enabled,
            commands::data::upsert_source,
            commands::sources::search_releases,
            commands::sources::search_anime_releases,
            commands::sources::search_rss_subscription_releases,
            commands::sources::get_anime_source_binding_state,
            commands::sources::confirm_anime_source_binding,
            commands::sources::report_anime_source_candidate_mismatch,
            commands::sources::remove_anime_source_candidate_mismatch,
            commands::sources::set_anime_source_excluded,
            commands::sources::remove_anime_source_binding,
            commands::source_sync::get_source_sync_status,
            commands::source_sync::sync_sources_now,
            commands::automation::get_automation_scheduler_status,
            commands::automation::run_automation_once,
            commands::automation::restart_automation_scheduler,
            commands::downloads::list_downloads,
            commands::downloads::test_qbittorrent,
            commands::downloads::get_download_service_status,
            commands::downloads::get_qbittorrent_managed_status,
            commands::downloads::start_qbittorrent_managed,
            commands::downloads::stop_qbittorrent_managed,
            commands::downloads::get_embedded_torrent_status,
            commands::downloads::start_embedded_torrent,
            commands::downloads::stop_embedded_torrent,
            commands::downloads::restart_embedded_torrent,
            commands::downloads::refresh_downloads,
            commands::downloads::pause_download,
            commands::downloads::resume_download,
            commands::downloads::remove_download,
            commands::downloads::set_download_file_priority,
            commands::downloads::add_download_url,
            commands::downloads::add_release_download,
            commands::window::get_window_state,
            commands::window::minimize_window,
            commands::window::toggle_maximize_window,
            commands::window::close_window,
            commands::external::open_external
        ])
        .on_window_event(commands::handle_window_event);

    let app = match builder.build(tauri::generate_context!()) {
        Ok(app) => app,
        Err(error) => {
            eprintln!("[tauri] 应用宿主构建失败: {error}");
            return;
        }
    };
    app.run(|app_handle, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            log::info!("Tauri 宿主退出，开始关闭下载引擎");
            let state = app_handle.state::<downloads::AppDownloadState>();
            tauri::async_runtime::block_on(state.shutdown());
        }
    });
}
