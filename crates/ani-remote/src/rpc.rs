use async_trait::async_trait;
use serde_json::{json, Map, Value};

const HIDDEN_LOCAL_PATH: &str = "本机路径已隐藏";

#[derive(Clone, Copy)]
struct MethodDefinition {
    name: &'static str,
    scope: &'static str,
    effect: RpcEffect,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum RpcEffect {
    Read,
    Write,
}

const METHODS: &[MethodDefinition] = &[
    method("getDashboard", "dashboard.read", RpcEffect::Read),
    method("listNotifications", "notifications.read", RpcEffect::Read),
    method(
        "getUnreadNotificationCount",
        "notifications.read",
        RpcEffect::Read,
    ),
    method(
        "markNotificationRead",
        "notifications.write",
        RpcEffect::Write,
    ),
    method(
        "markAllNotificationsRead",
        "notifications.write",
        RpcEffect::Write,
    ),
    method("listMyAnime", "library.read", RpcEffect::Read),
    method("listMyAnimeWatchProgress", "library.read", RpcEffect::Read),
    method("setAnimeWatchProgress", "library.write", RpcEffect::Write),
    method("reportPlaybackProgress", "library.write", RpcEffect::Write),
    method("savePlaybackCheckpoint", "library.write", RpcEffect::Write),
    method("listAnimeCatalog", "catalog.read", RpcEffect::Read),
    method("getAnimeDetail", "catalog.read", RpcEffect::Read),
    method("searchAnimeCatalog", "catalog.read", RpcEffect::Read),
    method("listFansubs", "library.read", RpcEffect::Read),
    method("listEpisodes", "library.read", RpcEffect::Read),
    method("listEpisodePreferences", "library.read", RpcEffect::Read),
    method("listDownloads", "downloads.read", RpcEffect::Read),
    method("refreshDownloads", "downloads.control", RpcEffect::Write),
    method("pauseDownload", "downloads.control", RpcEffect::Write),
    method("resumeDownload", "downloads.control", RpcEffect::Write),
];

const fn method(name: &'static str, scope: &'static str, effect: RpcEffect) -> MethodDefinition {
    MethodDefinition {
        name,
        scope,
        effect,
    }
}

/// Tauri 宿主对远程核心开放的显式业务调用端口。
#[async_trait]
pub trait RemoteRpcHandler: Send + Sync {
    /// 执行已完成协议校验的方法并返回可序列化结果。
    async fn call(&self, method: &str, args: Vec<Value>) -> Result<Value, String>;
}

/// 远程 RPC 的稳定协议错误。
#[derive(Debug, thiserror::Error)]
#[error("{message}")]
pub struct RemoteRpcError {
    pub status: u16,
    pub code: &'static str,
    pub message: String,
}

impl RemoteRpcError {
    fn new(status: u16, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
        }
    }
}

/// 对固定方法执行请求校验、scope 授权、调用与返回值脱敏。
pub struct RemoteRpcService {
    handler: std::sync::Arc<dyn RemoteRpcHandler>,
}

impl RemoteRpcService {
    /// 使用显式业务端口创建 RPC 服务。
    pub fn new(handler: std::sync::Arc<dyn RemoteRpcHandler>) -> Self {
        Self { handler }
    }

    /// 返回方法的读写效果，供 HTTP 层应用不同限流。
    pub(crate) fn is_write_method(&self, request: &Value) -> bool {
        request
            .get("method")
            .and_then(Value::as_str)
            .and_then(find_method)
            .is_some_and(|definition| definition.effect == RpcEffect::Write)
    }

