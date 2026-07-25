use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use ani_contracts::{
    DownloadServiceMode, DownloadServiceState, DownloadServiceStatus, EmbeddedTorrentCoreStatus,
    QbittorrentManagedStatus,
};
use ani_domain::{
    AppSettings, DownloadTask, Release, SubtitleLanguage, SubtitlePreference, TorrentEngineKind,
};
use ani_downloads::{
    DownloadEngine, DownloadEngineConfig, DownloadEngineRegistry, DownloadServiceError,
    DownloadSource, DownloadTaskContext, DownloadTaskService, DownloadTaskStore,
    QbittorrentConnectionConfig, QbittorrentEngine, SeedingLimits, TorrentCoreEngine,
};
#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
use ani_downloads::{ProcessTorrentCoreTransport, TorrentCoreProcessOptions};
use ani_repository::{DownloadRepository, RepositoryError, RepositoryResult, SettingsRepository};
use ani_sources::{HttpMethod, NativeHttpClient, NativeHttpRequest};
use ani_storage::Storage;
use chrono::{SecondsFormat, Utc};
use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::qbittorrent_managed::{managed_credentials, AppManagedQbittorrentState};
use crate::sources::native_http_config;

static TORRENT_IMPORT_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Default)]
struct EmbeddedLifecycle {
    last_started_at: Option<String>,
    last_stopped_at: Option<String>,
    last_error: Option<String>,
}

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
    qbittorrent: Arc<QbittorrentEngine>,
    managed_qbittorrent: AppManagedQbittorrentState,
    embedded_lifecycle: Arc<Mutex<EmbeddedLifecycle>>,
    #[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
    embedded_transport: Arc<ProcessTorrentCoreTransport>,
    #[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
    embedded_binary_path: PathBuf,
    #[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
    embedded_data_directory: PathBuf,
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
        let (embedded_transport, embedded_binary_path, embedded_data_directory) = {
            let binary_path = resolve_torrent_core_binary(app);
            let data_directory =
                setting_path(&platform_defaults, "/storage/userDataDir")?.join("torrent-core");
            let transport = Arc::new(ProcessTorrentCoreTransport::new(
                TorrentCoreProcessOptions::new(binary_path.clone(), data_directory.clone()),
            ));
            registry
                .register(Arc::new(TorrentCoreEngine::new(transport.clone())))
                .map_err(|error| error.to_string())?;
            log::info!(
                "Tauri torrent-core transport 已装配 binary={}",
                binary_path.display()
            );
            (transport, binary_path, data_directory)
        };
        let qbittorrent = Arc::new(
            QbittorrentEngine::new(qbittorrent_connection_config(
                &platform_defaults,
                None,
                false,
            ))
            .map_err(|error| error.to_string())?,
        );
        registry
            .register(qbittorrent.clone())
            .map_err(|error| error.to_string())?;
        let registry = Arc::new(registry);
        let store = Arc::new(SharedDownloadTaskStore::new(Arc::clone(&storage)));
        let service = Arc::new(DownloadTaskService::new(Arc::clone(&registry), store));
        let torrent_import_directory =
            setting_path(&platform_defaults, "/storage/cacheDir")?.join("torrent-imports");
        Ok(Self {
            service,
            registry,
            qbittorrent,
            managed_qbittorrent: AppManagedQbittorrentState::new(app),
            embedded_lifecycle: Arc::new(Mutex::new(EmbeddedLifecycle::default())),
            #[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
            embedded_transport,
            #[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
            embedded_binary_path,
            #[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
            embedded_data_directory,
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
            Some("embedded") | None
                if settings
                    .pointer("/download/embedded/enabled")
                    .and_then(Value::as_bool)
                    .unwrap_or(true) =>
            {
                Ok(TorrentEngineKind::Embedded)
            }
            Some("embedded") | None => Err(DownloadServiceError::InvalidInput {
                field: "defaultTorrentEngine",
                message: "内置下载引擎已停用".to_owned(),
            }),
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

    /// 设置变化后切换默认引擎并同步托管进程和传输参数。
    pub(crate) async fn refresh_from_settings(&self, settings: &AppSettings) -> Result<(), String> {
        let embedded_enabled = settings
            .pointer("/download/embedded/enabled")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        let default_engine = self
            .default_engine(settings)
            .map_err(|error| error.to_string())?;
        if default_engine == TorrentEngineKind::Embedded && embedded_enabled {
            self.start_embedded(settings).await?;
        } else {
            self.stop_embedded().await?;
        }
        if default_engine == TorrentEngineKind::Qbittorrent {
            if AppManagedQbittorrentState::should_auto_start(settings) {
                self.start_managed_qbittorrent(settings).await?;
            } else {
                self.managed_qbittorrent
                    .stop(settings, Some(&self.qbittorrent))
                    .await;
                self.configure_qbittorrent(settings, false).await?;
            }
        } else {
            self.managed_qbittorrent
                .stop(settings, Some(&self.qbittorrent))
                .await;
            self.qbittorrent
                .shutdown()
                .await
                .map_err(|error| error.to_string())?;
        }
        Ok(())
    }

    /// 测试当前外部或托管 qBittorrent 连接并返回任务数量。
    pub(crate) async fn test_qbittorrent(&self) -> Result<usize, String> {
        let settings = self.settings()?;
        let managed = AppManagedQbittorrentState::is_managed_enabled(&settings)
            && self.managed_qbittorrent.status(&settings).await.running;
        self.configure_qbittorrent(&settings, managed).await?;
        self.qbittorrent
            .status()
            .await
            .map(|status| status.task_count)
            .map_err(|error| error.to_string())
    }

    /// 返回应用壳使用的当前默认下载服务健康状态。
    pub(crate) async fn download_service_status(&self) -> DownloadServiceStatus {
        let settings = match self.settings() {
            Ok(settings) => settings,
            Err(error) => return download_service_error(DownloadServiceMode::Embedded, error),
        };
        match self.default_engine(&settings) {
            Ok(TorrentEngineKind::Embedded) => match self.embedded_status(&settings).await {
                Ok(status) if status.last_error.is_some() => download_service_error(
                    DownloadServiceMode::Embedded,
                    status.last_error.unwrap_or_default(),
                ),
                Ok(status) if status.running => DownloadServiceStatus {
                    mode: DownloadServiceMode::Embedded,
                    state: DownloadServiceState::Online,
                    message: "内置下载引擎运行中".to_owned(),
                    task_count: status.task_count,
                },
                Ok(_) => DownloadServiceStatus {
                    mode: DownloadServiceMode::Embedded,
                    state: DownloadServiceState::Idle,
                    message: "内置下载引擎未启动".to_owned(),
                    task_count: None,
                },
                Err(error) => download_service_error(DownloadServiceMode::Embedded, error),
            },
            Ok(TorrentEngineKind::Qbittorrent) => {
                let managed = self.managed_qbittorrent.status(&settings).await;
                if managed.enabled {
                    if let Some(error) = managed.last_error {
                        return download_service_error(DownloadServiceMode::Managed, error);
                    }
                    return DownloadServiceStatus {
                        mode: DownloadServiceMode::Managed,
                        state: if managed.running {
                            DownloadServiceState::Online
                        } else {
                            DownloadServiceState::Idle
                        },
                        message: if managed.running {
                            "qBittorrent-nox 运行中".to_owned()
                        } else {
                            "qBittorrent-nox 未运行".to_owned()
                        },
                        task_count: None,
                    };
                }
                match self.qbittorrent.status().await {
                    Ok(status) => DownloadServiceStatus {
                        mode: DownloadServiceMode::External,
                        state: DownloadServiceState::Online,
                        message: "外部 qBittorrent 已连接".to_owned(),
                        task_count: Some(status.task_count),
                    },
                    Err(error) => {
                        download_service_error(DownloadServiceMode::External, error.to_string())
                    }
                }
            }
            Err(error) => download_service_error(DownloadServiceMode::Embedded, error.to_string()),
        }
    }

    /// 读取托管 qBittorrent 进程状态。
    pub(crate) async fn managed_qbittorrent_status(
        &self,
    ) -> Result<QbittorrentManagedStatus, String> {
        let settings = self.settings()?;
        Ok(self.managed_qbittorrent.status(&settings).await)
    }

    /// 手动启动托管进程、同步首次凭据并应用下载设置。
    pub(crate) async fn start_managed_qbittorrent(
        &self,
        settings: &AppSettings,
    ) -> Result<QbittorrentManagedStatus, String> {
        let status = self.managed_qbittorrent.start(settings).await?;
        if let Err(error) = self.configure_qbittorrent(settings, status.running).await {
            self.managed_qbittorrent.stop(settings, None).await;
            return Err(error);
        }
        Ok(self.managed_qbittorrent.status(settings).await)
    }

    /// 手动停止托管进程并清除 WebUI 会话。
    pub(crate) async fn stop_managed_qbittorrent(
        &self,
    ) -> Result<QbittorrentManagedStatus, String> {
        let settings = self.settings()?;
        let status = self
            .managed_qbittorrent
            .stop(&settings, Some(&self.qbittorrent))
            .await;
        self.qbittorrent
            .shutdown()
            .await
            .map_err(|error| error.to_string())?;
        Ok(status)
    }

    /// 启动或重配桌面 torrent-core，并记录生命周期结果。
    pub(crate) async fn start_embedded(&self, settings: &AppSettings) -> Result<(), String> {
        let result = async {
            let engine = self
                .registry
                .require(&TorrentEngineKind::Embedded)
                .map_err(|error| error.to_string())?;
            engine
                .configure(&embedded_engine_config(settings))
                .await
                .map_err(|error| error.to_string())?;
            Ok::<_, String>(())
        }
        .await;
        if let Ok(mut lifecycle) = self.embedded_lifecycle.lock() {
            match &result {
                Ok(()) => {
                    lifecycle.last_started_at = Some(now_iso());
                    lifecycle.last_error = None;
                }
                Err(error) => lifecycle.last_error = Some(error.clone()),
            }
        }
        result
    }

    /// 请求 torrent-core 保存恢复数据并停止。
    pub(crate) async fn stop_embedded(&self) -> Result<(), String> {
        if let Ok(engine) = self.registry.require(&TorrentEngineKind::Embedded) {
            engine.shutdown().await.map_err(|error| error.to_string())?;
            if let Ok(mut lifecycle) = self.embedded_lifecycle.lock() {
                lifecycle.last_stopped_at = Some(now_iso());
            }
        }
        Ok(())
    }

    /// 读取内置核心进程与协议状态，未运行时不会隐式启动。
    pub(crate) async fn embedded_status(
        &self,
        settings: &AppSettings,
    ) -> Result<EmbeddedTorrentCoreStatus, String> {
        #[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
        {
            let pid = self
                .embedded_transport
                .process_id()
                .await
                .map_err(|error| error.to_string())?;
            let protocol = if pid.is_some() {
                Some(
                    self.registry
                        .require(&TorrentEngineKind::Embedded)
                        .map_err(|error| error.to_string())?
                        .status()
                        .await
                        .map_err(|error| error.to_string())?,
                )
            } else {
                None
            };
            let lifecycle = self
                .embedded_lifecycle
                .lock()
                .map_err(|error| error.to_string())?;
            Ok(EmbeddedTorrentCoreStatus {
                enabled: settings
                    .pointer("/download/embedded/enabled")
                    .and_then(Value::as_bool)
                    .unwrap_or(true),
                running: pid.is_some(),
                platform: std::env::consts::OS.to_owned(),
                arch: std::env::consts::ARCH.to_owned(),
                binary_path: Some(self.embedded_binary_path.to_string_lossy().into_owned()),
                data_dir: Some(self.embedded_data_directory.to_string_lossy().into_owned()),
                pid,
                version: protocol.as_ref().map(|value| value.version.clone()),
                task_count: protocol.as_ref().map(|value| value.task_count),
                listen_port: protocol.and_then(|value| value.listen_port),
                last_started_at: lifecycle.last_started_at.clone(),
                last_stopped_at: lifecycle.last_stopped_at.clone(),
                last_error: lifecycle.last_error.clone(),
            })
        }
        #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
        {
            let _ = settings;
            Err("移动 torrent-core transport 尚未装配".to_owned())
        }
    }

    /// 为外部或托管 WebUI 更新连接、首次凭据和传输限制。
    async fn configure_qbittorrent(
        &self,
        settings: &AppSettings,
        managed_running: bool,
    ) -> Result<(), String> {
        let base_url = self.managed_qbittorrent.runtime_base_url(settings).await;
        let desired =
            qbittorrent_connection_config(settings, Some(base_url.clone()), managed_running);
        self.qbittorrent
            .update_connection(desired.clone())
            .await
            .map_err(|error| error.to_string())?;
        let config = qbittorrent_engine_config(settings);
        match self.qbittorrent.configure(&config).await {
            Ok(_) => Ok(()),
            Err(initial_error) if managed_running => {
                let temporary_password = self
                    .managed_qbittorrent
                    .temporary_password()
                    .await
                    .ok_or_else(|| initial_error.to_string())?;
                let bootstrap = QbittorrentEngine::new(QbittorrentConnectionConfig::new(
                    base_url,
                    "admin".to_owned(),
                    Some(temporary_password),
                ))
                .map_err(|error| error.to_string())?;
                let (username, password) = managed_credentials(settings);
                bootstrap
                    .update_webui_credentials(&username, &password)
                    .await
                    .map_err(|error| format!("同步托管 qBittorrent 凭据失败：{error}"))?;
                self.qbittorrent
                    .update_connection(desired)
                    .await
                    .map_err(|error| error.to_string())?;
                self.qbittorrent
                    .configure(&config)
                    .await
                    .map(|_| ())
                    .map_err(|error| error.to_string())
            }
            Err(error) => Err(error.to_string()),
        }
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
        if let Ok(settings) = self.settings() {
            self.managed_qbittorrent
                .stop(&settings, Some(&self.qbittorrent))
                .await;
        }
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
fn embedded_engine_config(settings: &AppSettings) -> DownloadEngineConfig {
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

/// 将 qBittorrent 设置解析为 WebUI 连接参数。
fn qbittorrent_connection_config(
    settings: &AppSettings,
    base_url: Option<String>,
    managed: bool,
) -> QbittorrentConnectionConfig {
    let (username, password) = if managed {
        let (username, password) = managed_credentials(settings);
        (username, Some(password))
    } else {
        (
            settings
                .pointer("/download/qbittorrent/username")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            settings
                .pointer("/download/qbittorrent/password")
                .and_then(Value::as_str)
                .map(str::to_owned),
        )
    };
    QbittorrentConnectionConfig::new(
        base_url.unwrap_or_else(|| {
            settings
                .pointer("/download/qbittorrent/baseUrl")
                .and_then(Value::as_str)
                .unwrap_or("http://127.0.0.1:18080")
                .to_owned()
        }),
        username,
        password,
    )
}

fn download_service_error(
    mode: DownloadServiceMode,
    message: impl Into<String>,
) -> DownloadServiceStatus {
    DownloadServiceStatus {
        mode,
        state: DownloadServiceState::Error,
        message: message.into(),
        task_count: None,
    }
}

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// 将 qBittorrent KiB/s 和做种设置映射到统一引擎配置。
fn qbittorrent_engine_config(settings: &AppSettings) -> DownloadEngineConfig {
    let qbittorrent = settings.pointer("/download/qbittorrent");
    let seeding = qbittorrent.and_then(|value| value.get("seedingLimits"));
    DownloadEngineConfig {
        listen_port: 0,
        dht_enabled: false,
        upnp_enabled: false,
        max_active_downloads: 1,
        max_download_speed: setting_u64(qbittorrent, "downloadLimitKiBps", 0, 0, u32::MAX as u64)
            as u32,
        max_upload_speed: setting_u64(qbittorrent, "uploadLimitKiBps", 0, 0, u32::MAX as u64)
            as u32,
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
        let config = embedded_engine_config(&json!({
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

    /// 验证 qBittorrent 限速和做种设置使用独立配置分支。
    #[test]
    fn maps_qbittorrent_engine_settings() {
        let config = qbittorrent_engine_config(&json!({
            "download": {
                "qbittorrent": {
                    "downloadLimitKiBps": 512,
                    "uploadLimitKiBps": 128,
                    "seedingLimits": {
                        "enabled": true,
                        "ratioEnabled": true,
                        "ratioLimit": 1.5,
                        "timeEnabled": true,
                        "timeLimitMinutes": 90
                    }
                }
            }
        }));
        assert_eq!(config.max_download_speed, 512);
        assert_eq!(config.max_upload_speed, 128);
        assert_eq!(config.seeding_limits.ratio_limit, 1.5);
        assert_eq!(config.seeding_limits.time_limit_minutes, 90);
    }
}
