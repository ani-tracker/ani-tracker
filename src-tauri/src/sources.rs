use std::sync::{Arc, Mutex};

use ani_automation::{
    AutomationDownloadReference, AutomationScanStore, EpisodeSyncStore, SourceSyncStore,
};
use ani_domain::{
    AnimeSourceBinding, AnimeSourceExclusion, Episode, FansubGroup, MyAnime, NotificationRecord,
    Release, ReleaseSourceConfig, ReleaseSourceSyncState, RequestCircuitState,
};
use ani_repository::{
    ApplicationRepository, CachedReleaseQuery, ReleaseSearchCacheEntry, RepositoryError,
    RepositoryResult,
};
use ani_sources::{
    AnimeSourceBindingStore, CircuitStateStore, NativeHttpConfig, ProxyMode, ReleaseSearchStore,
    SourceError, SourceNetworkService,
};
use ani_storage::Storage;
use serde_json::Value;
use tokio::sync::Mutex as AsyncMutex;

/// 将共享 SQLite 单写者适配为来源搜索所需的窄存储端口。
#[derive(Clone)]
pub(crate) struct SharedReleaseSearchStore {
    storage: Arc<Mutex<Storage>>,
}

impl SharedReleaseSearchStore {
    /// 创建复用应用 SQLite 单写者的来源存储适配器。
    pub(crate) fn new(storage: Arc<Mutex<Storage>>) -> Self {
        Self { storage }
    }