    /// 分发一个 JSON RPC 请求，并返回完成字段脱敏的结果。
    pub async fn dispatch(
        &self,
        request: Value,
        granted_scopes: &[String],
    ) -> Result<Value, RemoteRpcError> {
        let object = request
            .as_object()
            .ok_or_else(|| RemoteRpcError::new(400, "INVALID_REQUEST", "远程请求格式无效"))?;
        if object.keys().any(|key| key != "method" && key != "args") {
            return Err(RemoteRpcError::new(
                400,
                "INVALID_REQUEST",
                "远程请求包含未知字段",
            ));
        }
        let method_name = object
            .get("method")
            .and_then(Value::as_str)
            .filter(|name| !name.is_empty() && name.len() <= 80)
            .ok_or_else(|| RemoteRpcError::new(400, "INVALID_REQUEST", "远程方法名格式无效"))?;
        let definition = find_method(method_name)
            .ok_or_else(|| RemoteRpcError::new(404, "METHOD_NOT_FOUND", "远程方法不存在"))?;
        if !granted_scopes.iter().any(|scope| scope == definition.scope) {
            return Err(RemoteRpcError::new(
                403,
                "FORBIDDEN",
                "设备未获得此操作权限",
            ));
        }
        let args = match object.get("args") {
            None => Vec::new(),
            Some(Value::Array(args)) if args.len() <= 4 => args.clone(),
            _ => {
                return Err(RemoteRpcError::new(
                    400,
                    "INVALID_REQUEST",
                    "远程参数必须是最多四项的数组",
                ))
            }
        };
        let args = validate_args(method_name, args)?;
        let result = self
            .handler
            .call(method_name, args)
            .await
            .map_err(|error| {
                log::error!("Rust 远程 RPC 调用失败 method={method_name} error={error}");
                RemoteRpcError::new(500, "HANDLER_FAILED", "远程操作执行失败")
            })?;
        sanitize_result(method_name, result)
    }
}

fn find_method(name: &str) -> Option<&'static MethodDefinition> {
    METHODS.iter().find(|definition| definition.name == name)
}

fn validate_args(method: &str, args: Vec<Value>) -> Result<Vec<Value>, RemoteRpcError> {
    match method {
        "getDashboard"
        | "listNotifications"
        | "getUnreadNotificationCount"
        | "markAllNotificationsRead"
        | "listMyAnime"
        | "listMyAnimeWatchProgress"
        | "listDownloads"
        | "refreshDownloads" => require_count(args, 0),
        "markNotificationRead"
        | "getAnimeDetail"
        | "listEpisodes"
        | "listEpisodePreferences"
        | "pauseDownload"
        | "resumeDownload" => {
            let args = require_count(args, 1)?;
            parse_id(&args[0], "标识")?;
            Ok(args)
        }
        "listFansubs" => {
            if args.is_empty() {
                return Ok(args);
            }
            let args = require_count(args, 1)?;
            if !args[0].is_null() {
                parse_id(&args[0], "番剧标识")?;
            }
            Ok(args)
        }
        "searchAnimeCatalog" => {
            let args = require_count(args, 1)?;
            let keyword = args[0]
                .as_str()
                .map(str::trim)
                .filter(|value| !value.is_empty() && value.chars().count() <= 120)
                .filter(|value| !value.chars().any(char::is_control))
                .ok_or_else(|| invalid_args("搜索关键词长度必须为 1-120 个字符"))?;
            Ok(vec![Value::String(keyword.to_owned())])
        }
        "listAnimeCatalog" => validate_year_month(args),
        "setAnimeWatchProgress" => {
            validate_object_input(args, &["animeId", "watchedEpisodeCount"], |object| {
                parse_id(object.get("animeId").unwrap_or(&Value::Null), "番剧标识")?;
                let count = object
                    .get("watchedEpisodeCount")
                    .and_then(Value::as_i64)
                    .filter(|value| (0..=10_000).contains(value))
                    .ok_or_else(|| invalid_args("观看进度必须是 0 到 10000 之间的整数"))?;
                if object.get("watchedEpisodeCount").and_then(Value::as_f64) != Some(count as f64) {
                    return Err(invalid_args("观看进度必须是整数"));
                }
                Ok(())
            })
        }
        "reportPlaybackProgress" => {
            validate_object_input(args, &["taskId", "fileIndex", "percent"], |object| {
                parse_id(object.get("taskId").unwrap_or(&Value::Null), "下载任务标识")?;
                validate_optional_file_index(object.get("fileIndex"))?;
                object
                    .get("percent")
                    .and_then(Value::as_f64)
                    .filter(|value| value.is_finite() && (0.0..=100.0).contains(value))
                    .ok_or_else(|| invalid_args("播放进度必须是 0 到 100 之间的数值"))?;
                Ok(())
            })
        }
        "savePlaybackCheckpoint" => validate_object_input(
            args,
            &[
                "taskId",
                "fileIndex",
                "positionSeconds",
                "durationSeconds",
                "completed",
            ],
            |object| {
                parse_id(object.get("taskId").unwrap_or(&Value::Null), "下载任务标识")?;
                validate_optional_file_index(object.get("fileIndex"))?;
                for key in ["positionSeconds", "durationSeconds"] {
                    object
                        .get(key)
                        .and_then(Value::as_f64)
                        .filter(|value| value.is_finite() && (0.0..=2_678_400.0).contains(value))
                        .ok_or_else(|| invalid_args("播放位置和时长必须是有效的非负秒数"))?;
                }
                if object
                    .get("completed")
                    .is_some_and(|value| !value.is_boolean())
                {
                    return Err(invalid_args("播放完成状态必须是布尔值"));
                }
                Ok(())
            },
        ),
        _ => Err(invalid_args("远程参数校验失败")),
    }
}

