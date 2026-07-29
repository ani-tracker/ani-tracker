use std::{
    collections::HashSet,
    fs, io,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine};
use serde::{Deserialize, Serialize};
use tauri::Manager;
use url::Url;

const THEME_PROTOCOL_NAME: &str = "ani-theme";
const MAX_THEME_BACKGROUND_BYTES: usize = 3 * 1024 * 1024;
static TEMP_FILE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// Renderer 提交的已规范化主题背景图片。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SaveThemeBackgroundInput {
    pub(crate) theme_id: String,
    pub(crate) file_name: String,
    pub(crate) content_type: String,
    pub(crate) data_base64: String,
}

/// 返回给 Renderer 的主题背景资产描述。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ThemeBackgroundAsset {
    pub(crate) theme_id: String,
    pub(crate) file_name: String,
    pub(crate) content_type: String,
    pub(crate) size: u64,
    pub(crate) url: String,
}

/// 设置中仍被引用的主题背景文件。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ThemeBackgroundReference {
    pub(crate) theme_id: String,
    pub(crate) file_name: String,
}

/// 管理应用私有目录中的主题背景图片。
pub(crate) struct AppThemeAssetState {
    directory: PathBuf,
}

impl AppThemeAssetState {
    /// 使用宿主已解析的应用数据目录装配主题资产服务。
    pub(crate) fn initialize(directory: PathBuf) -> Result<Self, String> {
        fs::create_dir_all(&directory)
            .map_err(|error| format!("创建主题资产目录 {} 失败：{error}", directory.display()))?;
        Ok(Self { directory })
    }

