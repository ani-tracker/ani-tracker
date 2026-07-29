use std::{env, fs, io, path::PathBuf};

const TRUSTED_ORIGINS_ENV: &str = "ANI_TRUSTED_ORIGINS";

/// 生成 Tauri 平台配置和资源绑定。
fn main() {
    export_trusted_origins().expect("加载 ANI_TRUSTED_ORIGINS 失败");
    clear_stale_macos_qbittorrent_resources().expect("清理 macOS qBittorrent 资源缓存失败");
    tauri_build::build();
}

/// 将进程环境或仓库 .env 中的可信来源注入 Rust 编译结果。
fn export_trusted_origins() -> io::Result<()> {
    println!("cargo:rerun-if-env-changed={TRUSTED_ORIGINS_ENV}");
    let manifest_directory =
        PathBuf::from(env::var("CARGO_MANIFEST_DIR").map_err(io::Error::other)?);
    let env_path = manifest_directory.join("../.env");
    println!("cargo:rerun-if-changed={}", env_path.display());
    let value = match env::var(TRUSTED_ORIGINS_ENV) {
        Ok(value) => Some(value),
        Err(env::VarError::NotPresent) if env_path.is_file() => dotenvy::from_path_iter(&env_path)
            .map_err(io::Error::other)?
            .find_map(|entry| match entry {
                Ok((key, value)) if key == TRUSTED_ORIGINS_ENV => Some(Ok(value)),
                Ok(_) => None,
                Err(error) => Some(Err(io::Error::other(error))),
            })
            .transpose()?,
        Err(env::VarError::NotPresent) => None,
        Err(error) => return Err(io::Error::other(error)),
    };
    if let Some(value) = value
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
    {
        if value.contains('\r') || value.contains('\n') {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "ANI_TRUSTED_ORIGINS 不能包含换行",
            ));
        }
        println!("cargo:rustc-env={TRUSTED_ORIGINS_ENV}={value}");
    }
    Ok(())
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
