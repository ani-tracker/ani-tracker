use std::path::Path;
use std::sync::{Arc, Mutex};

use ani_domain::{DownloadStatus, DownloadTask, TorrentEngineKind, TorrentFile};
use ani_repository::RepositoryResult;
use async_trait::async_trait;

use crate::{
    AddTorrentOptions, DownloadAddRequest, DownloadEngine, DownloadEngineConfig,
    DownloadEngineError, DownloadEngineRegistry, DownloadEngineStatus, DownloadSource,
    DownloadTaskContext, DownloadTaskService, DownloadTaskStore,
};

#[derive(Default)]
struct MemoryStore {
    tasks: Mutex<Vec<DownloadTask>>,
}

impl MemoryStore {
    /// 创建包含给定任务的内存存储替身。
    fn with_tasks(tasks: Vec<DownloadTask>) -> Self {
        Self {
            tasks: Mutex::new(tasks),
        }
    }
}

impl DownloadTaskStore for MemoryStore {
    fn list_downloads(&self) -> RepositoryResult<Vec<DownloadTask>> {
        Ok(self.tasks.lock().expect("lock tasks").clone())
    }

    fn upsert_download_task(&self, task: &DownloadTask) -> RepositoryResult<Vec<DownloadTask>> {
        let mut tasks = self.tasks.lock().expect("lock tasks");
        tasks.retain(|item| item.id != task.id);
        tasks.insert(0, task.clone());
        Ok(tasks.clone())
    }

    fn remove_download_task(&self, task_id: &str) -> RepositoryResult<Vec<DownloadTask>> {
        let mut tasks = self.tasks.lock().expect("lock tasks");
        tasks.retain(|task| task.id != task_id && task.torrent_hash.as_deref() != Some(task_id));
        Ok(tasks.clone())
    }
}

struct FakeEngine {
    kind: TorrentEngineKind,
    tasks: Mutex<Vec<DownloadTask>>,
    calls: Mutex<Vec<String>>,
    list_error: Option<DownloadEngineError>,
    shutdown_error: Option<DownloadEngineError>,
}

impl FakeEngine {
    /// 创建返回固定任务快照的下载引擎替身。
    fn new(kind: TorrentEngineKind, tasks: Vec<DownloadTask>) -> Self {
        Self {
            kind,
            tasks: Mutex::new(tasks),
            calls: Mutex::new(Vec::new()),
            list_error: None,
            shutdown_error: None,
        }
    }

    /// 创建在刷新时返回错误的旧引擎替身。
    fn failing_list(kind: TorrentEngineKind) -> Self {
        Self {
            list_error: Some(DownloadEngineError::Unavailable("测试离线".to_owned())),
            ..Self::new(kind, Vec::new())
        }
    }

    /// 记录一次调用，供路由断言使用。
    fn record(&self, method: &str, task_id: Option<&str>) {
        self.calls.lock().expect("lock calls").push(match task_id {
            Some(task_id) => format!("{method}:{task_id}"),
            None => method.to_owned(),
        });
    }

    /// 返回已记录调用的快照。
    fn recorded(&self) -> Vec<String> {
        self.calls.lock().expect("lock calls").clone()
    }
}

#[async_trait]
impl DownloadEngine for FakeEngine {
    fn kind(&self) -> TorrentEngineKind {
        self.kind.clone()
    }

    async fn status(&self) -> Result<DownloadEngineStatus, DownloadEngineError> {
        Ok(DownloadEngineStatus {
            version: "test".to_owned(),
            task_count: self.tasks.lock().expect("lock tasks").len(),
            listen_port: Some(51413),
        })
    }

    async fn configure(
        &self,
        _config: &DownloadEngineConfig,
    ) -> Result<DownloadEngineStatus, DownloadEngineError> {
        self.status().await
    }

    async fn add_magnet(
        &self,
        _url: &str,
        _options: &AddTorrentOptions,
    ) -> Result<DownloadTask, DownloadEngineError> {
        self.record("addMagnet", None);
        self.tasks
            .lock()
            .expect("lock tasks")
            .first()
            .cloned()
            .ok_or_else(|| DownloadEngineError::Protocol("缺少添加回执".to_owned()))
    }

    async fn add_torrent_file(
        &self,
        _file_path: &Path,
        _options: &AddTorrentOptions,
    ) -> Result<DownloadTask, DownloadEngineError> {
        self.record("addTorrentFile", None);
        self.tasks
            .lock()
            .expect("lock tasks")
            .first()
            .cloned()
            .ok_or_else(|| DownloadEngineError::Protocol("缺少添加回执".to_owned()))
    }

    async fn list_tasks(&self) -> Result<Vec<DownloadTask>, DownloadEngineError> {
        self.record("listTasks", None);
        if let Some(error) = self.list_error.clone() {
            return Err(error);
        }
        Ok(self.tasks.lock().expect("lock tasks").clone())
    }

