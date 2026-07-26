#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

/// 启动桌面端 Tauri 应用。
fn main() {
    ani_tracker_tauri_lib::run();
}
