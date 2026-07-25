use ani_contracts::AppCommandError;
use ani_domain::{DownloadTask, Release};
use ani_downloads::{
    AddTorrentOptions, DownloadAddRequest, DownloadServiceError, DownloadTaskContext,
};
use serde::Deserialize;
use serde_json::Value;
use tauri::State;

use crate::downloads::{release_download_context, AppDownloadState};

/// 手动磁链或远程 torrent 添加输入。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AddDownloadUrlInput {
    url: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    save_path: Option<String>,
    #[serde(default)]
    paused: bool,
}

/// 从资源搜索结果添加任务的完整业务关联输入。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AddReleaseDownloadInput {
    release: Release,
    #[serde(default)]
    anime_id: Option<String>,
    #[serde(default)]
    episode_id: Option<String>,
    #[serde(default)]
    episode_no: Option<f64>,
    #[serde(default)]
    fansub_group_id: Option<String>,
    #[serde(default)]
    save_path: Option<String>,
    #[serde(default)]
    paused: bool,
}

/// 读取全部本地下载任务快照。
#[tauri::command]
pub(crate) async fn list_downloads(
    state: State<'_, AppDownloadState>,
) -> Result<Vec<DownloadTask>, AppCommandError> {
    state
        .service()
        .list()
        .map_err(|error| map_download_error("读取下载任务", error))
}

/// 刷新默认引擎及历史任务所属引擎。
#[tauri::command]
pub(crate) async fn refresh_downloads(
    state: State<'_, AppDownloadState>,
) -> Result<Vec<DownloadTask>, AppCommandError> {
    let settings = state
        .settings()
        .map_err(|error| runtime_error("刷新下载任务", error))?;
    let default_engine = state
        .default_engine(&settings)
        .map_err(|error| map_download_error("刷新下载任务", error))?;
    let result = state
        .service()
        .refresh(default_engine)
        .await
        .map_err(|error| map_download_error("刷新下载任务", error))?;
    for failure in result.failures {
        log::warn!(
            "Tauri 历史下载引擎刷新失败 engine={:?} error={}",
            failure.engine,
            failure.message
        );
    }
    Ok(result.tasks)
}

/// 暂停任务创建时所属的下载引擎。
#[tauri::command]
pub(crate) async fn pause_download(
    task_id: String,
    state: State<'_, AppDownloadState>,
) -> Result<Vec<DownloadTask>, AppCommandError> {
    state
        .service()
        .pause(&task_id)
        .await
        .map_err(|error| map_download_error("暂停下载任务", error))
}

/// 恢复任务创建时所属的下载引擎。
#[tauri::command]
pub(crate) async fn resume_download(
    task_id: String,
    state: State<'_, AppDownloadState>,
) -> Result<Vec<DownloadTask>, AppCommandError> {
    state
        .service()
        .resume(&task_id)
        .await
        .map_err(|error| map_download_error("恢复下载任务", error))
}

/// 从引擎和 SQLite 删除任务，并按请求决定是否删除文件。
#[tauri::command]
pub(crate) async fn remove_download(
    task_id: String,
    delete_files: bool,
    state: State<'_, AppDownloadState>,
) -> Result<Vec<DownloadTask>, AppCommandError> {
    state
        .service()
        .remove(&task_id, delete_files)
        .await
        .map_err(|error| map_download_error("删除下载任务", error))
}

/// 更新任务内一组文件的 libtorrent/qBittorrent 优先级。
#[tauri::command]
pub(crate) async fn set_download_file_priority(
    task_id: String,
    file_indexes: Vec<i64>,
    priority: i64,
    state: State<'_, AppDownloadState>,
) -> Result<Vec<DownloadTask>, AppCommandError> {
    state
        .service()
        .set_file_priority(&task_id, &file_indexes, priority)
        .await
        .map_err(|error| map_download_error("更新下载文件优先级", error))
}

/// 通过磁链或远程 torrent 文件添加手动任务。
#[tauri::command]
pub(crate) async fn add_download_url(
    input: AddDownloadUrlInput,
    state: State<'_, AppDownloadState>,
) -> Result<Vec<DownloadTask>, AppCommandError> {
    let settings = state
        .settings()
        .map_err(|error| runtime_error("添加下载任务", error))?;
    let engine = state
        .default_engine(&settings)
        .map_err(|error| map_download_error("添加下载任务", error))?;
    let prepared = state
        .prepare_source(&input.url, &settings)
        .await
        .map_err(|error| runtime_error("准备下载资源", error))?;
    state
        .service()
        .add(DownloadAddRequest {
            engine,
            source: prepared.source(),
            options: AddTorrentOptions {
                save_path: resolve_save_path(input.save_path.as_deref(), &settings)?,
                paused: input.paused,
                ..AddTorrentOptions::default()
            },
            context: DownloadTaskContext {
                name: input.name,
                ..DownloadTaskContext::default()
            },
        })
        .await
        .map_err(|error| map_download_error("添加下载任务", error))
}