    async fn get_task(&self, task_id: &str) -> Result<DownloadTask, DownloadEngineError> {
        self.tasks
            .lock()
            .expect("lock tasks")
            .iter()
            .find(|task| task.id == task_id || task.torrent_hash.as_deref() == Some(task_id))
            .cloned()
            .ok_or_else(|| DownloadEngineError::TaskNotFound(task_id.to_owned()))
    }

    async fn get_files(&self, task_id: &str) -> Result<Vec<TorrentFile>, DownloadEngineError> {
        Ok(self.get_task(task_id).await?.files)
    }

    async fn set_file_priority(
        &self,
        task_id: &str,
        _file_indexes: &[i64],
        _priority: i64,
    ) -> Result<(), DownloadEngineError> {
        self.record("setFilePriority", Some(task_id));
        Ok(())
    }

    async fn pause(&self, task_id: &str) -> Result<(), DownloadEngineError> {
        self.record("pause", Some(task_id));
        Ok(())
    }

    async fn resume(&self, task_id: &str) -> Result<(), DownloadEngineError> {
        self.record("resume", Some(task_id));
        Ok(())
    }

    async fn remove(&self, task_id: &str, delete_files: bool) -> Result<(), DownloadEngineError> {
        self.record(
            if delete_files {
                "removeFiles"
            } else {
                "remove"
            },
            Some(task_id),
        );
        Ok(())
    }