    /// 校验并原子写入一张已由 WebView 缩放压缩的背景图片。
    pub(crate) fn save(
        &self,
        input: SaveThemeBackgroundInput,
    ) -> Result<ThemeBackgroundAsset, String> {
        validate_theme_id(&input.theme_id)?;
        validate_background_file_name(&input.file_name)?;
        let expected_content_type = content_type_for_file(&input.file_name)?;
        if input.content_type != expected_content_type {
            return Err("背景图片扩展名与内容类型不一致".to_owned());
        }
        let bytes = BASE64_STANDARD
            .decode(input.data_base64.as_bytes())
            .map_err(|_| "背景图片 Base64 数据无效".to_owned())?;
        if bytes.is_empty() || bytes.len() > MAX_THEME_BACKGROUND_BYTES {
            return Err("背景图片为空或超过 3 MiB 限制".to_owned());
        }
        if !matches_image_signature(expected_content_type, &bytes) {
            return Err("背景图片内容与声明格式不一致".to_owned());
        }

        let theme_directory = self.directory.join(&input.theme_id);
        fs::create_dir_all(&theme_directory)
            .map_err(|error| format!("创建主题背景目录失败：{error}"))?;
        let target = theme_directory.join(&input.file_name);
        if target.is_file() {
            let existing =
                fs::read(&target).map_err(|error| format!("读取已有主题背景失败：{error}"))?;
            if existing == bytes {
                log::info!(
                    "Tauri 主题背景已存在 theme_id={} file={} size={}",
                    input.theme_id,
                    input.file_name,
                    bytes.len()
                );
                return self.describe(&input.theme_id, &input.file_name);
            }
            return Err("同名主题背景内容不一致，请重新选择图片".to_owned());
        }
        let temporary = theme_directory.join(format!(
            ".{}.{}.tmp",
            input.file_name,
            TEMP_FILE_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::write(&temporary, &bytes)
            .map_err(|error| format!("写入主题背景临时文件失败：{error}"))?;
        if let Err(error) = fs::rename(&temporary, &target) {
            let _ = fs::remove_file(&temporary);
            return Err(format!("提交主题背景文件失败：{error}"));
        }
        log::info!(
            "Tauri 主题背景已保存 theme_id={} file={} size={}",
            input.theme_id,
            input.file_name,
            bytes.len()
        );
        self.describe(&input.theme_id, &input.file_name)
    }

    /// 返回主题 JSON 引用的背景文件；文件缺失时稳定返回空。
    pub(crate) fn resolve(
        &self,
        theme_id: &str,
        file_name: &str,
    ) -> Result<Option<ThemeBackgroundAsset>, String> {
        validate_theme_id(theme_id)?;
        validate_background_file_name(file_name)?;
        let path = self.directory.join(theme_id).join(file_name);
        if !path.is_file() {
            return Ok(None);
        }
        self.describe(theme_id, file_name).map(Some)
    }

    /// 删除设置中已不再引用的背景文件，并保留仍在使用的文件。
    pub(crate) fn prune(&self, references: Vec<ThemeBackgroundReference>) -> Result<usize, String> {
        let mut active = HashSet::new();
        for reference in references {
            validate_theme_id(&reference.theme_id)?;
            validate_background_file_name(&reference.file_name)?;
            active.insert((reference.theme_id, reference.file_name));
        }

        let mut removed = 0usize;
        for directory_entry in read_directory(&self.directory)? {
            let theme_directory = directory_entry.path();
            let Some(theme_id) = directory_entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            if !theme_directory.is_dir() || validate_theme_id(&theme_id).is_err() {
                continue;
            }
            for asset_entry in read_directory(&theme_directory)? {
                let asset_path = asset_entry.path();
                let Some(file_name) = asset_entry.file_name().to_str().map(str::to_owned) else {
                    continue;
                };
                if !asset_path.is_file() || validate_background_file_name(&file_name).is_err() {
                    continue;
                }
                if !active.contains(&(theme_id.clone(), file_name)) {
                    fs::remove_file(&asset_path).map_err(|error| {
                        format!("清理主题背景 {} 失败：{error}", asset_path.display())
                    })?;
                    removed += 1;
                }
            }
            if fs::read_dir(&theme_directory)
                .map(|mut entries| entries.next().is_none())
                .unwrap_or(false)
            {
                let _ = fs::remove_dir(&theme_directory);
            }
        }
        if removed > 0 {
            log::info!("Tauri 未引用主题背景已清理 count={removed}");
        }
        Ok(removed)
    }

    /// 读取资产元信息并生成跨平台受控协议地址。
    fn describe(&self, theme_id: &str, file_name: &str) -> Result<ThemeBackgroundAsset, String> {
        let path = self.directory.join(theme_id).join(file_name);
        let metadata = fs::metadata(&path)
            .map_err(|error| format!("读取主题背景 {} 失败：{error}", path.display()))?;
        Ok(ThemeBackgroundAsset {
            theme_id: theme_id.to_owned(),
            file_name: file_name.to_owned(),
            content_type: content_type_for_file(file_name)?.to_owned(),
            size: metadata.len(),
            url: resolve_theme_background_url(theme_id, file_name, metadata.len())?,
        })
    }

    fn asset_path(&self, theme_id: &str, file_name: &str) -> Result<PathBuf, String> {
        validate_theme_id(theme_id)?;
        validate_background_file_name(file_name)?;
        Ok(self.directory.join(theme_id).join(file_name))
    }
}

/// 处理桌面和移动 WebView 发起的主题背景读取请求。
pub(crate) fn handle_protocol_request(
    context: tauri::UriSchemeContext<'_, tauri::Wry>,
    request: tauri::http::Request<Vec<u8>>,
    responder: tauri::UriSchemeResponder,
) {
    use tauri::http::{header, Method, Response, StatusCode};

    let app = context.app_handle().clone();
    let method = request.method().clone();
    let request_url = request.uri().to_string();
    tauri::async_runtime::spawn(async move {
        let result = async {
            if method != Method::GET && method != Method::HEAD {
                return Err((
                    StatusCode::METHOD_NOT_ALLOWED,
                    "主题协议只支持读取".to_owned(),
                ));
            }
            let (theme_id, file_name) = parse_theme_background_url(&request_url)
                .map_err(|error| (StatusCode::BAD_REQUEST, error))?;
            let state = app.try_state::<AppThemeAssetState>().ok_or_else(|| {
                (
                    StatusCode::SERVICE_UNAVAILABLE,
                    "主题资产状态未装配".to_owned(),
                )
            })?;
            let path = state
                .asset_path(&theme_id, &file_name)
                .map_err(|error| (StatusCode::BAD_REQUEST, error))?;
            let bytes = tokio::fs::read(&path)
                .await
                .map_err(|_| (StatusCode::NOT_FOUND, "主题背景不存在".to_owned()))?;
            let content_type = content_type_for_file(&file_name)
                .map_err(|error| (StatusCode::BAD_REQUEST, error))?;
            if !matches_image_signature(content_type, &bytes) {
                return Err((
                    StatusCode::UNSUPPORTED_MEDIA_TYPE,
                    "主题背景格式无效".to_owned(),
                ));
            }
            Ok((content_type, bytes))
        }
        .await;

        let response = match result {
            Ok((content_type, bytes)) => Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, content_type)
                .header(header::CONTENT_LENGTH, bytes.len())
                .header(
                    header::CACHE_CONTROL,
                    "private, max-age=31536000, immutable",
                )
                .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
                .body(if method == Method::HEAD {
                    Vec::new()
                } else {
                    bytes
                }),
            Err((status, error)) => {
                log::warn!("Tauri 主题背景协议请求失败 url={request_url} error={error}");
                Response::builder()
                    .status(status)
                    .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
                    .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                    .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
                    .body(error.into_bytes())
            }
        }
        .unwrap_or_else(|error| {
            log::error!("Tauri 主题背景协议响应构建失败 error={error}");
            Response::builder()
                .status(StatusCode::INTERNAL_SERVER_ERROR)
                .body(Vec::new())
                .expect("静态主题背景错误响应必须有效")
        });
        responder.respond(response);
    });
}

fn resolve_theme_background_url(
    theme_id: &str,
    file_name: &str,
    revision: u64,
) -> Result<String, String> {
    #[cfg(any(target_os = "windows", target_os = "android"))]
    let base_url = format!("http://{THEME_PROTOCOL_NAME}.localhost/background");
    #[cfg(not(any(target_os = "windows", target_os = "android")))]
    let base_url = format!("{THEME_PROTOCOL_NAME}://localhost/background");
    let mut url = Url::parse(&base_url).map_err(|_| "主题背景协议地址无效".to_owned())?;
    url.query_pairs_mut()
        .append_pair("themeId", theme_id)
        .append_pair("file", file_name)
        .append_pair("revision", &revision.to_string());
    Ok(url.to_string())
}

fn parse_theme_background_url(request_url: &str) -> Result<(String, String), String> {
    let url = Url::parse(request_url).map_err(|_| "主题背景请求地址无效".to_owned())?;
    let parameters = url
        .query_pairs()
        .collect::<std::collections::HashMap<_, _>>();
    let theme_id = parameters
        .get("themeId")
        .map(|value| value.as_ref().to_owned())
        .ok_or_else(|| "主题背景请求缺少 themeId".to_owned())?;
    let file_name = parameters
        .get("file")
        .map(|value| value.as_ref().to_owned())
        .ok_or_else(|| "主题背景请求缺少 file".to_owned())?;
    validate_theme_id(&theme_id)?;
    validate_background_file_name(&file_name)?;
    Ok((theme_id, file_name))
}

pub(crate) fn validate_theme_id(value: &str) -> Result<(), String> {
    if (2..=64).contains(&value.len())
        && value
            .bytes()
            .next()
            .is_some_and(|byte| byte.is_ascii_alphanumeric())
        && value
            .bytes()
            .last()
            .is_some_and(|byte| byte.is_ascii_alphanumeric())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    {
        return Ok(());
    }
    Err("主题 ID 格式无效".to_owned())
}

fn validate_background_file_name(value: &str) -> Result<(), String> {
    let Some((stem, extension)) = value.rsplit_once('.') else {
        return Err("主题背景文件名无效".to_owned());
    };
    let valid_stem = stem == "background"
        || stem.strip_prefix("background-").is_some_and(|suffix| {
            (8..=32).contains(&suffix.len())
                && suffix
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        });
    if valid_stem && matches!(extension, "jpg" | "png" | "webp") {
        Ok(())
    } else {
        Err("主题背景文件名无效".to_owned())
    }
}

fn content_type_for_file(file_name: &str) -> Result<&'static str, String> {
    match Path::new(file_name)
        .extension()
        .and_then(|value| value.to_str())
    {
        Some("jpg") => Ok("image/jpeg"),
        Some("png") => Ok("image/png"),
        Some("webp") => Ok("image/webp"),
        _ => Err("主题背景格式仅支持 JPEG、PNG 或 WebP".to_owned()),
    }
}

