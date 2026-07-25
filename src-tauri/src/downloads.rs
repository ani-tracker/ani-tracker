use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use ani_domain::{
    AppSettings, DownloadTask, Release, SubtitleLanguage, SubtitlePreference, TorrentEngineKind,
};
use ani_downloads::{
    DownloadEngineConfig, DownloadEngineRegistry, DownloadServiceError, DownloadSource,
    DownloadTaskContext, DownloadTaskService, DownloadTaskStore, SeedingLimits, TorrentCoreEngine,
};
#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
use ani_downloads::{ProcessTorrentCoreTransport, TorrentCoreProcessOptions};
use ani_repository::{DownloadRepository, RepositoryError, RepositoryResult, SettingsRepository};
use ani_sources::{HttpMethod, NativeHttpClient, NativeHttpRequest};
use ani_storage::Storage;
use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::sources::native_http_config;

static TORRENT_IMPORT_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// 将 Tauri 的 SQLite 单写者适配为线程安全下载任务存储端口。
struct SharedDownloadTaskStore {
    storage: Arc<Mutex<Storage>>,
}

impl SharedDownloadTaskStore {
    /// 创建复用应用 SQLite 连接的下载存储适配器。
    fn new(storage: Arc<Mutex<Storage>>) -> Self {
        Self { storage }
    }

    /// 在短临界区内执行 Repository 操作。
    fn with_repository<T>(
        &self,
        operation: impl FnOnce(&dyn DownloadRepository) -> RepositoryResult<T>,
    ) -> RepositoryResult<T> {
        let storage = self
            .storage
            .lock()
            .map_err(|error| RepositoryError::BackendUnavailable {
                backend: "sqlite".to_owned(),
                message: error.to_string(),
            })?;
        operation(&storage.repository())
    }
}

impl DownloadTaskStore for SharedDownloadTaskStore {
    fn list_downloads(&self) -> RepositoryResult<Vec<DownloadTask>> {
        self.with_repository(|repository| repository.list_downloads())
    }

    fn upsert_download_task(&self, task: &DownloadTask) -> RepositoryResult<Vec<DownloadTask>> {
        self.with_repository(|repository| repository.upsert_download_task(task))
    }

    fn remove_download_task(&self, task_id: &str) -> RepositoryResult<Vec<DownloadTask>> {
        self.with_repository(|repository| repository.remove_download_task(task_id))
    }
}

/// Tauri 生命周期内共享下载服务、引擎注册表和临时种子目录。
#[derive(Clone)]
pub(crate) struct AppDownloadState {
    service: Arc<DownloadTaskService>,
    registry: Arc<DownloadEngineRegistry>,
    storage: Arc<Mutex<Storage>>,
    platform_defaults: AppSettings,
    torrent_import_directory: PathBuf,
}

impl AppDownloadState {
    /// 创建 Tauri 下载状态并在桌面注册 torrent-core sidecar。
    pub(crate) fn new(
        app: &AppHandle,
        storage: Arc<Mutex<Storage>>,
        platform_defaults: AppSettings,
    ) -> Result<Self, String> {
        let mut registry = DownloadEngineRegistry::new();
        #[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
        {
            let binary_path = resolve_torrent_core_binary(app);
            let data_directory =
                setting_path(&platform_defaults, "/storage/userDataDir")?.join("torrent-core");
            let transport = Arc::new(ProcessTorrentCoreTransport::new(
                TorrentCoreProcessOptions::new(binary_path.clone(), data_directory),
            ));
            registry
                .register(Arc::new(TorrentCoreEngine::new(transport)))
                .map_err(|error| error.to_string())?;
            log::info!(
                "Tauri torrent-core transport 已装配 binary={}",
                binary_path.display()
            );
        }
        let registry = Arc::new(registry);
        let store = Arc::new(SharedDownloadTaskStore::new(Arc::clone(&storage)));
        let service = Arc::new(DownloadTaskService::new(Arc::clone(&registry), store));
        let torrent_import_directory =
            setting_path(&platform_defaults, "/storage/cacheDir")?.join("torrent-imports");
        Ok(Self {
            service,
            registry,
            storage,
            platform_defaults,
            torrent_import_directory,
        })
    }