fn require_count(args: Vec<Value>, expected: usize) -> Result<Vec<Value>, RemoteRpcError> {
    if args.len() != expected {
        return Err(invalid_args(format!("参数数量无效，预期 {expected} 个")));
    }
    Ok(args)
}

fn parse_id<'a>(value: &'a Value, label: &str) -> Result<&'a str, RemoteRpcError> {
    let value = value
        .as_str()
        .map(str::trim)
        .ok_or_else(|| invalid_args(format!("{label}必须是字符串")))?;
    if value.is_empty()
        || value.len() > 160
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
    {
        return Err(invalid_args(format!("{label}格式无效")));
    }
    Ok(value)
}

fn validate_year_month(args: Vec<Value>) -> Result<Vec<Value>, RemoteRpcError> {
    if args.is_empty() {
        return Ok(args);
    }
    let args = require_count(args, 2)?;
    if args.iter().all(Value::is_null) {
        return Ok(Vec::new());
    }
    let year = args[0]
        .as_i64()
        .filter(|value| (1900..=2200).contains(value))
        .ok_or_else(|| invalid_args("年份必须为 1900-2200 的整数"))?;
    let month = args[1]
        .as_i64()
        .filter(|value| (1..=12).contains(value))
        .ok_or_else(|| invalid_args("月份必须为 1-12 的整数"))?;
    Ok(vec![json!(year), json!(month)])
}

fn validate_object_input(
    args: Vec<Value>,
    allowed_keys: &[&str],
    validate: impl FnOnce(&Map<String, Value>) -> Result<(), RemoteRpcError>,
) -> Result<Vec<Value>, RemoteRpcError> {
    let args = require_count(args, 1)?;
    let object = args[0]
        .as_object()
        .ok_or_else(|| invalid_args("远程参数格式无效"))?;
    if object
        .keys()
        .any(|key| !allowed_keys.contains(&key.as_str()))
    {
        return Err(invalid_args("远程参数包含未知字段"));
    }
    validate(object)?;
    Ok(args)
}

fn validate_optional_file_index(value: Option<&Value>) -> Result<(), RemoteRpcError> {
    if let Some(value) = value {
        value
            .as_i64()
            .filter(|value| *value >= 0)
            .ok_or_else(|| invalid_args("播放文件索引必须是非负整数"))?;
    }
    Ok(())
}

fn invalid_args(message: impl Into<String>) -> RemoteRpcError {
    RemoteRpcError::new(400, "INVALID_ARGUMENTS", message)
}