    async fn shutdown(&self) -> Result<(), DownloadEngineError> {
        self.record("shutdown", None);
        match self.shutdown_error.clone() {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }
}

/// 验证添加任务时业务关联覆盖引擎动态快照并进入持久化端口。
#[tokio::test]
async fn adds_associated_task_through_selected_engine() {
    let raw = task("raw-id", TorrentEngineKind::Embedded, Some("hash-add"));
    let embedded = Arc::new(FakeEngine::new(TorrentEngineKind::Embedded, vec![raw]));
    let mut registry = DownloadEngineRegistry::new();
    registry
        .register(embedded.clone())
        .expect("register embedded");
    let store = Arc::new(MemoryStore::default());
    let service = DownloadTaskService::new(Arc::new(registry), store.clone());

    let tasks = service
        .add(DownloadAddRequest {
            engine: TorrentEngineKind::Embedded,
            source: DownloadSource::Magnet("magnet:?xt=urn:btih:hash-add".to_owned()),
            options: AddTorrentOptions {
                save_path: "C:/Downloads".to_owned(),
                correlation_tag: Some("auto-1".to_owned()),
                ..AddTorrentOptions::default()
            },
            context: DownloadTaskContext {
                release_id: Some("release-1".to_owned()),
                anime_id: Some("anime-1".to_owned()),
                episode_id: Some("episode-1".to_owned()),
                anime_title: Some("测试番剧".to_owned()),
                episode_no: Some(1.0),
                resolution: Some("1080p".to_owned()),
                subtitle_languages: vec!["chs".to_owned()],
                ..DownloadTaskContext::default()
            },
        })
        .await
        .expect("add associated task");

    assert_eq!(tasks[0].anime_id.as_deref(), Some("anime-1"));
    assert_eq!(tasks[0].release_id.as_deref(), Some("release-1"));
    assert_eq!(tasks[0].correlation_tag.as_deref(), Some("auto-1"));
    assert_eq!(embedded.recorded(), vec!["addMagnet"]);
}

/// 验证暂停、恢复、优先级和删除始终路由到任务创建时的引擎。
#[tokio::test]
async fn routes_task_controls_to_original_engine() {
    let existing = task("qb-task", TorrentEngineKind::Qbittorrent, Some("qb-hash"));
    let store = Arc::new(MemoryStore::with_tasks(vec![existing]));
    let embedded = Arc::new(FakeEngine::new(TorrentEngineKind::Embedded, Vec::new()));
    let qbittorrent = Arc::new(FakeEngine::new(TorrentEngineKind::Qbittorrent, Vec::new()));
    let mut registry = DownloadEngineRegistry::new();
    registry
        .register(embedded.clone())
        .expect("register embedded");
    registry
        .register(qbittorrent.clone())
        .expect("register qbittorrent");
    let service = DownloadTaskService::new(Arc::new(registry), store);

    let paused = service.pause("qb-task").await.expect("pause task");
    assert_eq!(paused[0].status, DownloadStatus::Paused);
    let prioritized = service
        .set_file_priority("qb-task", &[0], 0)
        .await
        .expect("set priority");
    assert!(!prioritized[0].files[0].selected);
    let resumed = service.resume("qb-task").await.expect("resume task");
    assert_eq!(resumed[0].status, DownloadStatus::Downloading);
    assert!(service
        .remove("qb-task", true)
        .await
        .expect("remove task")
        .is_empty());

    assert!(embedded.recorded().is_empty());
    assert_eq!(
        qbittorrent.recorded(),
        vec![
            "pause:qb-hash",
            "setFilePriority:qb-hash",
            "resume:qb-hash",
            "removeFiles:qb-hash"
        ]
    );
}

/// 验证刷新真实哈希任务时合并占位任务业务元数据并移除旧标识。
#[tokio::test]
async fn merges_engine_snapshot_with_pending_task() {
    let mut pending = task("pending-task", TorrentEngineKind::Embedded, None);
    pending.correlation_tag = Some("auto-correlation".to_owned());
    pending.anime_id = Some("anime-1".to_owned());
    pending.episode_id = Some("episode-1".to_owned());
    pending.files[0].episode_id = Some("episode-1".to_owned());
    let mut actual = task(
        "actual-hash",
        TorrentEngineKind::Embedded,
        Some("actual-hash"),
    );
    actual.correlation_tag = Some("auto-correlation".to_owned());
    actual.progress = 0.5;
    actual.files[0].progress = 0.5;
    let store = Arc::new(MemoryStore::with_tasks(vec![pending]));
    let embedded = Arc::new(FakeEngine::new(TorrentEngineKind::Embedded, vec![actual]));
    let mut registry = DownloadEngineRegistry::new();
    registry.register(embedded).expect("register embedded");
    let service = DownloadTaskService::new(Arc::new(registry), store);

    let result = service
        .refresh(TorrentEngineKind::Embedded)
        .await
        .expect("refresh embedded");
    assert!(result.failures.is_empty());
    assert_eq!(result.tasks.len(), 1);
    assert_eq!(result.tasks[0].id, "actual-hash");
    assert_eq!(result.tasks[0].anime_id.as_deref(), Some("anime-1"));
    assert_eq!(
        result.tasks[0].files[0].episode_id.as_deref(),
        Some("episode-1")
    );
}

/// 验证历史引擎刷新失败不会清空默认引擎和本地任务。
#[tokio::test]
async fn isolates_inactive_engine_refresh_failure() {
    let old = task(
        "old-qb-task",
        TorrentEngineKind::Qbittorrent,
        Some("old-qb-hash"),
    );
    let current = task(
        "embedded-task",
        TorrentEngineKind::Embedded,
        Some("embedded-hash"),
    );
    let store = Arc::new(MemoryStore::with_tasks(vec![old]));
    let embedded = Arc::new(FakeEngine::new(TorrentEngineKind::Embedded, vec![current]));
    let qbittorrent = Arc::new(FakeEngine::failing_list(TorrentEngineKind::Qbittorrent));
    let mut registry = DownloadEngineRegistry::new();
    registry.register(embedded).expect("register embedded");
    registry
        .register(qbittorrent)
        .expect("register qbittorrent");
    let service = DownloadTaskService::new(Arc::new(registry), store);

    let result = service
        .refresh(TorrentEngineKind::Embedded)
        .await
        .expect("refresh with old engine failure");
    assert_eq!(result.failures.len(), 1);
    assert_eq!(result.failures[0].engine, TorrentEngineKind::Qbittorrent);
    assert_eq!(result.tasks.len(), 2);
    assert!(result.tasks.iter().any(|task| task.id == "old-qb-task"));
    assert!(result.tasks.iter().any(|task| task.id == "embedded-task"));
}

/// 验证未注册引擎和重复注册以稳定错误返回。
#[test]
fn rejects_duplicate_and_missing_engines() {
    let embedded = Arc::new(FakeEngine::new(TorrentEngineKind::Embedded, Vec::new()));
    let mut registry = DownloadEngineRegistry::new();
    registry
        .register(embedded.clone())
        .expect("register embedded");
    assert!(registry.register(embedded).is_err());
    assert!(registry.require(&TorrentEngineKind::Qbittorrent).is_err());
    assert_eq!(registry.kinds(), vec![TorrentEngineKind::Embedded]);
}

/// 创建统一任务服务测试使用的任务快照。
fn task(id: &str, engine: TorrentEngineKind, hash: Option<&str>) -> DownloadTask {
    DownloadTask {
        id: id.to_owned(),
        release_id: None,
        anime_id: None,
        episode_id: None,
        anime_title: None,
        episode_no: None,
        fansub_group_id: None,
        fansub_name: None,
        resolution: None,
        declared_video_codec: None,
        normalized_video_codec: None,
        bit_depth: None,
        subtitle_languages: Vec::new(),
        subtitle: None,
        correlation_tag: None,
        engine,
        torrent_hash: hash.map(str::to_owned),
        name: id.to_owned(),
        status: DownloadStatus::Downloading,
        progress: 0.1,
        download_speed: 100,
        upload_speed: 10,
        eta_seconds: Some(60),
        save_path: "C:/Downloads".to_owned(),
        files: vec![TorrentFile {
            id: format!("{id}:0"),
            index: 0,
            name: "episode.mkv".to_owned(),
            episode_id: None,
            episode_no: None,
            size: 1024,
            progress: 0.1,
            priority: 1,
            selected: true,
        }],
        created_at: "2026-07-25T00:00:00.000Z".to_owned(),
        completed_at: None,
    }
}
