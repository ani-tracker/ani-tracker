use log::LevelFilter;

/// 装配并启动 Tauri 应用宿主。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(LevelFilter::Info)
                .build(),
        )
        .setup(|_| {
            log::info!(
                "Tauri 宿主初始化完成 platform={} arch={}",
                std::env::consts::OS,
                std::env::consts::ARCH
            );
            Ok(())
        });

    if let Err(error) = builder.run(tauri::generate_context!()) {
        eprintln!("[tauri] 应用宿主运行失败: {error}");
    }
}