    /// 在短临界区内执行来源 Repository 操作。
    fn with_repository<T>(
        &self,
        operation: impl FnOnce(&dyn ApplicationRepository) -> RepositoryResult<T>,
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

impl CircuitStateStore for SharedReleaseSearchStore {
    /// 读取来源熔断状态。
    fn get_circuit_state(&self, key: &str) -> RepositoryResult<Option<RequestCircuitState>> {
        self.with_repository(|repository| repository.get_request_circuit_state(key))
    }

    /// 保存来源熔断状态。
    fn save_circuit_state(&self, state: &RequestCircuitState) -> RepositoryResult<()> {
        self.with_repository(|repository| repository.upsert_request_circuit_state(state))
    }
}

impl ReleaseSearchStore for SharedReleaseSearchStore {
    /// 读取未过期的资源搜索缓存。
    fn get_search_cache(
        &self,
        cache_key: &str,
        current_time: &str,
    ) -> RepositoryResult<Option<ReleaseSearchCacheEntry>> {
        self.with_repository(|repository| {
            repository.get_release_search_cache(cache_key, current_time)
        })
    }

    /// 保存资源搜索缓存。
    fn save_search_cache(
        &self,
        cache_key: &str,
        entry: &ReleaseSearchCacheEntry,
    ) -> RepositoryResult<()> {
        self.with_repository(|repository| repository.upsert_release_search_cache(cache_key, entry))
    }

    /// 读取跨重启原始资源缓存。
    fn list_release_cache(&self, query: &CachedReleaseQuery) -> RepositoryResult<Vec<Release>> {
        self.with_repository(|repository| repository.list_cached_releases(query))
    }

    /// 保存网络返回的原始资源缓存。
    fn save_release_cache(&self, releases: &[Release]) -> RepositoryResult<usize> {
        self.with_repository(|repository| repository.upsert_cached_releases(releases))
    }
}

impl AnimeSourceBindingStore for SharedReleaseSearchStore {
    /// 读取全部追番。
    fn list_followed_anime(&self) -> RepositoryResult<Vec<MyAnime>> {
        self.with_repository(|repository| repository.list_my_anime())
    }

    /// 读取全部来源配置。
    fn list_binding_sources(&self) -> RepositoryResult<Vec<ReleaseSourceConfig>> {
        self.with_repository(|repository| repository.list_sources())
    }

    /// 读取指定番剧的单集。
    fn list_binding_episodes(&self, anime_id: &str) -> RepositoryResult<Vec<Episode>> {
        self.with_repository(|repository| repository.list_episodes(anime_id))
    }

    /// 读取指定番剧的来源绑定。
    fn list_bindings(&self, anime_id: &str) -> RepositoryResult<Vec<AnimeSourceBinding>> {
        self.with_repository(|repository| repository.list_anime_source_bindings(anime_id))
    }

    /// 保存一条来源绑定。
    fn save_binding(
        &self,
        binding: &AnimeSourceBinding,
    ) -> RepositoryResult<Vec<AnimeSourceBinding>> {
        self.with_repository(|repository| repository.upsert_anime_source_binding(binding))
    }

    /// 读取指定番剧的来源排除记录。
    fn list_exclusions(&self, anime_id: &str) -> RepositoryResult<Vec<AnimeSourceExclusion>> {
        self.with_repository(|repository| repository.list_anime_source_exclusions(anime_id))
    }

    /// 保存一条来源排除记录。
    fn save_exclusion(
        &self,
        exclusion: &AnimeSourceExclusion,
    ) -> RepositoryResult<Vec<AnimeSourceExclusion>> {
        self.with_repository(|repository| repository.upsert_anime_source_exclusion(exclusion))
    }

    /// 删除一条候选或整来源排除记录。
    fn delete_exclusion(
        &self,
        anime_id: &str,
        source_id: &str,
        source_anime_id: Option<&str>,
    ) -> RepositoryResult<Vec<AnimeSourceExclusion>> {
        self.with_repository(|repository| {
            repository.remove_anime_source_exclusion(anime_id, source_id, source_anime_id)
        })
    }
}

impl SourceSyncStore for SharedReleaseSearchStore {
    /// 读取全部来源同步游标。
    fn list_sync_states(&self) -> RepositoryResult<Vec<ReleaseSourceSyncState>> {
        self.with_repository(|repository| repository.list_source_sync_states())
    }

    /// 保存一个来源同步游标。
    fn save_sync_state(&self, state: &ReleaseSourceSyncState) -> RepositoryResult<()> {
        self.with_repository(|repository| repository.upsert_source_sync_state(state))
    }

    /// 读取全部追番。
    fn list_sync_anime(&self) -> RepositoryResult<Vec<MyAnime>> {
        self.with_repository(|repository| repository.list_my_anime())
    }

    /// 读取指定番剧的来源绑定。
    fn list_sync_bindings(&self, anime_id: &str) -> RepositoryResult<Vec<AnimeSourceBinding>> {
        self.with_repository(|repository| repository.list_anime_source_bindings(anime_id))
    }

    /// 保存同步采集的资源。
    fn save_synced_releases(&self, releases: &[Release]) -> RepositoryResult<usize> {
        self.with_repository(|repository| repository.upsert_cached_releases(releases))
    }

    /// 观察同步资源中的番剧字幕组。
    fn observe_sync_fansubs(
        &self,
        anime_id: &str,
        releases: &[Release],
    ) -> RepositoryResult<Vec<FansubGroup>> {
        self.with_repository(|repository| repository.observe_anime_fansubs(anime_id, releases))
    }

    /// 清理过期资源缓存。
    fn prune_synced_releases(&self, before: &str) -> RepositoryResult<usize> {
        self.with_repository(|repository| repository.prune_cached_releases(before))
    }

    /// 写入同步失败通知。
    fn add_sync_notifications(
        &self,
        records: &[NotificationRecord],
    ) -> RepositoryResult<Vec<NotificationRecord>> {
        self.with_repository(|repository| repository.add_notifications(records))
    }
}

impl EpisodeSyncStore for SharedReleaseSearchStore {
    /// 读取自动同步所需的单集。
    fn list_sync_episodes(&self, anime_id: &str) -> RepositoryResult<Vec<Episode>> {
        self.with_repository(|repository| repository.list_episodes(anime_id))
    }

    /// 幂等保存自动同步单集。
    fn save_sync_episode(&self, episode: &Episode) -> RepositoryResult<Vec<Episode>> {
        self.with_repository(|repository| repository.upsert_episode(episode))
    }

    /// 读取番剧跨重启资源缓存。
    fn list_sync_cached_releases(&self, anime_id: &str) -> RepositoryResult<Vec<Release>> {
        self.with_repository(|repository| {
            repository.list_cached_releases(&CachedReleaseQuery {
                source_ids: None,
                anime_id: Some(anime_id.to_owned()),
                limit: Some(2_000),
            })
        })
    }
}

impl AutomationScanStore for SharedReleaseSearchStore {
    /// 读取全部追番。
    fn list_automation_anime(&self) -> RepositoryResult<Vec<MyAnime>> {
        self.with_repository(|repository| repository.list_my_anime())
    }

    /// 读取指定番剧单集。
    fn list_automation_episodes(&self, anime_id: &str) -> RepositoryResult<Vec<Episode>> {
        self.with_repository(|repository| repository.list_episodes(anime_id))
    }

    /// 读取指定番剧单集偏好。
    fn list_automation_preferences(
        &self,
        anime_id: &str,
    ) -> RepositoryResult<Vec<ani_domain::EpisodePreference>> {
        self.with_repository(|repository| repository.list_episode_preferences(anime_id))
    }

    /// 读取指定番剧来源绑定。
    fn list_automation_bindings(
        &self,
        anime_id: &str,
    ) -> RepositoryResult<Vec<AnimeSourceBinding>> {
        self.with_repository(|repository| repository.list_anime_source_bindings(anime_id))
    }

    /// 读取下载任务判重快照。
    fn list_automation_downloads(&self) -> RepositoryResult<Vec<AutomationDownloadReference>> {
        self.with_repository(|repository| {
            repository.list_downloads().map(|tasks| {
                tasks
                    .into_iter()
                    .map(|task| AutomationDownloadReference {
                        task_id: task.id,
                        anime_id: task.anime_id,
                        episode_id: task.episode_id,
                    })
                    .collect()
            })
        })
    }

    /// 保存自动扫描推进后的单集状态。
    fn save_automation_episode(&self, episode: &Episode) -> RepositoryResult<()> {
        self.with_repository(|repository| repository.upsert_episode(episode).map(|_| ()))
    }

    /// 保存自动扫描发现的字幕组。
    fn observe_automation_fansubs(
        &self,
        anime_id: &str,
        releases: &[Release],
    ) -> RepositoryResult<Vec<FansubGroup>> {
        self.with_repository(|repository| repository.observe_anime_fansubs(anime_id, releases))
    }

    /// 写入自动扫描结果通知。
    fn add_automation_notifications(
        &self,
        records: &[NotificationRecord],
    ) -> RepositoryResult<Vec<NotificationRecord>> {
        self.with_repository(|repository| repository.add_notifications(records))
    }
}

struct NetworkRuntime {
    config: NativeHttpConfig,
    service: Arc<SourceNetworkService>,
}

/// 根据当前代理设置复用或重建 Rust 来源网络服务。
#[derive(Clone)]
pub(crate) struct AppSourceState {
    runtime: Arc<AsyncMutex<Option<NetworkRuntime>>>,
}

impl AppSourceState {
    /// 创建尚未初始化连接池的来源状态。
    pub(crate) fn new() -> Self {
        Self {
            runtime: Arc::new(AsyncMutex::new(None)),
        }
    }

    /// 返回匹配当前设置的连接池，代理设置变化时原子替换。
    pub(crate) async fn network_service(
        &self,
        settings: &Value,
    ) -> Result<Arc<SourceNetworkService>, SourceError> {
        let config = native_http_config(settings);
        let mut runtime = self.runtime.lock().await;
        if let Some(current) = runtime.as_ref().filter(|current| current.config == config) {
            return Ok(Arc::clone(&current.service));
        }
        let service = Arc::new(SourceNetworkService::new(config.clone())?);
        log::info!(
            "Tauri 来源网络连接池已装配 proxy_mode={:?} timeout_ms={} response_limit={}",
            config.proxy_mode,
            config.timeout_ms,
            config.max_response_bytes
        );
        *runtime = Some(NetworkRuntime {
            config,
            service: Arc::clone(&service),
        });
        Ok(service)
    }
}

/// 从版本化设置中读取代理模式、地址和超时。
fn native_http_config(settings: &Value) -> NativeHttpConfig {
    let proxy = settings.pointer("/network/metadataProxy");
    let mode = match proxy
        .and_then(|value| value.get("mode"))
        .and_then(Value::as_str)
    {
        Some("off") => ProxyMode::Off,
        Some("manual") => ProxyMode::Manual,
        _ => ProxyMode::System,
    };
    NativeHttpConfig {
        proxy_mode: mode,
        proxy_url: proxy
            .and_then(|value| value.get("url"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned),
        timeout_ms: proxy
            .and_then(|value| value.get("timeoutMs"))
            .and_then(Value::as_u64)
            .unwrap_or(15_000),
        max_response_bytes: 16 * 1024 * 1024,
        user_agent: "AniTracker/0.1".to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use ani_sources::ProxyMode;
    use serde_json::json;

    use super::native_http_config;

    /// 验证设置中的代理模式、地址和超时映射到 Native HTTP 配置。
    #[test]
    fn maps_proxy_settings_to_native_http_config() {
        let config = native_http_config(&json!({
            "network": {
                "metadataProxy": {
                    "mode": "manual",
                    "url": "http://127.0.0.1:7890",
                    "timeoutMs": 23_000
                }
            }
        }));
        assert_eq!(config.proxy_mode, ProxyMode::Manual);
        assert_eq!(config.proxy_url.as_deref(), Some("http://127.0.0.1:7890"));
        assert_eq!(config.timeout_ms, 23_000);
    }
}
