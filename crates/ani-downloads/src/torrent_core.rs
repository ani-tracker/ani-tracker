use std::path::Path;
use std::sync::Arc;

use ani_domain::{DownloadStatus, DownloadTask, TorrentEngineKind, TorrentFile};
use async_trait::async_trait;
use serde_json::{json, Value};

use crate::{
    AddTorrentOptions, DownloadEngine, DownloadEngineConfig, DownloadEngineError,
    DownloadEngineStatus,
};

/// 将内置核心命令通道与桌面进程或移动原生插件解耦。
#[async_trait]
pub trait TorrentCoreTransport: Send + Sync {
    /// 执行一条 torrent-core 协议命令并返回 result 字段。
    async fn execute(&self, method: &str, params: Value) -> Result<Value, DownloadEngineError>;

    /// 请求核心保存恢复数据并停止。
    async fn shutdown(&self) -> Result<(), DownloadEngineError>;
}

/// 将 torrent-core NDJSON 协议适配为统一下载引擎端口。
pub struct TorrentCoreEngine {
    transport: Arc<dyn TorrentCoreTransport>,
}

impl TorrentCoreEngine {
    /// 使用桌面 sidecar 或移动原生 transport 创建内置引擎。
    pub fn new(transport: Arc<dyn TorrentCoreTransport>) -> Self {
        Self { transport }
    }

    /// 执行核心命令并补充操作上下文。
    async fn execute(&self, method: &str, params: Value) -> Result<Value, DownloadEngineError> {
        self.transport.execute(method, params).await
    }
}

#[async_trait]
impl DownloadEngine for TorrentCoreEngine {
    fn kind(&self) -> TorrentEngineKind {
        TorrentEngineKind::Embedded
    }

    async fn status(&self) -> Result<DownloadEngineStatus, DownloadEngineError> {
        map_core_status(self.execute("status", json!({})).await?)
    }

    async fn configure(
        &self,
        config: &DownloadEngineConfig,
    ) -> Result<DownloadEngineStatus, DownloadEngineError> {
        map_core_status(
            self.execute(
                "configure",
                json!({
                    "listenPort": config.listen_port,
                    "dhtEnabled": config.dht_enabled,
                    "upnpEnabled": config.upnp_enabled,
                    "maxActiveDownloads": config.max_active_downloads,
                    "maxDownloadSpeed": config.max_download_speed,
                    "maxUploadSpeed": config.max_upload_speed,
                    "seedingLimits": {
                        "enabled": config.seeding_limits.enabled,
                        "ratioEnabled": config.seeding_limits.ratio_enabled,
                        "ratioLimit": config.seeding_limits.ratio_limit,
                        "timeEnabled": config.seeding_limits.time_enabled,
                        "timeLimitMinutes": config.seeding_limits.time_limit_minutes
                    }
                }),
            )
            .await?,
        )
    }

    async fn add_magnet(
        &self,
        url: &str,
        options: &AddTorrentOptions,
    ) -> Result<DownloadTask, DownloadEngineError> {
        let mut params = core_add_options(options);
        params["url"] = Value::String(url.to_owned());
        map_core_task(self.execute("addMagnet", params).await?)
    }

    async fn add_torrent_file(
        &self,
        file_path: &Path,
        options: &AddTorrentOptions,
    ) -> Result<DownloadTask, DownloadEngineError> {
        let mut params = core_add_options(options);
        params["filePath"] = Value::String(file_path.to_string_lossy().into_owned());
        map_core_task(self.execute("addTorrentFile", params).await?)
    }

    async fn list_tasks(&self) -> Result<Vec<DownloadTask>, DownloadEngineError> {
        let result = self.execute("listTasks", json!({})).await?;
        optional_array(result.get("tasks"), "listTasks.tasks")?
            .iter()
            .cloned()
            .map(map_core_task)
            .collect()
    }

    async fn get_task(&self, task_id: &str) -> Result<DownloadTask, DownloadEngineError> {
        map_core_task(
            self.execute("getTask", json!({ "taskId": task_id }))
                .await?,
        )
    }

    async fn get_files(&self, task_id: &str) -> Result<Vec<TorrentFile>, DownloadEngineError> {
        let result = self
            .execute("getFiles", json!({ "taskId": task_id }))
            .await?;
        optional_array(result.get("files"), "getFiles.files")?
            .iter()
            .map(|file| map_core_file(task_id, file))
            .collect()
    }

    async fn set_file_priority(
        &self,
        task_id: &str,
        file_indexes: &[i64],
        priority: i64,
    ) -> Result<(), DownloadEngineError> {
        self.execute(
            "setFilePriority",
            json!({
                "taskId": task_id,
                "fileIndexes": file_indexes,
                "priority": priority
            }),
        )
        .await?;
        Ok(())
    }

