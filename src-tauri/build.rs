use std::{env, fs, io, path::PathBuf};

/// 生成 Tauri 平台配置和资源绑定。
fn main() {
    clear_stale_macos_qbittorrent_resources().expect("清理 macOS qBittorrent 资源缓存失败");
    tauri_build::build();
}

/// 删除 Rust cache 恢复的只读 qBittorrent 副本，确保 Tauri 可重新复制资源。
fn clear_stale_macos_qbittorrent_resources() -> io::Result<()> {
    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos") {
        return Ok(());
    }
    let Some(out_dir) = env::var_os("OUT_DIR").map(PathBuf::from) else {
        return Ok(());
    };
    let Some(profile_dir) = out_dir.ancestors().nth(3) else {
        return Ok(());
    };
    let cached_resources = profile_dir.join("qbittorrent");
    if cached_resources.exists() {
        fs::remove_dir_all(&cached_resources)?;
        println!(
            "cargo:warning=macOS qBittorrent 旧资源缓存已清理：{}",
            cached_resources.display()
        );
    }
    Ok(())
}