fn sanitize_result(method: &str, mut value: Value) -> Result<Value, RemoteRpcError> {
    match method {
        "listMyAnime" => sanitize_array(&mut value, sanitize_my_anime)?,
        "listDownloads" | "refreshDownloads" | "pauseDownload" | "resumeDownload" => {
            sanitize_array(&mut value, sanitize_download)?
        }
        "getDashboard" => {
            let object = require_result_object(&mut value, "首页看板")?;
            if let Some(downloads) = object.get_mut("activeDownloads") {
                sanitize_array(downloads, sanitize_download)?;
            }
            if let Some(media) = object.get_mut("recentCompleted") {
                sanitize_array(media, sanitize_media)?;
            }
        }
        "listNotifications" | "markNotificationRead" | "markAllNotificationsRead" => {
            let items = require_result_array(&mut value, "通知列表")?;
            for item in items {
                let object = item
                    .as_object_mut()
                    .ok_or_else(|| invalid_result("通知记录格式无效"))?;
                for key in ["title", "body"] {
                    if let Some(Value::String(text)) = object.get_mut(key) {
                        *text = redact_free_text(text);
                    }
                }
            }
        }
        "getUnreadNotificationCount" if value.as_u64().is_none() => {
            return Err(invalid_result("未读数量返回格式无效"));
        }
        "getAnimeDetail" => {
            let object = require_result_object(&mut value, "番剧详情")?;
            if let Some(my_anime) = object.get_mut("myAnime") {
                sanitize_my_anime(my_anime)?;
            }
            redact_error_list(object.get_mut("partialErrors"));
        }
        "searchAnimeCatalog" => {
            let object = require_result_object(&mut value, "新番搜索结果")?;
            redact_string(object.get_mut("keyword"));
            redact_string(object.get_mut("source"));
            if let Some(Value::Array(errors)) = object.get_mut("errors") {
                for error in errors {
                    redact_string(Some(error));
                }
            }
        }
        "reportPlaybackProgress" if !value.is_boolean() => {
            return Err(invalid_result("远程处理结果格式无效"));
        }
        _ => {}
    }
    Ok(value)
}

fn sanitize_array(
    value: &mut Value,
    sanitizer: fn(&mut Value) -> Result<(), RemoteRpcError>,
) -> Result<(), RemoteRpcError> {
    for item in require_result_array(value, "远程列表")? {
        sanitizer(item)?;
    }
    Ok(())
}

fn sanitize_my_anime(value: &mut Value) -> Result<(), RemoteRpcError> {
    let object = require_result_object(value, "追番记录")?;
    object.remove("downloadDir");
    object.remove("rssSubscriptions");
    Ok(())
}

fn sanitize_download(value: &mut Value) -> Result<(), RemoteRpcError> {
    let object = require_result_object(value, "下载记录")?;
    object.remove("torrentHash");
    object.remove("correlationTag");
    object.insert(
        "savePath".to_owned(),
        Value::String(HIDDEN_LOCAL_PATH.to_owned()),
    );
    Ok(())
}

fn sanitize_media(value: &mut Value) -> Result<(), RemoteRpcError> {
    let object = require_result_object(value, "媒体记录")?;
    object.insert(
        "filePath".to_owned(),
        Value::String(HIDDEN_LOCAL_PATH.to_owned()),
    );
    Ok(())
}

fn require_result_object<'a>(
    value: &'a mut Value,
    label: &str,
) -> Result<&'a mut Map<String, Value>, RemoteRpcError> {
    value
        .as_object_mut()
        .ok_or_else(|| invalid_result(format!("{label}返回格式无效")))
}

fn require_result_array<'a>(
    value: &'a mut Value,
    label: &str,
) -> Result<&'a mut Vec<Value>, RemoteRpcError> {
    value
        .as_array_mut()
        .ok_or_else(|| invalid_result(format!("{label}返回格式无效")))
}