    async fn pause(&self, task_id: &str) -> Result<(), DownloadEngineError> {
        self.execute("pause", json!({ "taskId": task_id })).await?;
        Ok(())
    }

    async fn resume(&self, task_id: &str) -> Result<(), DownloadEngineError> {
        self.execute("resume", json!({ "taskId": task_id })).await?;
        Ok(())
    }

    async fn remove(&self, task_id: &str, delete_files: bool) -> Result<(), DownloadEngineError> {
        self.execute(
            "remove",
            json!({ "taskId": task_id, "deleteFiles": delete_files }),
        )
        .await?;
        Ok(())
    }

    async fn shutdown(&self) -> Result<(), DownloadEngineError> {
        self.transport.shutdown().await
    }
}

fn core_add_options(options: &AddTorrentOptions) -> Value {
    json!({
        "savePath": options.save_path,
        "selectedFileIndexes": options.selected_file_indexes.clone().unwrap_or_default(),
        "correlationTag": options.correlation_tag.clone().unwrap_or_default(),
        "paused": options.paused
    })
}

fn map_core_status(value: Value) -> Result<DownloadEngineStatus, DownloadEngineError> {
    Ok(DownloadEngineStatus {
        version: required_string(&value, "version")?,
        task_count: read_u64(value.get("taskCount"))
            .and_then(|number| usize::try_from(number).ok())
            .ok_or_else(|| protocol_error("status.taskCount 无效"))?,
        listen_port: read_u64(value.get("listenPort"))
            .and_then(|number| u16::try_from(number).ok()),
    })
}

fn map_core_task(value: Value) -> Result<DownloadTask, DownloadEngineError> {
    let id = required_string(&value, "id")?;
    let files = value
        .get("files")
        .and_then(Value::as_array)
        .map(|files| {
            files
                .iter()
                .map(|file| map_core_file(&id, file))
                .collect::<Result<Vec<_>, _>>()
        })
        .transpose()?
        .unwrap_or_default();
    Ok(DownloadTask {
        id: id.clone(),
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
        correlation_tag: optional_string(value.get("correlationTag")),
        engine: TorrentEngineKind::Embedded,
        torrent_hash: optional_string(value.get("torrentHash")).or_else(|| Some(id.clone())),
        name: optional_string(value.get("name")).unwrap_or_else(|| id.clone()),
        status: read_download_status(value.get("status")),
        progress: read_f64(value.get("progress"))
            .unwrap_or_default()
            .clamp(0.0, 1.0),
        download_speed: read_i64(value.get("downloadSpeed"))
            .unwrap_or_default()
            .max(0),
        upload_speed: read_i64(value.get("uploadSpeed"))
            .unwrap_or_default()
            .max(0),
        eta_seconds: read_i64(value.get("etaSeconds")).filter(|seconds| *seconds >= 0),
        save_path: optional_string(value.get("savePath")).unwrap_or_default(),
        files,
        created_at: required_string(&value, "createdAt")?,
        completed_at: optional_string(value.get("completedAt")),
    })
}

fn map_core_file(task_id: &str, value: &Value) -> Result<TorrentFile, DownloadEngineError> {
    let index = read_i64(value.get("index"))
        .filter(|index| *index >= 0)
        .ok_or_else(|| protocol_error("文件索引无效"))?;
    let priority = read_i64(value.get("priority"))
        .unwrap_or_default()
        .clamp(0, 7);
    Ok(TorrentFile {
        id: format!("{task_id}:{index}"),
        index,
        name: optional_string(value.get("name")).unwrap_or_else(|| format!("文件 {}", index + 1)),
        episode_id: None,
        episode_no: None,
        size: read_i64(value.get("size")).unwrap_or_default().max(0),
        progress: read_f64(value.get("progress"))
            .unwrap_or_default()
            .clamp(0.0, 1.0),
        priority,
        selected: read_bool(value.get("selected")).unwrap_or(priority > 0),
    })
}

fn required_string(value: &Value, field: &str) -> Result<String, DownloadEngineError> {
    optional_string(value.get(field)).ok_or_else(|| protocol_error(format!("核心响应缺少 {field}")))
}

fn optional_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn read_f64(value: Option<&Value>) -> Option<f64> {
    value
        .and_then(|value| value.as_f64().or_else(|| value.as_str()?.parse().ok()))
        .filter(|value| value.is_finite())
}

