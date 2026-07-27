use std::fs::{self, File};
use std::io::{self, BufReader, Read, Write};
use std::path::{Path, PathBuf};

use ani_contracts::AppCommandError;
use tauri::{AppHandle, State};
#[cfg(mobile)]
use tauri_plugin_ani_mobile::AniMobileExt;
use tauri_plugin_dialog::{DialogExt, FilePath};

use crate::storage::AppStorageState;

const MAX_EXPORTED_LOG_BYTES: u64 = 16 * 1024 * 1024;

/// 通过系统保存面板导出当前及轮转日志，不执行分析或上传。
#[tauri::command]
pub(crate) async fn export_logs(
    app: AppHandle,
    state: State<'_, AppStorageState>,
) -> Result<Option<String>, AppCommandError> {
    let file_name = format!(
        "ani-tracker-logs-{}.log",
        chrono::Utc::now().format("%Y%m%d-%H%M%S")
    );
    let dialog_app = app.clone();
    let dialog_file_name = file_name.clone();
    let selected = tauri::async_runtime::spawn_blocking(move || {
        dialog_app
            .dialog()
            .file()
            .set_title("导出 Ani Tracker 日志")
            .set_file_name(dialog_file_name)
            .add_filter("日志文件", &["log"])
            .blocking_save_file()
    })
    .await
    .map_err(|error| log_export_error("打开日志导出面板", error))?;
    let Some(selected) = selected else {
        return Ok(None);
    };

    log::info!("Tauri 日志导出开始 file={file_name}");
    let log_directory = state.log_directory().to_path_buf();
    let cache_directory = setting_path(state.platform_defaults(), "/storage/cacheDir")?;
    let export_name = file_name.clone();
    let export_file = tauri::async_runtime::spawn_blocking(move || {
        create_log_export(&log_directory, &cache_directory, &export_name)
    })
    .await
    .map_err(|error| log_export_error("汇总日志", error))?
    .map_err(|error| log_export_error("汇总日志", error))?;
    let export_guard = TemporaryLogExport(export_file.clone());

    write_selected_file(&app, selected, &export_file).await?;
    drop(export_guard);
    log::info!("Tauri 日志已导出 file={file_name}");
    Ok(Some(file_name))
}

/// 将日志目录中的文本日志按文件名顺序汇总到应用缓存。
fn create_log_export(
    log_directory: &Path,
    cache_directory: &Path,
    file_name: &str,
) -> Result<PathBuf, String> {
    let export_directory = cache_directory.join("log-exports");
    fs::create_dir_all(&export_directory)
        .map_err(|error| format!("创建日志导出缓存失败：{error}"))?;
    let target = export_directory.join(file_name);
    write_log_export(log_directory, &target)?;
    Ok(target)
}

/// 将全部 `.log` 文件合并为一个受大小限制的纯文本文件。
fn write_log_export(log_directory: &Path, target: &Path) -> Result<usize, String> {
    let mut logs = fs::read_dir(log_directory)
        .map_err(|error| format!("读取日志目录 {} 失败：{error}", log_directory.display()))?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.is_file() && path.extension().is_some_and(|value| value == "log"))
        .collect::<Vec<_>>();
    logs.sort();

    let mut output = File::create(target)
        .map_err(|error| format!("创建日志导出文件 {} 失败：{error}", target.display()))?;
    if logs.is_empty() {
        output
            .write_all("当前没有可导出的日志。\n".as_bytes())
            .map_err(|error| format!("写入空日志说明失败：{error}"))?;
        return Ok(0);
    }

    let mut remaining = MAX_EXPORTED_LOG_BYTES;
    let mut exported_count = 0usize;
    for path in logs {
        if remaining == 0 {
            break;
        }
        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("unknown.log");
        writeln!(output, "===== {name} =====")
            .map_err(|error| format!("写入日志文件头失败：{error}"))?;
        let input = File::open(&path)
            .map_err(|error| format!("读取日志文件 {} 失败：{error}", path.display()))?;
        let copied = io::copy(&mut BufReader::new(input).take(remaining), &mut output)
            .map_err(|error| format!("汇总日志文件 {} 失败：{error}", path.display()))?;
        remaining = remaining.saturating_sub(copied);
        output
            .write_all(b"\n\n")
            .map_err(|error| format!("写入日志分隔符失败：{error}"))?;
        exported_count += 1;
    }
    output
        .flush()
        .map_err(|error| format!("刷新日志导出文件失败：{error}"))?;
    Ok(exported_count)
}