fn invalid_result(message: impl Into<String>) -> RemoteRpcError {
    RemoteRpcError::new(500, "HANDLER_FAILED", message)
}

fn redact_error_list(value: Option<&mut Value>) {
    if let Some(Value::Array(items)) = value {
        for item in items {
            if let Some(object) = item.as_object_mut() {
                redact_string(object.get_mut("source"));
                redact_string(object.get_mut("message"));
            }
        }
    }
}

fn redact_string(value: Option<&mut Value>) {
    if let Some(Value::String(text)) = value {
        *text = redact_free_text(text);
    }
}

fn redact_free_text(value: &str) -> String {
    value
        .split_whitespace()
        .map(|token| {
            let lower = token.to_ascii_lowercase();
            if lower.starts_with("http://")
                || lower.starts_with("https://")
                || lower.starts_with("ftp://")
            {
                "[链接已隐藏]".to_owned()
            } else if looks_like_local_path(token) {
                "[本机路径已隐藏]".to_owned()
            } else {
                token.to_owned()
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn looks_like_local_path(value: &str) -> bool {
    (value.len() >= 3
        && value.as_bytes()[0].is_ascii_alphabetic()
        && value.as_bytes()[1] == b':'
        && matches!(value.as_bytes()[2], b'\\' | b'/'))
        || value.starts_with("\\\\")
        || [
            "/Users/",
            "/home/",
            "/var/",
            "/private/",
            "/Volumes/",
            "/mnt/",
            "/media/",
        ]
        .iter()
        .any(|prefix| value.starts_with(prefix))
}

#[cfg(test)]
mod tests {
    use super::*;

    struct EchoHandler;

    #[async_trait]
    impl RemoteRpcHandler for EchoHandler {
        async fn call(&self, method: &str, args: Vec<Value>) -> Result<Value, String> {
            match method {
                "listDownloads" => Ok(json!([{
                    "id": "task-1",
                    "torrentHash": "secret-hash",
                    "correlationTag": "secret-tag",
                    "savePath": "C:\\Downloads",
                    "files": []
                }])),
                "pauseDownload" => Ok(json!([])),
                _ => Ok(json!({ "args": args })),
            }
        }
    }

    /// 验证未知方法、scope 不足和未知参数字段均被拒绝。
    #[tokio::test]
    async fn validates_method_scope_and_arguments() {
        let service = RemoteRpcService::new(std::sync::Arc::new(EchoHandler));
        let scopes = vec!["downloads.read".to_owned()];
        let unknown = service
            .dispatch(json!({ "method": "removeDownload", "args": [] }), &scopes)
            .await
            .expect_err("unknown method");
        assert_eq!(unknown.code, "METHOD_NOT_FOUND");

        let forbidden = service
            .dispatch(
                json!({ "method": "pauseDownload", "args": ["task-1"] }),
                &scopes,
            )
            .await
            .expect_err("forbidden method");
        assert_eq!(forbidden.code, "FORBIDDEN");

        let invalid = service
            .dispatch(
                json!({ "method": "reportPlaybackProgress", "args": [{ "taskId": "task-1", "percent": 95, "path": "C:\\secret" }] }),
                &["library.write".to_owned()],
            )
            .await
            .expect_err("unknown argument");
        assert_eq!(invalid.code, "INVALID_ARGUMENTS");
    }

    /// 验证下载结果不会向远程客户端泄漏哈希、关联标签和保存路径。
    #[tokio::test]
    async fn sanitizes_download_result() {
        let service = RemoteRpcService::new(std::sync::Arc::new(EchoHandler));
        let result = service
            .dispatch(
                json!({ "method": "listDownloads", "args": [] }),
                &["downloads.read".to_owned()],
            )
            .await
            .expect("dispatch downloads");
        let task = &result[0];
        assert!(task.get("torrentHash").is_none());
        assert!(task.get("correlationTag").is_none());
        assert_eq!(task["savePath"], HIDDEN_LOCAL_PATH);
    }
}
