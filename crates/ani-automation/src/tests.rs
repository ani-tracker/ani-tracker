use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use ani_domain::{
    AnimeSourceBinding, AutomationRunResult, AutomationSchedulerStatus, FansubGroup, MyAnime,
    NotificationRecord, Release, ReleaseSourceConfig, ReleaseSourceSyncState, RequestCircuitState,
    SourceKind, SourceSyncRunResult, SourceSyncSchedulerStatus,
};
use ani_repository::{CachedReleaseQuery, ReleaseSearchCacheEntry, RepositoryResult};
use ani_sources::{
    CircuitStateStore, NativeHttpConfig, ProxyMode, ReleaseSearchStore, SourceNetworkService,
};
use chrono::{TimeZone, Utc};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use super::{SourceSyncRunOptions, SourceSyncService, SourceSyncStore};

/// 验证 Rust 严格解码来源同步跨语言金样。
#[test]
fn decodes_source_sync_contract_fixture() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../fixtures/contracts/p3-source-sync-model.v1.json"
    )))
    .expect("decode source sync fixture");
    assert_eq!(fixture["schemaVersion"], 1);
    let payload = &fixture["payload"];
    let state: ReleaseSourceSyncState =
        serde_json::from_value(payload["syncState"].clone()).expect("decode sync state");
    let result: SourceSyncRunResult =
        serde_json::from_value(payload["runResult"].clone()).expect("decode run result");
    let status: SourceSyncSchedulerStatus =
        serde_json::from_value(payload["schedulerStatus"].clone())
            .expect("decode scheduler status");
    assert_eq!(state.source_id, "rss-contract");
    assert_eq!(result.added_release_count, 2);
    assert_eq!(status.last_result, Some(result));
}

/// 验证 Rust 与 TypeScript 共用自动扫描结果和调度状态金样。
#[test]
fn decodes_automation_contract_fixture() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../fixtures/contracts/p3-automation-model.v1.json"
    )))
    .expect("decode automation fixture");
    let result: AutomationRunResult =
        serde_json::from_value(fixture["payload"]["runResult"].clone())
            .expect("decode automation result");
    let status: AutomationSchedulerStatus =
        serde_json::from_value(fixture["payload"]["schedulerStatus"].clone())
            .expect("decode automation status");
    assert_eq!(result.checked_episodes, 2);
    assert_eq!(
        result.downloaded[0].download_task_id,
        "download-automation-1"
    );
    assert_eq!(status.last_result.as_ref(), Some(&result));
}

#[derive(Default)]
struct MemorySyncStore {
    circuits: Mutex<HashMap<String, RequestCircuitState>>,
    states: Mutex<HashMap<String, ReleaseSourceSyncState>>,
    releases: Mutex<HashMap<String, Release>>,
    notifications: Mutex<Vec<NotificationRecord>>,
}

impl CircuitStateStore for MemorySyncStore {
    /// 读取测试熔断状态。
    fn get_circuit_state(&self, key: &str) -> RepositoryResult<Option<RequestCircuitState>> {
        Ok(self
            .circuits
            .lock()
            .expect("lock circuits")
            .get(key)
            .cloned())
    }

    /// 保存测试熔断状态。
    fn save_circuit_state(&self, state: &RequestCircuitState) -> RepositoryResult<()> {
        self.circuits
            .lock()
            .expect("lock circuits")
            .insert(state.key.clone(), state.clone());
        Ok(())
    }
}

impl ReleaseSearchStore for MemorySyncStore {
    /// 同步测试不使用聚合搜索缓存。
    fn get_search_cache(
        &self,
        _cache_key: &str,
        _current_time: &str,
    ) -> RepositoryResult<Option<ReleaseSearchCacheEntry>> {
        Ok(None)
    }

    /// 同步测试不保存聚合搜索缓存。
    fn save_search_cache(
        &self,
        _cache_key: &str,
        _entry: &ReleaseSearchCacheEntry,
    ) -> RepositoryResult<()> {
        Ok(())
    }

    /// 读取测试原始资源缓存。
    fn list_release_cache(&self, query: &CachedReleaseQuery) -> RepositoryResult<Vec<Release>> {
        let releases = self
            .releases
            .lock()
            .expect("lock releases")
            .values()
            .filter(|release| {
                query.source_ids.as_ref().is_none_or(|source_ids| {
                    source_ids
                        .iter()
                        .any(|source_id| source_id == &release.source_id)
                })
            })
            .cloned()
            .collect();
        Ok(releases)
    }

    /// 保存测试原始资源缓存。
    fn save_release_cache(&self, releases: &[Release]) -> RepositoryResult<usize> {
        save_releases(&self.releases, releases)
    }
}

impl SourceSyncStore for MemorySyncStore {
    /// 读取测试同步游标。
    fn list_sync_states(&self) -> RepositoryResult<Vec<ReleaseSourceSyncState>> {
        Ok(self
            .states
            .lock()
            .expect("lock states")
            .values()
            .cloned()
            .collect())
    }

