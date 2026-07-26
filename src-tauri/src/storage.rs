use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use ani_domain::AppSettings;
use ani_storage::{ReleaseSourceSeed, Storage, StorageError, StorageOptions, StorageSeed};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

const DATABASE_FILE_NAME: &str = "ani-tracker.sqlite";

/// Tauri 数据目录及设置默认值需要的平台目录。
#[derive(Debug, Clone)]
struct AppDirectories {
    app_data: PathBuf,
    cache: PathBuf,
    logs: PathBuf,
    downloads: PathBuf,
    config: PathBuf,
}

/// 向 Tauri commands 提供单写者 SQLite 和平台设置默认值。
pub(crate) struct AppStorageState {
    storage: Arc<Mutex<Storage>>,
    platform_defaults: AppSettings,
}

impl AppStorageState {
    /// 返回可跨异步任务共享的 SQLite 单写者。
    pub(crate) fn storage(&self) -> &Arc<Mutex<Storage>> {
        &self.storage
    }

    /// 返回当前宿主生成的平台设置默认值。
    pub(crate) fn platform_defaults(&self) -> &AppSettings {
        &self.platform_defaults
    }
}

/// 解析平台目录并完成 SQLite 复制、迁移和状态装配。
pub(crate) fn initialize(app: &AppHandle) -> Result<AppStorageState, StorageError> {
    let directories = resolve_directories(app)?;
    for directory in [
        &directories.app_data,
        &directories.cache,
        &directories.logs,
        &directories.downloads,
    ] {
        std::fs::create_dir_all(directory).map_err(|source| StorageError::FileOperation {
            operation: "创建 Tauri 应用目录",
            path: directory.clone(),
            source,
        })?;
    }
    let database_path = directories.app_data.join(DATABASE_FILE_NAME);
    let backup_directory = directories.app_data.join("backups");
    let platform_defaults = build_default_settings(&directories, &database_path, &backup_directory);
    let legacy_database_paths = legacy_database_candidates(&directories, &database_path);
    let seed = StorageSeed {
        settings: platform_defaults.clone(),
        dashboard: empty_dashboard(),
        release_sources: default_release_sources(),
    };
    let storage = Storage::open(StorageOptions {
        database_path,
        backup_directory,
        legacy_database_paths,
        seed,
    })?;
    #[cfg(mobile)]
    let storage = {
        let mut storage = storage;
        storage.set_secure_store(Arc::new(crate::secure_store::PlatformSecureStore::new(
            app.clone(),
        )));
        storage
    };

    log::info!(
        "Tauri SQLite 状态装配完成 database={} schema={} app_data={} copied_from={:?}",
        storage.database_path().display(),
        storage.report().schema_version,
        storage.report().app_data_version,
        storage.report().copied_from
    );
    Ok(AppStorageState {
        storage: Arc::new(Mutex::new(storage)),
        platform_defaults,
    })
}

/// 从 Tauri 路径解析器读取当前平台目录。
fn resolve_directories(app: &AppHandle) -> Result<AppDirectories, StorageError> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| path_error("解析应用数据目录", error))?;
    let cache = app
        .path()
        .app_cache_dir()
        .unwrap_or_else(|_| app_data.join("cache"));
    let logs = app
        .path()
        .app_log_dir()
        .unwrap_or_else(|_| app_data.join("logs"));
    #[cfg(desktop)]
    let downloads = app
        .path()
        .download_dir()
        .unwrap_or_else(|_| app_data.join("downloads"));
    #[cfg(mobile)]
    let downloads = app_data.join("downloads");
    let config = app
        .path()
        .app_config_dir()
        .unwrap_or_else(|_| app_data.clone());
    Ok(AppDirectories {
        app_data,
        cache,
        logs,
        downloads,
        config,
    })
}

/// 将 Tauri 路径解析错误转换为带操作上下文的数据层错误。
fn path_error(action: &'static str, error: tauri::Error) -> StorageError {
    StorageError::HostPath {
        action,
        detail: error.to_string(),
    }
}

