use std::{fs, io, path::PathBuf};

use ani_contracts::AppCommandError;
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine};
use serde::Deserialize;
use tauri::{AppHandle, Manager, State};
#[cfg(mobile)]
use tauri_plugin_ani_mobile::AniMobileExt;
use tauri_plugin_dialog::{DialogExt, FilePath};

use crate::theme_assets::{
    validate_theme_id, AppThemeAssetState, SaveThemeBackgroundInput, ThemeBackgroundAsset,
    ThemeBackgroundReference,
};

const MAX_THEME_PACKAGE_BYTES: usize = 5 * 1024 * 1024;

/// Renderer 已完成校验和封装的主题导出文件。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExportThemePackageInput {
    file_name: String,
    content_type: String,
    data_base64: String,
}

/// 保存一张已由 Renderer 规范化的主题背景图片。
#[tauri::command]
pub(crate) async fn save_theme_background(
    input: SaveThemeBackgroundInput,
    state: State<'_, AppThemeAssetState>,
) -> Result<ThemeBackgroundAsset, AppCommandError> {
    state
        .save(input)
        .map_err(|error| theme_error("保存主题背景", error))
}

/// 解析主题 JSON 当前引用的本地背景图片。
#[tauri::command]
pub(crate) async fn resolve_theme_background(
    theme_id: String,
    file_name: String,
    state: State<'_, AppThemeAssetState>,
) -> Result<Option<ThemeBackgroundAsset>, AppCommandError> {
    state
        .resolve(&theme_id, &file_name)
        .map_err(|error| theme_error("读取主题背景", error))
}

/// 设置保存后清理所有未被主题 JSON 引用的图片。
#[tauri::command]
pub(crate) async fn prune_theme_backgrounds(
    references: Vec<ThemeBackgroundReference>,
    state: State<'_, AppThemeAssetState>,
) -> Result<(), AppCommandError> {
    state
        .prune(references)
        .map(|_| ())
        .map_err(|error| theme_error("清理主题背景", error))
}

/// 通过系统文件面板导出主题 JSON 或 ZIP，兼容移动文档 URI。
#[tauri::command]
pub(crate) async fn export_theme_package(
    app: AppHandle,
    input: ExportThemePackageInput,
) -> Result<Option<String>, AppCommandError> {
    let (theme_id, extension) = validate_export_file_name(&input.file_name)
        .map_err(|error| theme_error("校验主题导出文件", error))?;
    let expected_content_type = if extension == "zip" {
        "application/zip"
    } else {
        "application/json"
    };
    if input.content_type != expected_content_type {
        return Err(theme_error("校验主题导出文件", "扩展名与内容类型不一致"));
    }
    let bytes = BASE64_STANDARD
        .decode(input.data_base64.as_bytes())
        .map_err(|_| theme_error("解析主题导出文件", "Base64 数据无效"))?;
    validate_export_bytes(extension, &bytes)
        .map_err(|error| theme_error("校验主题导出文件", error))?;

    let dialog_app = app.clone();
    let dialog_file_name = input.file_name.clone();
    let selected = tauri::async_runtime::spawn_blocking(move || {
        let dialog = dialog_app
            .dialog()
            .file()
            .set_title("导出 Ani Tracker 主题")
            .set_file_name(dialog_file_name);
        if extension == "zip" {
            dialog.add_filter("Ani Tracker 主题 ZIP", &["zip"])
        } else {
            dialog.add_filter("Ani Tracker 主题 JSON", &["json"])
        }
        .blocking_save_file()
    })
    .await
    .map_err(|error| theme_error("打开主题导出面板", error))?;
    let Some(selected) = selected else {
        return Ok(None);
    };

    let export_directory = app
        .path()
        .app_cache_dir()
        .map_err(|error| theme_error("解析主题导出缓存", error))?
        .join("theme-exports");
    fs::create_dir_all(&export_directory)
        .map_err(|error| theme_error("创建主题导出缓存", error))?;
    let source = export_directory.join(&input.file_name);
    fs::write(&source, bytes).map_err(|error| theme_error("写入主题导出缓存", error))?;
    let source_guard = TemporaryThemeExport(source.clone());
    write_theme_export(&app, selected, &source)?;
    drop(source_guard);
    log::info!(
        "Tauri 主题包已导出 theme_id={} file={}",
        theme_id,
        input.file_name
    );
    Ok(Some(input.file_name))
}

