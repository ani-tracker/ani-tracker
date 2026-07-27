use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use ani_downloads::{map_torrent_core_error, DownloadEngineError, TorrentCoreTransport};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// 平台原生核心生命周期快照。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeTorrentCoreStatus {
    pub running: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data_directory: Option<String>,
    #[serde(default)]
    pub foreground_service: bool,
}

#[cfg(mobile)]
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExecuteRequest {
    pub(crate) request_json: String,
}

#[cfg(mobile)]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExecuteResponse {
    pub(crate) response_json: String,
}

#[cfg(mobile)]
#[derive(Debug, Deserialize)]
pub(crate) struct ShutdownResponse {
    pub(crate) stopped: bool,
}

/// 隔离 Tauri PluginHandle，允许在桌面单元测试移动协议。
#[async_trait]
pub(crate) trait MobileTorrentBackend: Send + Sync {
    async fn execute(&self, request_json: String) -> Result<String, String>;
    async fn status(&self) -> Result<NativeTorrentCoreStatus, String>;
    async fn shutdown(&self) -> Result<(), String>;
}

/// 将 Android Service 或 iOS Session 适配为统一 torrent-core transport。
pub struct MobileTorrentCoreTransport {
    backend: Arc<dyn MobileTorrentBackend>,
    sequence: AtomicU64,
}

impl MobileTorrentCoreTransport {
    /// 仅由已注册的平台插件创建 transport。
    #[cfg(any(mobile, test))]
    pub(crate) fn new(backend: Arc<dyn MobileTorrentBackend>) -> Self {
        Self {
            backend,
            sequence: AtomicU64::new(0),
        }
    }

    /// 查询平台生命周期，不会通过业务命令启动核心。
    pub async fn native_status(&self) -> Result<NativeTorrentCoreStatus, DownloadEngineError> {
        self.backend
            .status()
            .await
            .map_err(DownloadEngineError::Transport)
    }
}

#[async_trait]
impl TorrentCoreTransport for MobileTorrentCoreTransport {
    /// 生成版本化请求 ID，并严格校验平台返回的响应包络。
    async fn execute(&self, method: &str, params: Value) -> Result<Value, DownloadEngineError> {
        let request_id = format!(
            "mobile-{}-{}",
            std::process::id(),
            self.sequence.fetch_add(1, Ordering::Relaxed) + 1
        );
        let request_json = serde_json::to_string(&json!({
            "id": request_id,
            "method": method,
            "params": params
        }))
        .map_err(|error| DownloadEngineError::Protocol(error.to_string()))?;
        let response_json = self
            .backend
            .execute(request_json)
            .await
            .map_err(DownloadEngineError::Transport)?;
        let response: Value = serde_json::from_str(&response_json).map_err(|error| {
            DownloadEngineError::Protocol(format!("移动核心响应不是有效 JSON：{error}"))
        })?;
        if response.get("id").and_then(Value::as_str) != Some(request_id.as_str()) {
            return Err(DownloadEngineError::Protocol(
                "移动核心返回未知请求 ID".to_owned(),
            ));
        }
        if read_bool(response.get("ok")) == Some(true) {
            return Ok(response.get("result").cloned().unwrap_or(Value::Null));
        }
        let code = response
            .pointer("/error/code")
            .and_then(Value::as_str)
            .unwrap_or("CORE_ERROR");
        let message = response
            .pointer("/error/message")
            .and_then(Value::as_str)
            .unwrap_or("移动 torrent-core 请求失败");
        Err(map_torrent_core_error(code, message))
    }

    /// 通过平台生命周期入口保存恢复数据并停止核心。
    async fn shutdown(&self) -> Result<(), DownloadEngineError> {
        self.backend
            .shutdown()
            .await
            .map_err(DownloadEngineError::Transport)
    }
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

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    #[derive(Default)]
    struct StubBackend {
        requests: Mutex<Vec<Value>>,
        failure: Mutex<Option<(String, String)>>,
    }

    #[async_trait]
    impl MobileTorrentBackend for StubBackend {
        async fn execute(&self, request_json: String) -> Result<String, String> {
            let request: Value = serde_json::from_str(&request_json).expect("decode request");
            self.requests
                .lock()
                .expect("lock requests")
                .push(request.clone());
            if let Some((code, message)) = self.failure.lock().expect("lock failure").clone() {
                return Ok(json!({
                    "id": request["id"],
                    "ok": "false",
                    "error": { "code": code, "message": message }
                })
                .to_string());
            }
            Ok(json!({
                "id": request["id"],
                "ok": "true",
                "result": { "version": "0.1.0", "taskCount": "0" }
            })
            .to_string())
        }

        async fn status(&self) -> Result<NativeTorrentCoreStatus, String> {
            Ok(NativeTorrentCoreStatus {
                running: true,
                data_directory: Some("/private/torrent-core".to_owned()),
                foreground_service: true,
            })
        }

        async fn shutdown(&self) -> Result<(), String> {
            Ok(())
        }
    }

    /// 验证移动 transport 生成请求并兼容 property_tree 字符串布尔值。
    #[tokio::test]
    async fn maps_mobile_request_and_response() {
        let backend = Arc::new(StubBackend::default());
        let transport = MobileTorrentCoreTransport::new(backend.clone());

        let result = transport
            .execute("status", json!({}))
            .await
            .expect("execute mobile request");

        assert_eq!(result["version"], "0.1.0");
        assert_eq!(
            backend.requests.lock().expect("lock")[0]["method"],
            "status"
        );
    }

    /// 验证平台核心错误保留稳定错误码与消息。
    #[tokio::test]
    async fn maps_mobile_core_error() {
        let backend = Arc::new(StubBackend::default());
        *backend.failure.lock().expect("lock") = Some(("TEST".to_owned(), "测试失败".to_owned()));
        let transport = MobileTorrentCoreTransport::new(backend);

        let error = transport
            .execute("getTask", json!({ "taskId": "missing" }))
            .await
            .expect_err("request must fail");

        assert!(error.to_string().contains("测试失败 (TEST)"));
    }

    /// 验证移动核心任务缺失映射为可幂等处理的稳定错误。
    #[tokio::test]
    async fn maps_mobile_missing_task_error() {
        let backend = Arc::new(StubBackend::default());
        *backend.failure.lock().expect("lock") = Some((
            "TASK_NOT_FOUND".to_owned(),
            "内置下载任务不存在: missing".to_owned(),
        ));
        let transport = MobileTorrentCoreTransport::new(backend);

        let error = transport
            .execute("remove", json!({ "taskId": "missing" }))
            .await
            .expect_err("request must fail");

        assert!(matches!(error, DownloadEngineError::TaskNotFound(_)));
    }
}