fn matches_image_signature(content_type: &str, bytes: &[u8]) -> bool {
    match content_type {
        "image/jpeg" => bytes.starts_with(&[0xff, 0xd8, 0xff]),
        "image/png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "image/webp" => bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP",
        _ => false,
    }
}

fn read_directory(path: &Path) -> Result<Vec<fs::DirEntry>, String> {
    match fs::read_dir(path) {
        Ok(entries) => entries
            .collect::<Result<Vec<_>, io::Error>>()
            .map_err(|error| format!("读取主题资产目录 {} 失败：{error}", path.display())),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) => Err(format!("读取主题资产目录 {} 失败：{error}", path.display())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn protocol_url_round_trips_safe_theme_asset() {
        let url = resolve_theme_background_url("custom-theme", "background-a1b2c3d4.webp", 12)
            .expect("theme URL");
        assert_eq!(
            parse_theme_background_url(&url).expect("parsed URL"),
            (
                "custom-theme".to_owned(),
                "background-a1b2c3d4.webp".to_owned()
            )
        );
    }

    #[test]
    fn asset_names_reject_directory_traversal() {
        assert!(validate_theme_id("../theme").is_err());
        assert!(validate_background_file_name("../background.webp").is_err());
        assert!(validate_background_file_name("background.svg").is_err());
    }

    #[test]
    fn repeated_save_is_idempotent_and_prune_keeps_references() {
        let root = std::env::temp_dir().join(format!(
            "ani-theme-assets-test-{}-{}",
            std::process::id(),
            TEMP_FILE_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&root);
        let state = AppThemeAssetState::initialize(root.clone()).expect("initialize assets");
        let create_input = || SaveThemeBackgroundInput {
            theme_id: "custom-theme".to_owned(),
            file_name: "background-a1b2c3d4.jpg".to_owned(),
            content_type: "image/jpeg".to_owned(),
            data_base64: BASE64_STANDARD.encode([0xff, 0xd8, 0xff, 0x00]),
        };

        state.save(create_input()).expect("first save");
        state.save(create_input()).expect("idempotent save");
        assert_eq!(
            state
                .prune(vec![ThemeBackgroundReference {
                    theme_id: "custom-theme".to_owned(),
                    file_name: "background-a1b2c3d4.jpg".to_owned(),
                }])
                .expect("prune referenced assets"),
            0
        );
        assert!(root
            .join("custom-theme")
            .join("background-a1b2c3d4.jpg")
            .is_file());
        assert_eq!(state.prune(Vec::new()).expect("prune all assets"), 1);
        assert!(!root.join("custom-theme").exists());
        fs::remove_dir_all(root).ok();
    }
}