/// 校验主题导出文件名并返回主题 ID 与扩展名。
fn validate_export_file_name(file_name: &str) -> Result<(String, &'static str), String> {
    let (theme_id, extension) = if let Some(theme_id) = file_name.strip_suffix(".ani-theme.zip") {
        (theme_id, "zip")
    } else if let Some(theme_id) = file_name.strip_suffix(".ani-theme.json") {
        (theme_id, "json")
    } else {
        return Err("主题文件名必须以 .ani-theme.json 或 .ani-theme.zip 结尾".to_owned());
    };
    validate_theme_id(theme_id)?;
    Ok((theme_id.to_owned(), extension))
}

/// 校验导出内容大小与文件签名，阻止任意二进制写入系统文档。
fn validate_export_bytes(extension: &str, bytes: &[u8]) -> Result<(), String> {
    if bytes.is_empty() || bytes.len() > MAX_THEME_PACKAGE_BYTES {
        return Err("主题导出文件为空或超过 5 MiB 限制".to_owned());
    }
    let valid = if extension == "zip" {
        bytes.starts_with(b"PK\x03\x04") || bytes.starts_with(b"PK\x05\x06")
    } else {
        bytes
            .iter()
            .copied()
            .find(|byte| !byte.is_ascii_whitespace())
            == Some(b'{')
    };
    if valid {
        Ok(())
    } else {
        Err("主题导出文件签名无效".to_owned())
    }
}

/// 将主题缓存写入普通路径或移动平台安全文档 URI。
fn write_theme_export(
    _app: &AppHandle,
    selected: FilePath,
    source: &std::path::Path,
) -> Result<(), AppCommandError> {
    match selected {
        FilePath::Path(path) => {
            #[cfg(target_os = "ios")]
            {
                let url = url::Url::from_file_path(&path)
                    .map_err(|_| theme_error("导出 iOS 主题", "路径无法转换为 file URL"))?;
                export_mobile_document(_app, url.as_str(), source)?;
            }
            #[cfg(not(target_os = "ios"))]
            fs::copy(source, path)
                .map(|_| ())
                .map_err(|error| theme_error("写入主题文件", error))?;
        }
        FilePath::Url(url) if url.scheme() == "file" => {
            #[cfg(target_os = "ios")]
            export_mobile_document(_app, url.as_str(), source)?;
            #[cfg(not(target_os = "ios"))]
            {
                let path = url
                    .to_file_path()
                    .map_err(|_| theme_error("导出主题", "file URL 无法转换为本地路径"))?;
                fs::copy(source, path)
                    .map(|_| ())
                    .map_err(|error| theme_error("写入主题文件", error))?;
            }
        }
        #[cfg(target_os = "android")]
        FilePath::Url(url) if url.scheme() == "content" => {
            _app.ani_mobile()
                .export_document(url.as_str(), &source.to_string_lossy())
                .map_err(|error| theme_error("写入 Android 系统文档", error))?;
        }
        FilePath::Url(url) => {
            return Err(theme_error(
                "导出主题",
                format!("不支持的文档协议：{}", url.scheme()),
            ));
        }
    }
    Ok(())
}

/// 通过 iOS 安全作用域文档写入主题文件。
#[cfg(target_os = "ios")]
fn export_mobile_document(
    app: &AppHandle,
    uri: &str,
    source: &std::path::Path,
) -> Result<(), AppCommandError> {
    app.ani_mobile()
        .export_document(uri, &source.to_string_lossy())
        .map_err(|error| theme_error("写入 iOS 系统文档", error))
}

/// 命令结束时删除应用缓存中的主题导出中间文件。
struct TemporaryThemeExport(PathBuf);

impl Drop for TemporaryThemeExport {
    fn drop(&mut self) {
        if let Err(error) = fs::remove_file(&self.0) {
            if error.kind() != io::ErrorKind::NotFound {
                log::warn!(
                    "清理主题导出缓存失败 path={} error={error}",
                    self.0.display()
                );
            }
        }
    }
}

fn theme_error(action: &str, error: impl std::fmt::Display) -> AppCommandError {
    log::error!("Tauri 主题资产命令失败 action={action} error={error}");
    AppCommandError {
        code: "theme_asset_failed".to_owned(),
        message: format!("{action}失败：{error}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_theme_export_name_and_signature() {
        assert_eq!(
            validate_export_file_name("custom-theme.ani-theme.zip").expect("valid file"),
            ("custom-theme".to_owned(), "zip")
        );
        assert!(validate_export_file_name("../custom-theme.ani-theme.zip").is_err());
        assert!(validate_export_bytes("zip", b"PK\x03\x04data").is_ok());
        assert!(validate_export_bytes("json", b" \n {\"schemaVersion\":2}").is_ok());
        assert!(validate_export_bytes("zip", b"not-a-zip").is_err());
    }
}