/// 将汇总日志写入系统保存面板返回的路径或移动文档 URI。
async fn write_selected_file(
    _app: &AppHandle,
    selected: FilePath,
    source: &Path,
) -> Result<(), AppCommandError> {
    match selected {
        FilePath::Path(path) => {
            #[cfg(target_os = "ios")]
            {
                let url = url::Url::from_file_path(&path)
                    .map_err(|_| log_export_error("导出 iOS 日志", "路径无法转换为 file URL"))?;
                export_mobile_document(_app, url.as_str(), source)?;
            }
            #[cfg(not(target_os = "ios"))]
            copy_export(source, &path)?;
        }
        FilePath::Url(url) if url.scheme() == "file" => {
            #[cfg(target_os = "ios")]
            export_mobile_document(_app, url.as_str(), source)?;
            #[cfg(not(target_os = "ios"))]
            {
                let path = url
                    .to_file_path()
                    .map_err(|_| log_export_error("导出日志", "file URL 无法转换为本地路径"))?;
                copy_export(source, &path)?;
            }
        }
        #[cfg(target_os = "android")]
        FilePath::Url(url) if url.scheme() == "content" => {
            _app.ani_mobile()
                .export_document(url.as_str(), &source.to_string_lossy())
                .map_err(|error| log_export_error("写入 Android 系统文档", error))?;
        }
        FilePath::Url(url) => {
            return Err(log_export_error(
                "导出日志",
                format!("不支持的文档协议：{}", url.scheme()),
            ));
        }
    }
    Ok(())
}

/// 将日志复制到桌面系统选择的普通文件路径。
#[cfg(not(target_os = "ios"))]
fn copy_export(source: &Path, target: &Path) -> Result<(), AppCommandError> {
    fs::copy(source, target)
        .map(|_| ())
        .map_err(|error| log_export_error("写入日志文件", error))
}

/// 通过移动原生插件写入安全作用域文档。
#[cfg(target_os = "ios")]
fn export_mobile_document(
    app: &AppHandle,
    uri: &str,
    source: &Path,
) -> Result<(), AppCommandError> {
    app.ani_mobile()
        .export_document(uri, &source.to_string_lossy())
        .map_err(|error| log_export_error("写入 iOS 系统文档", error))
}

/// 从平台默认设置中读取宿主控制的绝对路径。
fn setting_path(settings: &serde_json::Value, pointer: &str) -> Result<PathBuf, AppCommandError> {
    settings
        .pointer(pointer)
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| log_export_error("读取日志目录", format!("设置缺少 {pointer}")))
}

/// 将日志导出错误转换为稳定命令错误。
fn log_export_error(action: &str, error: impl std::fmt::Display) -> AppCommandError {
    log::error!("Tauri 日志导出失败 action={action} error={error}");
    AppCommandError {
        code: "log_export_failed".to_owned(),
        message: format!("{action}失败：{error}"),
    }
}

/// 命令结束时清理应用缓存中的临时汇总日志。
struct TemporaryLogExport(PathBuf);

impl Drop for TemporaryLogExport {
    fn drop(&mut self) {
        if let Err(error) = fs::remove_file(&self.0) {
            if error.kind() != io::ErrorKind::NotFound {
                log::warn!(
                    "清理临时日志导出失败 path={} error={error}",
                    self.0.display()
                );
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::write_log_export;

    /// 多个轮转日志会合并到同一导出文件且保留文件边界。
    #[test]
    fn combines_rotated_logs_into_one_export() {
        let root = std::env::temp_dir().join(format!("ani-log-export-test-{}", std::process::id()));
        let logs = root.join("logs");
        let target = root.join("combined.log");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&logs).expect("create log directory");
        std::fs::write(logs.join("ani-tracker.log"), "current line\n").expect("write current log");
        std::fs::write(logs.join("ani-tracker_older.log"), "older line\n").expect("write old log");

        assert_eq!(write_log_export(&logs, &target).expect("export logs"), 2);
        let exported = std::fs::read_to_string(&target).expect("read export");
        assert!(exported.contains("===== ani-tracker.log ====="));
        assert!(exported.contains("current line"));
        assert!(exported.contains("older line"));
        std::fs::remove_dir_all(root).expect("remove test directory");
    }
}
