use log::LevelFilter;
use tauri::Manager;

mod commands;
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
            app.manage(storage_state);
            app.manage(sources::AppSourceState::new());
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
            commands::window::get_window_state,
            commands::window::minimize_window,
            commands::window::toggle_maximize_window,
            commands::window::close_window,
            commands::external::open_external
        ])
        .on_window_event(commands::handle_window_event);

    if let Err(error) = builder.run(tauri::generate_context!()) {
        eprintln!("[tauri] 应用宿主运行失败: {error}");
    }
}