/// 生成当前平台的完整默认设置，并保留移动端主题和本地下载能力。
fn build_default_settings(
    directories: &AppDirectories,
    database_path: &Path,
    backup_directory: &Path,
) -> AppSettings {
    let mobile = cfg!(any(target_os = "android", target_os = "ios"));
    let managed_qbittorrent = !mobile;
    let max_active_downloads = if mobile { 1 } else { 3 };
    let upnp_enabled = !mobile;
    let default_download_dir = directories.downloads.join("Ani Tracker");

    json!({
        "appearance": {
            "themeMode": "system",
            "themePackId": "default",
            "customThemePacks": []
        },
        "download": {
            "defaultDownloadDir": path_text(&default_download_dir),
            "createAnimeFolder": true,
            "animeFolderPattern": "{year}-{month}/{title}",
            "temporaryDownloadDir": path_text(&directories.app_data.join("incomplete")),
            "defaultTorrentEngine": "embedded",
            "embedded": {
                "enabled": true,
                "listenPort": 51413,
                "dhtEnabled": true,
                "upnpEnabled": upnp_enabled,
                "maxActiveDownloads": max_active_downloads,
                "maxDownloadSpeed": 0,
                "maxUploadSpeed": 0,
                "seedingLimits": seeding_limits()
            },
            "qbittorrent": {
                "baseUrl": "http://127.0.0.1:18080",
                "username": "admin",
                "password": "ani-tracker",
                "autoConnect": managed_qbittorrent,
                "downloadLimitKiBps": 0,
                "uploadLimitKiBps": 0,
                "seedingLimits": seeding_limits(),
                "managed": {
                    "enabled": managed_qbittorrent,
                    "profileDir": path_text(&directories.app_data.join("qbittorrent")),
                    "startupTimeoutMs": 15000
                }
            }
        },
        "storage": {
            "userDataDir": path_text(&directories.app_data),
            "databasePath": path_text(database_path),
            "cacheDir": path_text(&directories.cache),
            "logDir": path_text(&directories.logs),
            "backupDir": path_text(backup_directory)
        },
        "players": default_player_profiles(),
        "defaultPlayerProfileId": if mobile { "builtin" } else { "auto" },
        "automation": {
            "scheduledCheckEnabled": true,
            "checkIntervalMinutes": 30,
            "notifyOnNewEpisode": true,
            "autoDownloadEnabledGlobally": true,
            "fallbackWhenDefaultFansubMissing": "wait",
            "candidateFansubNames": []
        },
        "sourceSync": {
            "enabled": true,
            "dailyTime": "09:00"
        },
        "media": {
            "ffprobePath": if mobile { "" } else { "ffprobe" },
            "ffprobeTimeoutSeconds": 20,
            "videoExtensions": [".mkv", ".mp4", ".avi"]
        },
        "desktop": {
            "minimizeToTray": !mobile,
            "launchAtLogin": false
        },
        "network": {
            "metadataProxy": {
                "mode": "system",
                "timeoutMs": 15000
            },
            "remoteAccess": {
                "lanEnabled": false,
                "port": 18083
            }
        }
    })
}

/// 返回宿主必须覆盖的设置片段，避免移动备份恢复桌面专属能力。
pub(crate) fn platform_settings_constraints() -> Value {
    platform_settings_constraints_for(cfg!(mobile))
}

/// 生成可测试的平台约束，移动宿主不得启用桌面进程和路径能力。
fn platform_settings_constraints_for(mobile: bool) -> Value {
    if mobile {
        json!({
            "defaultPlayerProfileId": "builtin",
            "players": [],
            "download": {
                "qbittorrent": {
                    "autoConnect": false,
                    "managed": {
                        "enabled": false
                    }
                }
            },
            "media": {
                "ffprobePath": ""
            },
            "desktop": {
                "minimizeToTray": false,
                "launchAtLogin": false
            },
            "network": {
                "remoteAccess": {
                    "lanEnabled": false
                }
            }
        })
    } else {
        json!({})
    }
}

/// 将平台强制设置递归覆盖到 Renderer 提交的补丁。
pub(crate) fn constrain_settings_patch(patch: &mut Value) {
    merge_settings_value(patch, platform_settings_constraints());
}

/// 递归合并 JSON 对象；非对象节点由平台约束直接替换。
fn merge_settings_value(target: &mut Value, constraints: Value) {
    match (target, constraints) {
        (Value::Object(target), Value::Object(constraints)) => {
            for (key, value) in constraints {
                if let Some(existing) = target.get_mut(&key) {
                    merge_settings_value(existing, value);
                } else {
                    target.insert(key, value);
                }
            }
        }
        (target, constraints) => *target = constraints,
    }
}

/// 返回默认的关闭做种限制。
fn seeding_limits() -> Value {
    json!({
        "enabled": false,
        "ratioEnabled": false,
        "ratioLimit": 1,
        "timeEnabled": false,
        "timeLimitMinutes": 120
    })
}