    /// 返回 commands 和自动扫描共用的任务服务。
    pub(crate) fn service(&self) -> &Arc<DownloadTaskService> {
        &self.service
    }

    /// 从 SQLite 读取当前下载设置。
    pub(crate) fn settings(&self) -> Result<AppSettings, String> {
        let storage = self
            .storage
            .lock()
            .map_err(|error| format!("读取下载设置失败：{error}"))?;
        storage
            .repository()
            .get_settings(&self.platform_defaults)
            .map_err(|error| format!("读取下载设置失败：{error}"))
    }

    /// 读取当前设置选择的默认下载引擎。
    pub(crate) fn default_engine(
        &self,
        settings: &AppSettings,
    ) -> Result<TorrentEngineKind, DownloadServiceError> {
        match settings
            .pointer("/download/defaultTorrentEngine")
            .and_then(Value::as_str)
        {
            Some("embedded") | None => Ok(TorrentEngineKind::Embedded),
            Some("qbittorrent") => Ok(TorrentEngineKind::Qbittorrent),
            Some(value) => Err(DownloadServiceError::InvalidInput {
                field: "defaultTorrentEngine",
                message: format!("未知下载引擎：{value}"),
            }),
        }
    }

    /// 启动或刷新内置核心配置；配置失败不阻止 Tauri 首屏启动。
    pub(crate) fn start(&self) {
        let state = self.clone();
        tauri::async_runtime::spawn(async move {
            let settings = match state.settings() {
                Ok(settings) => settings,
                Err(error) => {
                    log::error!("Tauri 下载服务读取启动设置失败：{error}");
                    return;
                }
            };
            if let Err(error) = state.refresh_from_settings(&settings).await {
                log::error!("Tauri 下载引擎启动失败：{error}");
            }
        });
    }