    /// 保存测试同步游标。
    fn save_sync_state(&self, state: &ReleaseSourceSyncState) -> RepositoryResult<()> {
        self.states
            .lock()
            .expect("lock states")
            .insert(state.source_id.clone(), state.clone());
        Ok(())
    }

    /// 条件请求测试不需要追番。
    fn list_sync_anime(&self) -> RepositoryResult<Vec<MyAnime>> {
        Ok(Vec::new())
    }

    /// 条件请求测试不需要来源绑定。
    fn list_sync_bindings(&self, _anime_id: &str) -> RepositoryResult<Vec<AnimeSourceBinding>> {
        Ok(Vec::new())
    }

    /// 保存同步采集的测试资源。
    fn save_synced_releases(&self, releases: &[Release]) -> RepositoryResult<usize> {
        save_releases(&self.releases, releases)
    }

    /// 条件请求测试不观察字幕组。
    fn observe_sync_fansubs(
        &self,
        _anime_id: &str,
        _releases: &[Release],
    ) -> RepositoryResult<Vec<FansubGroup>> {
        Ok(Vec::new())
    }

    /// 删除测试中过期的缓存资源。
    fn prune_synced_releases(&self, before: &str) -> RepositoryResult<usize> {
        let mut releases = self.releases.lock().expect("lock releases");
        let before_count = releases.len();
        releases.retain(|_, release| release.published_at.as_str() >= before);
        Ok(before_count - releases.len())
    }

    /// 保存测试同步通知。
    fn add_sync_notifications(
        &self,
        records: &[NotificationRecord],
    ) -> RepositoryResult<Vec<NotificationRecord>> {
        let mut notifications = self.notifications.lock().expect("lock notifications");
        notifications.extend_from_slice(records);
        Ok(notifications.clone())
    }
}

