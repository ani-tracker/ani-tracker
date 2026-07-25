use std::sync::{Arc, Mutex};

use ani_domain::RequestCircuitState;
use ani_repository::{
    ReleaseSearchCacheEntry, ReleaseSourceRepository, RepositoryError, RepositoryResult,
};
use ani_sources::{
    CircuitStateStore, NativeHttpConfig, ProxyMode, ReleaseSearchStore, SourceError,
    SourceNetworkService,
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
        operation: impl FnOnce(&dyn ReleaseSourceRepository) -> RepositoryResult<T>,
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
}

struct NetworkRuntime {
    config: NativeHttpConfig,
    service: Arc<SourceNetworkService>,
}

/// 根据当前代理设置复用或重建 Rust 来源网络服务。
pub(crate) struct AppSourceState {
    runtime: AsyncMutex<Option<NetworkRuntime>>,
}

impl AppSourceState {
    /// 创建尚未初始化连接池的来源状态。
    pub(crate) fn new() -> Self {
        Self {
            runtime: AsyncMutex::new(None),
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