    /// 设置变化后立即应用内置核心参数，关闭时请求恢复数据落盘。
    pub(crate) async fn refresh_from_settings(&self, settings: &AppSettings) -> Result<(), String> {
        let enabled = settings
            .pointer("/download/embedded/enabled")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        if !enabled {
            let failures = self.registry.shutdown_all().await;
            return failures
                .first()
                .map(|(_, error)| Err(error.to_string()))
                .unwrap_or(Ok(()));
        }
        let engine = self
            .registry
            .require(&TorrentEngineKind::Embedded)
            .map_err(|error| error.to_string())?;
        engine
            .configure(&download_engine_config(settings))
            .await
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    /// 下载远程 torrent 到受限临时目录，磁链直接返回。
    pub(crate) async fn prepare_source(
        &self,
        url: &str,
        settings: &AppSettings,
    ) -> Result<PreparedDownloadSource, String> {
        let url = url.trim();
        if url.to_ascii_lowercase().starts_with("magnet:?") {
            return Ok(PreparedDownloadSource {
                source: DownloadSource::Magnet(url.to_owned()),
                temporary_file: None,
            });
        }
        let parsed = url::Url::parse(url).map_err(|error| format!("种子地址无效：{error}"))?;
        if !matches!(parsed.scheme(), "http" | "https") {
            return Err("种子地址仅允许 magnet、HTTP 或 HTTPS".to_owned());
        }
        let client = NativeHttpClient::new(native_http_config(settings))
            .map_err(|error| format!("创建种子下载连接失败：{error}"))?;
        let response = client
            .execute(NativeHttpRequest {
                source_id: "torrent-import".to_owned(),
                method: HttpMethod::Get,
                url: parsed.to_string(),
                headers: BTreeMap::new(),
                body: None,
                request_interval_ms: 0,
            })
            .await
            .map_err(|error| format!("下载 torrent 文件失败：{error}"))?;
        if !(200..300).contains(&response.status) {
            return Err(format!("下载 torrent 文件失败：HTTP {}", response.status));
        }
        if response.body.first() != Some(&b'd') {
            return Err("远程响应不是有效的 torrent 元信息".to_owned());
        }
        tokio::fs::create_dir_all(&self.torrent_import_directory)
            .await
            .map_err(|error| format!("创建种子临时目录失败：{error}"))?;
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        let sequence = TORRENT_IMPORT_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let path = self
            .torrent_import_directory
            .join(format!("import-{timestamp}-{sequence}.torrent"));
        tokio::fs::write(&path, response.body)
            .await
            .map_err(|error| format!("写入种子临时文件失败：{error}"))?;
        Ok(PreparedDownloadSource {
            source: DownloadSource::TorrentFile(path.clone()),
            temporary_file: Some(path),
        })
    }

    /// 请求全部已注册引擎保存状态并关闭。
    pub(crate) async fn shutdown(&self) {
        for (kind, error) in self.registry.shutdown_all().await {
            log::error!("Tauri 下载引擎关闭失败 engine={kind:?} error={error}");
        }
    }
}

/// 保证远程 torrent 临时文件在添加完成后清理。
pub(crate) struct PreparedDownloadSource {
    source: DownloadSource,
    temporary_file: Option<PathBuf>,
}

impl PreparedDownloadSource {
    /// 返回可交给统一任务服务的来源快照。
    pub(crate) fn source(&self) -> DownloadSource {
        self.source.clone()
    }
}

impl Drop for PreparedDownloadSource {
    fn drop(&mut self) {
        if let Some(path) = self.temporary_file.take() {
            if let Err(error) = std::fs::remove_file(&path) {
                if error.kind() != std::io::ErrorKind::NotFound {
                    log::warn!("清理种子临时文件失败 path={} error={error}", path.display());
                }
            }
        }
    }
}

/// 将资源元数据和明确业务关联转换为统一下载上下文。
pub(crate) fn release_download_context(
    release: &Release,
    anime_id: Option<String>,
    anime_title: Option<String>,
    episode_id: Option<String>,
    episode_no: Option<f64>,
    fansub_group_id: Option<String>,
) -> DownloadTaskContext {
    DownloadTaskContext {
        name: Some(release.title.clone()),
        release_id: Some(release.id.clone()),
        anime_id,
        episode_id,
        anime_title,
        episode_no,
        fansub_group_id,
        fansub_name: release.fansub_name.clone(),
        resolution: release
            .resolution
            .as_ref()
            .map(|value| value.as_str().to_owned()),
        declared_video_codec: release.declared_video_codec.clone(),
        normalized_video_codec: release
            .normalized_video_codec
            .as_ref()
            .map(|value| value.as_str().to_owned()),
        bit_depth: release.bit_depth,
        subtitle_languages: release
            .subtitle_languages
            .iter()
            .map(subtitle_language_value)
            .map(str::to_owned)
            .collect(),
        subtitle: release
            .subtitle
            .as_ref()
            .map(subtitle_preference_value)
            .map(str::to_owned),
    }
}

fn subtitle_language_value(value: &SubtitleLanguage) -> &'static str {
    match value {
        SubtitleLanguage::Chs => "chs",
        SubtitleLanguage::Cht => "cht",
        SubtitleLanguage::Jpn => "jpn",
        SubtitleLanguage::Eng => "eng",
    }
}

fn subtitle_preference_value(value: &SubtitlePreference) -> &'static str {
    match value {
        SubtitlePreference::Chs => "chs",
        SubtitlePreference::Cht => "cht",
        SubtitlePreference::Jpn => "jpn",
        SubtitlePreference::Eng => "eng",
        SubtitlePreference::Multi => "multi",
    }
}