/// 将已选择资源加入下载引擎并持久化番剧和单集关联。
#[tauri::command]
pub(crate) async fn add_release_download(
    input: AddReleaseDownloadInput,
    state: State<'_, AppDownloadState>,
) -> Result<Vec<DownloadTask>, AppCommandError> {
    let settings = state
        .settings()
        .map_err(|error| runtime_error("添加资源下载", error))?;
    let engine = state
        .default_engine(&settings)
        .map_err(|error| map_download_error("添加资源下载", error))?;
    let source_url = input
        .release
        .magnet_url
        .as_deref()
        .or(input.release.torrent_url.as_deref())
        .ok_or_else(|| AppCommandError {
            code: "invalid_input".to_owned(),
            message: "添加资源下载失败：资源没有磁链或 torrent 地址".to_owned(),
        })?;
    let prepared = state
        .prepare_source(source_url, &settings)
        .await
        .map_err(|error| runtime_error("准备资源下载", error))?;
    let anime_id = input.anime_id.or_else(|| input.release.anime_id.clone());
    let episode_no = input.episode_no.or(input.release.episode_no);
    let fansub_group_id = input
        .fansub_group_id
        .or_else(|| input.release.fansub_group_id.clone());
    let correlation_tag = build_correlation_tag(
        anime_id.as_deref(),
        input.episode_id.as_deref(),
        episode_no,
        &input.release.id,
    );
    let context = release_download_context(
        &input.release,
        anime_id,
        None,
        input.episode_id,
        episode_no,
        fansub_group_id,
    );
    state
        .service()
        .add(DownloadAddRequest {
            engine,
            source: prepared.source(),
            options: AddTorrentOptions {
                save_path: resolve_save_path(input.save_path.as_deref(), &settings)?,
                correlation_tag: Some(correlation_tag),
                paused: input.paused,
                ..AddTorrentOptions::default()
            },
            context,
        })
        .await
        .map_err(|error| map_download_error("添加资源下载", error))
}

/// 读取显式保存路径或回退到当前平台默认目录。
fn resolve_save_path(requested: Option<&str>, settings: &Value) -> Result<String, AppCommandError> {
    requested
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .or_else(|| {
            settings
                .pointer("/download/defaultDownloadDir")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
        })
        .map(str::to_owned)
        .ok_or_else(|| AppCommandError {
            code: "invalid_input".to_owned(),
            message: "添加下载任务失败：保存路径不能为空".to_owned(),
        })
}

/// 为首次占位任务与引擎真实哈希建立稳定弱关联。
fn build_correlation_tag(
    anime_id: Option<&str>,
    episode_id: Option<&str>,
    episode_no: Option<f64>,
    release_id: &str,
) -> String {
    format!(
        "ani:{}:{}:{}",
        anime_id.unwrap_or("manual"),
        episode_id
            .map(str::to_owned)
            .or_else(|| episode_no.map(|value| value.to_string()))
            .unwrap_or_else(|| "unknown".to_owned()),
        release_id
    )
}

/// 将下载服务错误映射为 Renderer 可处理的稳定命令错误。
fn map_download_error(action: &str, error: DownloadServiceError) -> AppCommandError {
    log::error!("Tauri 下载命令失败 action={action} error={error}");
    let code = match &error {
        DownloadServiceError::InvalidInput { .. } => "invalid_input",
        DownloadServiceError::TaskNotFound(_) => "record_not_found",
        DownloadServiceError::EngineNotRegistered(_) | DownloadServiceError::DuplicateEngine(_) => {
            "download_engine_unavailable"
        }
        DownloadServiceError::Engine { .. } => "download_engine_failed",
        DownloadServiceError::Repository(_) => "storage_operation_failed",
    };
    AppCommandError {
        code: code.to_owned(),
        message: format!("{action}失败：{error}"),
    }
}

fn runtime_error(action: &str, error: impl std::fmt::Display) -> AppCommandError {
    log::error!("Tauri 下载运行时失败 action={action} error={error}");
    AppCommandError {
        code: "download_runtime_failed".to_owned(),
        message: format!("{action}失败：{error}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 验证资源关联标签在相同输入下稳定。
    #[test]
    fn builds_stable_download_correlation_tag() {
        assert_eq!(
            build_correlation_tag(Some("anime-1"), None, Some(2.0), "release-1"),
            "ani:anime-1:2:release-1"
        );
    }
}