fn read_i64(value: Option<&Value>) -> Option<i64> {
    value.and_then(|value| {
        value.as_i64().or_else(|| {
            value
                .as_str()?
                .parse::<f64>()
                .ok()
                .filter(|number| number.is_finite())
                .map(|number| number.round() as i64)
        })
    })
}

fn read_u64(value: Option<&Value>) -> Option<u64> {
    read_i64(value).and_then(|number| u64::try_from(number).ok())
}

fn read_bool(value: Option<&Value>) -> Option<bool> {
    value.and_then(|value| {
        value.as_bool().or_else(|| match value.as_str()? {
            "true" => Some(true),
            "false" => Some(false),
            _ => None,
        })
    })
}

fn read_download_status(value: Option<&Value>) -> DownloadStatus {
    match value.and_then(Value::as_str) {
        Some("queued") => DownloadStatus::Queued,
        Some("fetching_metadata") => DownloadStatus::FetchingMetadata,
        Some("downloading") => DownloadStatus::Downloading,
        Some("stalled") => DownloadStatus::Stalled,
        Some("paused") => DownloadStatus::Paused,
        Some("checking") => DownloadStatus::Checking,
        Some("moving") => DownloadStatus::Moving,
        Some("completed") => DownloadStatus::Completed,
        Some("seeding") => DownloadStatus::Seeding,
        Some("missing_files") => DownloadStatus::MissingFiles,
        _ => DownloadStatus::Error,
    }
}

/// 兼容 Boost property_tree 将空数组编码为空字符串的行为。
fn optional_array<'a>(
    value: Option<&'a Value>,
    field: &str,
) -> Result<&'a [Value], DownloadEngineError> {
    match value {
        Some(Value::Array(items)) => Ok(items),
        Some(Value::String(text)) if text.is_empty() => Ok(&[]),
        _ => Err(protocol_error(format!("{field} 不是有效数组"))),
    }
}

fn protocol_error(message: impl Into<String>) -> DownloadEngineError {
    DownloadEngineError::Protocol(message.into())
}

#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
mod process {
    use std::fs;
    use std::io::{BufRead, BufReader, BufWriter, Write};
    use std::path::{Path, PathBuf};
    use std::process::{Child, ChildStdin, Command, Stdio};
    use std::sync::mpsc::{self, Receiver};
    use std::sync::{Arc, Mutex};
    use std::thread;
    use std::time::{Duration, Instant};

    use async_trait::async_trait;
    use serde_json::{json, Value};

    use crate::{DownloadEngineError, TorrentCoreTransport};

    const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
    const DEFAULT_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(10);

    /// 桌面 torrent-core sidecar 的可测试启动参数。
    #[derive(Debug, Clone)]
    pub struct TorrentCoreProcessOptions {
        pub binary_path: PathBuf,
        pub data_directory: PathBuf,
        pub request_timeout: Duration,
        pub shutdown_timeout: Duration,
    }

    impl TorrentCoreProcessOptions {
        /// 使用默认请求与关闭超时创建 sidecar 参数。
        pub fn new(binary_path: PathBuf, data_directory: PathBuf) -> Self {
            Self {
                binary_path,
                data_directory,
                request_timeout: DEFAULT_REQUEST_TIMEOUT,
                shutdown_timeout: DEFAULT_SHUTDOWN_TIMEOUT,
            }
        }
    }

    /// 持有桌面 sidecar 生命周期和串行 NDJSON 请求通道。
    pub struct ProcessTorrentCoreTransport {
        options: TorrentCoreProcessOptions,
        process: Arc<Mutex<Option<CoreProcess>>>,
    }

    impl ProcessTorrentCoreTransport {
        /// 创建按需启动的桌面 torrent-core transport。
        pub fn new(options: TorrentCoreProcessOptions) -> Self {
            Self {
                options,
                process: Arc::new(Mutex::new(None)),
            }
        }

        /// 返回当前仍存活的 sidecar 进程 ID，不会为查询而启动进程。
        pub async fn process_id(&self) -> Result<Option<u32>, DownloadEngineError> {
            let process = Arc::clone(&self.process);
            tokio::task::spawn_blocking(move || {
                let mut guard = process
                    .lock()
                    .map_err(|error| DownloadEngineError::Transport(error.to_string()))?;
                let Some(current) = guard.as_mut() else {
                    return Ok(None);
                };
                if current.has_exited()? {
                    *guard = None;
                    Ok(None)
                } else {
                    Ok(Some(current.child.id()))
                }
            })
            .await
            .map_err(|error| DownloadEngineError::Transport(error.to_string()))?
        }