/// 将版本化设置解析为 torrent-core 运行配置。
fn download_engine_config(settings: &AppSettings) -> DownloadEngineConfig {
    let embedded = settings.pointer("/download/embedded");
    let seeding = embedded.and_then(|value| value.get("seedingLimits"));
    DownloadEngineConfig {
        listen_port: setting_u64(embedded, "listenPort", 51_413, 1_024, 65_535) as u16,
        dht_enabled: setting_bool(embedded, "dhtEnabled", true),
        upnp_enabled: setting_bool(embedded, "upnpEnabled", true),
        max_active_downloads: setting_u64(embedded, "maxActiveDownloads", 3, 1, 100) as u32,
        max_download_speed: setting_u64(embedded, "maxDownloadSpeed", 0, 0, u32::MAX as u64) as u32,
        max_upload_speed: setting_u64(embedded, "maxUploadSpeed", 0, 0, u32::MAX as u64) as u32,
        seeding_limits: SeedingLimits {
            enabled: setting_bool(seeding, "enabled", false),
            ratio_enabled: setting_bool(seeding, "ratioEnabled", false),
            ratio_limit: seeding
                .and_then(|value| value.get("ratioLimit"))
                .and_then(Value::as_f64)
                .unwrap_or(1.0)
                .max(0.1),
            time_enabled: setting_bool(seeding, "timeEnabled", false),
            time_limit_minutes: setting_u64(seeding, "timeLimitMinutes", 120, 1, u32::MAX as u64)
                as u32,
        },
    }
}

fn setting_bool(parent: Option<&Value>, key: &str, fallback: bool) -> bool {
    parent
        .and_then(|value| value.get(key))
        .and_then(Value::as_bool)
        .unwrap_or(fallback)
}

fn setting_u64(parent: Option<&Value>, key: &str, fallback: u64, min: u64, max: u64) -> u64 {
    parent
        .and_then(|value| value.get(key))
        .and_then(Value::as_u64)
        .unwrap_or(fallback)
        .clamp(min, max)
}

fn setting_path(settings: &AppSettings, pointer: &str) -> Result<PathBuf, String> {
    settings
        .pointer(pointer)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| format!("平台设置缺少路径：{pointer}"))
}

#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
fn resolve_torrent_core_binary(app: &AppHandle) -> PathBuf {
    if let Some(path) = std::env::var_os("ANI_TORRENT_CORE_PATH") {
        let path = PathBuf::from(path);
        return if path.is_absolute() {
            path
        } else {
            std::env::current_dir()
                .unwrap_or_else(|_| PathBuf::from("."))
                .join(path)
        };
    }
    let platform = if cfg!(target_os = "windows") {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    };
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        value => value,
    };
    let binary_name = if cfg!(target_os = "windows") {
        "torrent-core.exe"
    } else {
        "torrent-core"
    };
    let current = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let mut roots = Vec::new();
    if let Ok(resources) = app.path().resource_dir() {
        roots.push(resources.join("torrent-core"));
    }
    roots.extend([
        current.join("out/torrent-core"),
        current.join("resources/torrent-core"),
        current.join("native/torrent-core/build/release"),
        current.join("native/torrent-core/build/Release"),
        current.join("native/torrent-core/build/portable-release"),
    ]);
    for root in &roots {
        for candidate in [
            root.join(format!("{platform}-{arch}")).join(binary_name),
            root.join(platform).join(binary_name),
            root.join(binary_name),
        ] {
            if candidate.is_file() {
                return candidate;
            }
        }
    }
    roots[0]
        .join(format!("{platform}-{arch}"))
        .join(binary_name)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    /// 验证下载设置被边界化后映射到核心配置。
    #[test]
    fn maps_download_engine_settings() {
        let config = download_engine_config(&json!({
            "download": {
                "embedded": {
                    "listenPort": 1,
                    "maxActiveDownloads": 0,
                    "maxDownloadSpeed": 512,
                    "seedingLimits": {
                        "enabled": true,
                        "ratioLimit": 0,
                        "timeLimitMinutes": 0
                    }
                }
            }
        }));
        assert_eq!(config.listen_port, 1_024);
        assert_eq!(config.max_active_downloads, 1);
        assert_eq!(config.max_download_speed, 512);
        assert!(config.seeding_limits.enabled);
        assert_eq!(config.seeding_limits.ratio_limit, 0.1);
        assert_eq!(config.seeding_limits.time_limit_minutes, 1);
    }
}