/// 按编译目标生成桌面播放器模板；移动端不暴露可执行文件路径。
fn default_player_profiles() -> Value {
    if cfg!(any(target_os = "android", target_os = "ios")) {
        return json!([]);
    }
    if cfg!(target_os = "windows") {
        return json!([
            {
                "id": "pure-codec-potplayer",
                "name": "完美解码版 PotPlayer",
                "executablePath": "C:\\Program Files\\Pure Codec\\x64\\PotPlayerMini64.exe",
                "argumentTemplate": "\"{file}\"",
                "supportsMadVr": true,
                "platform": "windows"
            },
            {
                "id": "potplayer",
                "name": "PotPlayer",
                "executablePath": "C:\\Program Files\\DAUM\\PotPlayer\\PotPlayerMini64.exe",
                "argumentTemplate": "\"{file}\"",
                "supportsMadVr": true,
                "platform": "windows"
            },
            mpv_profile()
        ]);
    }
    if cfg!(target_os = "macos") {
        return json!([
            {
                "id": "iina",
                "name": "IINA",
                "executablePath": "/Applications/IINA.app/Contents/MacOS/iina-cli",
                "argumentTemplate": "--no-stdin \"{file}\"",
                "supportsMadVr": false,
                "platform": "macos"
            },
            mpv_profile()
        ]);
    }
    if cfg!(target_os = "linux") {
        return json!([
            {
                "id": "mpv",
                "name": "mpv",
                "executablePath": "/usr/bin/mpv",
                "argumentTemplate": "--force-window=yes \"{file}\"",
                "supportsMadVr": false,
                "platform": "linux"
            },
            {
                "id": "vlc",
                "name": "VLC",
                "executablePath": "/usr/bin/vlc",
                "argumentTemplate": "--play-and-exit \"{file}\"",
                "supportsMadVr": false,
                "platform": "linux"
            }
        ]);
    }
    json!([mpv_profile()])
}

/// 返回通用 mpv 播放器模板。
fn mpv_profile() -> Value {
    json!({
        "id": "mpv",
        "name": "mpv",
        "executablePath": "mpv",
        "argumentTemplate": "--force-window=yes \"{file}\"",
        "supportsMadVr": false,
        "platform": "any"
    })
}

/// 发现 Electron 可能使用的数据目录并按稳定顺序去重。
fn legacy_database_candidates(directories: &AppDirectories, database_path: &Path) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(parent) = directories.config.parent() {
        roots.push(parent.to_path_buf());
    }
    if let Some(parent) = directories.app_data.parent() {
        roots.push(parent.to_path_buf());
    }
    let mut seen = HashSet::new();
    roots
        .into_iter()
        .flat_map(|root| {
            ["Ani Tracker", "ani-tracker"]
                .into_iter()
                .map(move |name| root.join(name).join(DATABASE_FILE_NAME))
        })
        .filter(|candidate| candidate != database_path)
        .filter(|candidate| seen.insert(candidate.clone()))
        .collect()
}

/// 创建不含演示数据的首页 seed。
fn empty_dashboard() -> Value {
    json!({
        "dailyReminder": {
            "date": "1970-01-01",
            "total": 0,
            "upcoming": 0,
            "aired": 0,
            "downloading": 0,
            "downloaded": 0,
            "items": []
        },
        "todayEpisodes": [],
        "pendingActions": [],
        "activeDownloads": [],
        "recentCompleted": [],
        "weeklySchedule": [],
        "sourceHealth": []
    })
}

/// 返回与 Electron 首次启动一致的默认下载源。
fn default_release_sources() -> Vec<ReleaseSourceSeed> {
    vec![
        release_source(
            "mikan",
            "蜜柑计划 RSS",
            "rss",
            false,
            true,
            1_500,
            None,
            Some("https://mikanani.me/RSS/Bangumi"),
            &["anime", "rss"],
        ),
        release_source(
            "dmhy",
            "动漫花园",
            "site_adapter",
            false,
            true,
            1_500,
            Some("https://share.dmhy.org/"),
            None,
            &["anime", "bt"],
        ),
        release_source(
            "mikan-site",
            "蜜柑计划站点",
            "site_adapter",
            false,
            true,
            1_500,
            Some("https://mikanani.me/"),
            None,
            &["anime", "bt", "mikan"],
        ),
        release_source(
            "anibt",
            "AniBT",
            "site_adapter",
            true,
            false,
            3_000,
            Some("https://anibt.net/"),
            None,
            &["anime", "bt", "anibt", "rss"],
        ),
        release_source(
            "acgnx",
            "末日动漫资源库 ACGNX",
            "site_adapter",
            false,
            true,
            1_500,
            Some("https://share.acgnx.se/"),
            None,
            &["anime", "bt", "acgnx"],
        ),
        release_source(
            "nyaa",
            "Nyaa",
            "site_adapter",
            false,
            true,
            3_000,
            Some("https://nyaa.si/"),
            None,
            &["anime", "bt", "nyaa", "rss"],
        ),
        release_source(
            "acg-rip",
            "ACG.RIP",
            "site_adapter",
            false,
            true,
            3_000,
            Some("https://acg.rip/"),
            None,
            &["anime", "bt", "acg-rip", "rss"],
        ),
    ]
}