/// 验证 RSS 同步保存条件请求游标，并把 304 视为成功。
#[tokio::test]
async fn persists_conditional_request_cursor_and_accepts_not_modified() {
    let (rss_url, requests) = serve_conditional_rss().await;
    let source = ReleaseSourceConfig {
        id: "conditional-rss".to_owned(),
        name: "条件 RSS".to_owned(),
        kind: SourceKind::Rss,
        enabled: true,
        use_proxy: false,
        request_interval_ms: 250,
        base_url: None,
        api_key: None,
        rss_url: Some(rss_url),
        tags: Vec::new(),
    };
    let store = MemorySyncStore::default();
    let service = SourceSyncService::new(Arc::new(
        SourceNetworkService::new(NativeHttpConfig {
            proxy_mode: ProxyMode::Off,
            proxy_url: None,
            timeout_ms: 5_000,
            max_response_bytes: 1024 * 1024,
            user_agent: "AniTrackerTest/1".to_owned(),
        })
        .expect("create source network"),
    ));
    let now = Utc
        .with_ymd_and_hms(2026, 7, 25, 1, 0, 0)
        .single()
        .expect("fixed time");

    let first = service
        .run(
            &store,
            std::slice::from_ref(&source),
            SourceSyncRunOptions {
                force: true,
                now: Some(now),
            },
        )
        .await
        .expect("first sync");
    assert_eq!(first.added_release_count, 1);
    assert!(first.errors.is_empty());
    let state = store
        .states
        .lock()
        .expect("lock states")
        .get(&source.id)
        .cloned()
        .expect("saved source state");
    assert_eq!(state.etag.as_deref(), Some(r#""release-v1""#));
    assert_eq!(
        state.last_modified.as_deref(),
        Some("Fri, 25 Jul 2026 00:00:00 GMT")
    );

    let second = service
        .run(
            &store,
            &[source],
            SourceSyncRunOptions {
                force: true,
                now: Some(now + chrono::Duration::minutes(5)),
            },
        )
        .await
        .expect("second sync");
    assert_eq!(second.added_release_count, 0);
    assert_eq!(second.synced_source_ids, vec!["conditional-rss"]);
    assert!(second.errors.is_empty());
    assert_eq!(requests.lock().expect("lock requests").len(), 2);
    assert!(requests.lock().expect("lock requests")[1]
        .to_ascii_lowercase()
        .contains(r#"if-none-match: "release-v1""#));
}

/// 验证单来源失败不清空成功结果，并写入包含熔断信息的提醒。
#[tokio::test]
async fn isolates_source_failures_and_writes_notification() {
    let base_url = serve_mixed_rss().await;
    let sources = vec![
        rss_source("working-rss", "可用来源", format!("{base_url}/ok.xml")),
        rss_source("failed-rss", "失败来源", format!("{base_url}/fail.xml")),
    ];
    let store = MemorySyncStore::default();
    let service = SourceSyncService::new(Arc::new(
        SourceNetworkService::new(NativeHttpConfig {
            proxy_mode: ProxyMode::Off,
            proxy_url: None,
            timeout_ms: 5_000,
            max_response_bytes: 1024 * 1024,
            user_agent: "AniTrackerTest/1".to_owned(),
        })
        .expect("create source network"),
    ));
    let result = service
        .run(
            &store,
            &sources,
            SourceSyncRunOptions {
                force: true,
                now: Some(
                    Utc.with_ymd_and_hms(2026, 7, 25, 1, 0, 0)
                        .single()
                        .expect("fixed time"),
                ),
            },
        )
        .await
        .expect("mixed source sync");

    assert_eq!(result.synced_source_ids, vec!["working-rss"]);
    assert_eq!(result.errors.len(), 1);
    assert_eq!(result.errors[0].source_id, "failed-rss");
    assert_eq!(store.releases.lock().expect("lock releases").len(), 1);
    let notifications = store.notifications.lock().expect("lock notifications");
    assert_eq!(notifications.len(), 1);
    assert!(notifications[0].title.contains("失败来源"));
    assert!(notifications[0].body.contains("连续失败 1 次"));
    assert!(notifications[0].body.contains("自动重试"));
}

/// 保存资源并返回首次出现数量。
fn save_releases(
    target: &Mutex<HashMap<String, Release>>,
    releases: &[Release],
) -> RepositoryResult<usize> {
    let mut target = target.lock().expect("lock releases");
    let mut added = 0;
    for release in releases {
        added += usize::from(!target.contains_key(&release.id));
        target.insert(release.id.clone(), release.clone());
    }
    Ok(added)
}

/// 创建指向本地测试服务的 RSS 来源。
fn rss_source(id: &str, name: &str, rss_url: String) -> ReleaseSourceConfig {
    ReleaseSourceConfig {
        id: id.to_owned(),
        name: name.to_owned(),
        kind: SourceKind::Rss,
        enabled: true,
        use_proxy: false,
        request_interval_ms: 250,
        base_url: None,
        api_key: None,
        rss_url: Some(rss_url),
        tags: Vec::new(),
    }
}

/// 启动两次响应的本地 RSS 服务，第二次返回 304。
async fn serve_conditional_rss() -> (String, Arc<Mutex<Vec<String>>>) {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind rss server");
    let address = listener.local_addr().expect("rss server address");
    let requests = Arc::new(Mutex::new(Vec::new()));
    let captured = Arc::clone(&requests);
    tokio::spawn(async move {
        for index in 0..2 {
            let (mut stream, _) = listener.accept().await.expect("accept rss request");
            let mut buffer = vec![0_u8; 8192];
            let count = stream.read(&mut buffer).await.expect("read rss request");
            captured
                .lock()
                .expect("lock requests")
                .push(String::from_utf8_lossy(&buffer[..count]).into_owned());
            let body = r#"<rss><channel><item><title>[测试组] 条件同步番 - 01 [1080p][CHS]</title><guid>conditional-release-1</guid><pubDate>Fri, 25 Jul 2026 00:30:00 GMT</pubDate><link>magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567</link></item></channel></rss>"#;
            let response = if index == 0 {
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/rss+xml\r\nETag: \"release-v1\"\r\nLast-Modified: Fri, 25 Jul 2026 00:00:00 GMT\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                )
            } else {
                "HTTP/1.1 304 Not Modified\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                    .to_owned()
            };
            stream
                .write_all(response.as_bytes())
                .await
                .expect("write rss response");
        }
    });
    (format!("http://{address}/feed.xml"), requests)
}

/// 启动同时提供成功和失败 RSS 的本地服务。
async fn serve_mixed_rss() -> String {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind mixed rss server");
    let address = listener.local_addr().expect("mixed rss server address");
    tokio::spawn(async move {
        for _ in 0..2 {
            let (mut stream, _) = listener.accept().await.expect("accept mixed request");
            let mut buffer = vec![0_u8; 8192];
            let count = stream.read(&mut buffer).await.expect("read mixed request");
            let request = String::from_utf8_lossy(&buffer[..count]);
            let body = r#"<rss><channel><item><title>[测试组] 成功同步番 - 01 [1080p]</title><guid>mixed-release-1</guid><pubDate>Fri, 25 Jul 2026 00:30:00 GMT</pubDate><link>magnet:?xt=urn:btih:1123456789abcdef0123456789abcdef01234567</link></item></channel></rss>"#;
            let response = if request.contains("GET /ok.xml") {
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/rss+xml\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                )
            } else {
                "HTTP/1.1 503 Service Unavailable\r\nContent-Length: 4\r\nConnection: close\r\n\r\nbusy"
                    .to_owned()
            };
            stream
                .write_all(response.as_bytes())
                .await
                .expect("write mixed response");
        }
    });
    format!("http://{address}")
}