        /// 在线程池中串行执行阻塞式进程 IO。
        async fn execute_blocking(
            &self,
            method: String,
            params: Value,
        ) -> Result<Value, DownloadEngineError> {
            let options = self.options.clone();
            let process = Arc::clone(&self.process);
            tokio::task::spawn_blocking(move || {
                let mut guard = process
                    .lock()
                    .map_err(|error| DownloadEngineError::Transport(error.to_string()))?;
                let restart = guard
                    .as_mut()
                    .map(CoreProcess::has_exited)
                    .transpose()?
                    .unwrap_or(true);
                if restart {
                    if let Some(mut old) = guard.take() {
                        old.terminate();
                    }
                    let mut started = CoreProcess::spawn(&options)?;
                    started.send("status", json!({}), options.request_timeout)?;
                    log::info!(
                        "torrent-core sidecar 已就绪：pid={}, binary={}",
                        started.child.id(),
                        options.binary_path.display()
                    );
                    *guard = Some(started);
                }
                guard
                    .as_mut()
                    .expect("torrent-core process initialized")
                    .send(&method, params, options.request_timeout)
            })
            .await
            .map_err(|error| DownloadEngineError::Transport(error.to_string()))?
        }
    }

    #[async_trait]
    impl TorrentCoreTransport for ProcessTorrentCoreTransport {
        async fn execute(&self, method: &str, params: Value) -> Result<Value, DownloadEngineError> {
            self.execute_blocking(method.to_owned(), params).await
        }

        async fn shutdown(&self) -> Result<(), DownloadEngineError> {
            let process = Arc::clone(&self.process);
            let timeout = self.options.shutdown_timeout;
            tokio::task::spawn_blocking(move || {
                let mut guard = process
                    .lock()
                    .map_err(|error| DownloadEngineError::Transport(error.to_string()))?;
                let Some(mut process) = guard.take() else {
                    return Ok(());
                };
                process.shutdown(timeout)
            })
            .await
            .map_err(|error| DownloadEngineError::Transport(error.to_string()))?
        }
    }

    struct CoreProcess {
        child: Child,
        stdin: BufWriter<ChildStdin>,
        responses: Receiver<String>,
        sequence: u64,
    }

    impl CoreProcess {
        /// 启动进程并挂接 stdout 响应及 stderr 日志线程。
        fn spawn(options: &TorrentCoreProcessOptions) -> Result<Self, DownloadEngineError> {
            if !options.binary_path.is_file() {
                return Err(DownloadEngineError::Unavailable(format!(
                    "未找到 torrent-core：{}",
                    options.binary_path.display()
                )));
            }
            fs::create_dir_all(&options.data_directory).map_err(|error| {
                DownloadEngineError::Transport(format!("创建 torrent-core 数据目录失败：{error}"))
            })?;
            let mut command = Command::new(&options.binary_path);
            command
                .arg("--data-dir")
                .arg(&options.data_directory)
                .current_dir(
                    options
                        .binary_path
                        .parent()
                        .unwrap_or_else(|| Path::new(".")),
                )
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            apply_library_search_path(&mut command, &options.binary_path)?;
            #[cfg(target_os = "windows")]
            {
                use std::os::windows::process::CommandExt;
                command.creation_flags(0x0800_0000);
            }
            let mut child = command.spawn().map_err(|error| {
                DownloadEngineError::Unavailable(format!("启动 torrent-core 失败：{error}"))
            })?;
            let stdin = child
                .stdin
                .take()
                .ok_or_else(|| DownloadEngineError::Transport("无法连接核心 stdin".to_owned()))?;
            let stdout = child
                .stdout
                .take()
                .ok_or_else(|| DownloadEngineError::Transport("无法连接核心 stdout".to_owned()))?;
            let stderr = child
                .stderr
                .take()
                .ok_or_else(|| DownloadEngineError::Transport("无法连接核心 stderr".to_owned()))?;
            let (sender, responses) = mpsc::channel();
            thread::spawn(move || {
                for line in BufReader::new(stdout).lines() {
                    match line {
                        Ok(line) => {
                            if sender.send(line).is_err() {
                                break;
                            }
                        }
                        Err(error) => {
                            log::error!("torrent-core stdout 读取失败：{error}");
                            break;
                        }
                    }
                }
            });
            thread::spawn(move || {
                for line in BufReader::new(stderr).lines() {
                    match line {
                        Ok(line) if !line.trim().is_empty() => {
                            log::warn!("torrent-core stderr：{line}");
                        }
                        Ok(_) => {}
                        Err(error) => {
                            log::warn!("torrent-core stderr 读取失败：{error}");
                            break;
                        }
                    }
                }
            });
            Ok(Self {
                child,
                stdin: BufWriter::new(stdin),
                responses,
                sequence: 0,
            })
        }