/// 创建单个默认下载源 seed。
#[allow(clippy::too_many_arguments)]
fn release_source(
    id: &str,
    name: &str,
    kind: &str,
    enabled: bool,
    use_proxy: bool,
    request_interval_ms: i64,
    base_url: Option<&str>,
    rss_url: Option<&str>,
    tags: &[&str],
) -> ReleaseSourceSeed {
    ReleaseSourceSeed {
        id: id.to_owned(),
        name: name.to_owned(),
        kind: kind.to_owned(),
        enabled,
        use_proxy,
        request_interval_ms,
        base_url: base_url.map(str::to_owned),
        api_key: None,
        rss_url: rss_url.map(str::to_owned),
        tags: tags.iter().map(|tag| (*tag).to_owned()).collect(),
    }
}

/// 将平台路径无损地转换为前端设置字符串。
fn path_text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::{
        build_default_settings, default_release_sources, legacy_database_candidates,
        merge_settings_value, platform_settings_constraints_for, AppDirectories,
    };
    use serde_json::json;

    /// 验证 Tauri 默认设置保留主题、内置下载和真实数据库路径。
    #[test]
    fn builds_complete_platform_defaults() {
        let directories = test_directories();
        let database_path = directories.app_data.join("ani-tracker.sqlite");
        let backup_directory = directories.app_data.join("backups");
        let settings = build_default_settings(&directories, &database_path, &backup_directory);

        assert_eq!(settings["appearance"]["themeMode"], "system");
        assert_eq!(settings["appearance"]["themePackId"], "default");
        assert_eq!(settings["download"]["defaultTorrentEngine"], "embedded");
        assert_eq!(settings["download"]["embedded"]["enabled"], true);
        assert_eq!(
            settings["storage"]["databasePath"],
            database_path.to_string_lossy().as_ref()
        );
        assert_eq!(default_release_sources().len(), 7);
    }

    /// 验证旧 Electron 数据库候选稳定去重且不包含活动库。
    #[test]
    fn discovers_legacy_database_candidates() {
        let directories = test_directories();
        let database_path = directories.app_data.join("ani-tracker.sqlite");
        let candidates = legacy_database_candidates(&directories, &database_path);

        assert!(candidates
            .iter()
            .any(|path| path.ends_with("Ani Tracker/ani-tracker.sqlite")));
        assert!(candidates
            .iter()
            .any(|path| path.ends_with("ani-tracker/ani-tracker.sqlite")));
        assert!(!candidates.contains(&database_path));
        let mut unique = candidates.clone();
        unique.sort();
        unique.dedup();
        assert_eq!(unique.len(), candidates.len());
    }

    /// 验证移动设置约束会关闭桌面进程能力并保留外部 qBittorrent 配置。
    #[test]
    fn constrains_restored_mobile_settings() {
        let mut settings = json!({
            "defaultPlayerProfileId": "mpv",
            "players": [{ "id": "mpv" }],
            "download": {
                "qbittorrent": {
                    "baseUrl": "https://qb.example.test",
                    "managed": { "enabled": true }
                }
            },
            "media": { "ffprobePath": "/usr/bin/ffprobe" },
            "desktop": { "minimizeToTray": true },
            "network": { "remoteAccess": { "lanEnabled": true } }
        });

        merge_settings_value(&mut settings, platform_settings_constraints_for(true));

        assert_eq!(settings["defaultPlayerProfileId"], "builtin");
        assert_eq!(settings["players"], json!([]));
        assert_eq!(
            settings["download"]["qbittorrent"]["managed"]["enabled"],
            false
        );
        assert_eq!(
            settings["download"]["qbittorrent"]["baseUrl"],
            "https://qb.example.test"
        );
        assert_eq!(settings["media"]["ffprobePath"], "");
        assert_eq!(settings["desktop"]["minimizeToTray"], false);
        assert_eq!(settings["network"]["remoteAccess"]["lanEnabled"], false);
    }

    /// 创建不依赖宿主环境的路径样本。
    fn test_directories() -> AppDirectories {
        AppDirectories {
            app_data: PathBuf::from("C:/Data/com.ani.tracker"),
            cache: PathBuf::from("C:/Cache/com.ani.tracker"),
            logs: PathBuf::from("C:/Logs/com.ani.tracker"),
            downloads: PathBuf::from("C:/Downloads"),
            config: PathBuf::from("C:/Config/com.ani.tracker"),
        }
    }
}