        /// 判断进程是否已经退出，并记录异常退出码。
        fn has_exited(&mut self) -> Result<bool, DownloadEngineError> {
            self.child
                .try_wait()
                .map(|status| {
                    if let Some(status) = status {
                        log::warn!("torrent-core 已退出：status={status}");
                        true
                    } else {
                        false
                    }
                })
                .map_err(|error| DownloadEngineError::Transport(error.to_string()))
        }

        /// 写入一条请求并在时限内读取相同 ID 的响应。
        fn send(
            &mut self,
            method: &str,
            params: Value,
            timeout: Duration,
        ) -> Result<Value, DownloadEngineError> {
            if self.has_exited()? {
                return Err(DownloadEngineError::Unavailable(
                    "torrent-core 已退出".to_owned(),
                ));
            }
            self.sequence += 1;
            let request_id = format!("core-{}-{}", self.child.id(), self.sequence);
            let request = json!({
                "id": request_id,
                "method": method,
                "params": params
            });
            serde_json::to_writer(&mut self.stdin, &request)
                .map_err(|error| DownloadEngineError::Protocol(error.to_string()))?;
            self.stdin
                .write_all(b"\n")
                .and_then(|_| self.stdin.flush())
                .map_err(|error| DownloadEngineError::Transport(error.to_string()))?;

            let deadline = Instant::now() + timeout;
            loop {
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    return Err(DownloadEngineError::Transport(format!(
                        "torrent-core 请求超时：{method}"
                    )));
                }
                let line = self.responses.recv_timeout(remaining).map_err(|error| {
                    DownloadEngineError::Transport(format!(
                        "torrent-core 响应等待失败（{method}）：{error}"
                    ))
                })?;
                let response: Value = serde_json::from_str(&line).map_err(|error| {
                    DownloadEngineError::Protocol(format!("核心响应不是有效 JSON：{error}"))
                })?;
                if response.get("id").and_then(Value::as_str) != Some(request_id.as_str()) {
                    log::warn!("torrent-core 返回未知请求 ID，已忽略");
                    continue;
                }
                if super::read_bool(response.get("ok")) == Some(true) {
                    return Ok(response.get("result").cloned().unwrap_or(Value::Null));
                }
                let code = response
                    .pointer("/error/code")
                    .and_then(Value::as_str)
                    .unwrap_or("CORE_ERROR");
                let message = response
                    .pointer("/error/message")
                    .and_then(Value::as_str)
                    .unwrap_or("torrent-core 请求失败");
                return Err(DownloadEngineError::Protocol(format!("{message} ({code})")));
            }
        }

        /// 请求状态落盘并等待退出，超时后终止进程。
        fn shutdown(&mut self, timeout: Duration) -> Result<(), DownloadEngineError> {
            if !self.has_exited()? {
                let _ = self.send("shutdown", json!({}), timeout);
                let deadline = Instant::now() + timeout;
                while Instant::now() < deadline {
                    if self.has_exited()? {
                        log::info!("torrent-core 已优雅退出");
                        return Ok(());
                    }
                    thread::sleep(Duration::from_millis(50));
                }
                log::warn!("torrent-core 关闭超时，终止子进程");
                self.terminate();
            }
            Ok(())
        }

        /// 强制终止仍在运行的子进程并回收句柄。
        fn terminate(&mut self) {
            if self.child.try_wait().ok().flatten().is_none() {
                let _ = self.child.kill();
            }
            let _ = self.child.wait();
        }
    }

    impl Drop for CoreProcess {
        fn drop(&mut self) {
            self.terminate();
        }
    }

    /// 将 sidecar 目录置于平台动态库搜索路径首位。
    fn apply_library_search_path(
        command: &mut Command,
        binary_path: &Path,
    ) -> Result<(), DownloadEngineError> {
        let Some(binary_directory) = binary_path.parent() else {
            return Ok(());
        };
        let variable = if cfg!(target_os = "windows") {
            "PATH"
        } else if cfg!(target_os = "macos") {
            "DYLD_LIBRARY_PATH"
        } else {
            "LD_LIBRARY_PATH"
        };
        let mut paths = vec![binary_directory.to_path_buf()];
        if let Some(current) = std::env::var_os(variable) {
            paths.extend(std::env::split_paths(&current));
        }
        let joined = std::env::join_paths(paths).map_err(|error| {
            DownloadEngineError::InvalidInput(format!("动态库搜索路径无效：{error}"))
        })?;
        command.env(variable, joined);
        Ok(())
    }
}

#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
pub use process::{ProcessTorrentCoreTransport, TorrentCoreProcessOptions};
