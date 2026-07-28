#[cfg(mobile)]
use std::path::PathBuf;

#[cfg(mobile)]
use ani_domain::AppSettings;
#[cfg(mobile)]
use ani_image_cache::{ImageCache, ImageCacheAsset};
#[cfg(mobile)]
use tauri::{AppHandle, Manager};
use url::Url;

const IMAGE_PROTOCOL_NAME: &str = "ani-image";

/// 移动宿主持有的应用图片缓存，不引入桌面远程网关。
#[cfg(mobile)]
pub(crate) struct AppImageCacheState {
    cache: ImageCache,
}

#[cfg(mobile)]
impl AppImageCacheState {
    /// 按当前应用缓存目录初始化移动图片缓存。
    pub(crate) fn initialize(settings: &AppSettings) -> Result<Self, String> {
        let cache = ImageCache::new_local(image_cache_directory(settings)?)?;
        Ok(Self { cache })
    }

    /// 设置保存后切换后续图片使用的缓存目录。
    pub(crate) async fn apply_settings(&self, settings: &AppSettings) -> Result<(), String> {
        self.cache
            .set_cache_directory(image_cache_directory(settings)?)
            .await;
        Ok(())
    }

    /// 命中缓存或安全下载指定公网图片。
    pub(crate) async fn load_image_asset(
        &self,
        source_url: &str,
    ) -> Result<ImageCacheAsset, String> {
        self.cache
            .get(source_url)
            .await
            .map_err(|error| error.to_string())
    }

    /// 删除 WebView 解码失败对应的缓存记录。
    pub(crate) async fn invalidate(&self, source_url: &str) -> Result<(), String> {
        self.cache
            .invalidate(source_url)
            .await
            .map_err(|error| error.to_string())
    }
}

/// 设置更新后同步移动图片缓存目录。
#[cfg(mobile)]
pub(crate) async fn apply_settings(app: &AppHandle, settings: &AppSettings) {
    let Some(state) = app.try_state::<AppImageCacheState>() else {
        log::error!("Tauri 移动图片缓存状态未装配");
        return;
    };
    if let Err(error) = state.apply_settings(settings).await {
        log::error!("Tauri 移动图片缓存目录更新失败 error={error}");
    }
}

/// 读取设置中的应用图片缓存目录。
#[cfg(mobile)]
fn image_cache_directory(settings: &AppSettings) -> Result<PathBuf, String> {
    settings
        .pointer("/storage/cacheDir")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .map(|path| path.join("images"))
        .ok_or_else(|| "图片缓存目录未配置".to_owned())
}

/// 校验公网图片地址，并移除不会影响资源内容的片段。
fn normalize_public_image_url(source_url: &str) -> Result<String, String> {
    let mut url = Url::parse(source_url.trim()).map_err(|_| "图片地址无效".to_owned())?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("图片地址只支持公开 HTTP 或 HTTPS URL".to_owned());
    }
    if url.port().is_some_and(|port| {
        !((url.scheme() == "http" && port == 80) || (url.scheme() == "https" && port == 443))
    }) {
        return Err("图片地址端口不受支持".to_owned());
    }
    url.set_fragment(None);
    Ok(url.to_string())
}

/// 为 Renderer 生成不依赖公网直连的本地图片协议地址。
pub(crate) fn resolve_local_image_url(source_url: &str) -> Result<String, String> {
    let source_url = normalize_public_image_url(source_url)?;
    #[cfg(any(target_os = "windows", target_os = "android"))]
    let base_url = format!("http://{IMAGE_PROTOCOL_NAME}.localhost/image");
    #[cfg(not(any(target_os = "windows", target_os = "android")))]
    let base_url = format!("{IMAGE_PROTOCOL_NAME}://localhost/image");

    let mut url = Url::parse(&base_url).map_err(|_| "本地图片协议地址无效".to_owned())?;
    url.query_pairs_mut().append_pair("url", &source_url);
    Ok(url.to_string())
}

/// 从本地图片协议请求中提取并校验原始公网地址。
fn parse_protocol_source_url(request_url: &str) -> Result<String, String> {
    let url = Url::parse(request_url).map_err(|_| "本地图片请求地址无效".to_owned())?;
    let source_url = url
        .query_pairs()
        .find_map(|(key, value)| (key == "url").then(|| value.into_owned()))
        .ok_or_else(|| "本地图片请求缺少 url 参数".to_owned())?;
    normalize_public_image_url(&source_url)
}

/// 处理桌面和移动 WebView 发起的本地图片协议请求。
pub(crate) fn handle_protocol_request(
    context: tauri::UriSchemeContext<'_, tauri::Wry>,
    request: tauri::http::Request<Vec<u8>>,
    responder: tauri::UriSchemeResponder,
) {
    use tauri::http::{header, Method, Response, StatusCode};
    use tauri::Manager;

    let app = context.app_handle().clone();
    let method = request.method().clone();
    let request_url = request.uri().to_string();
    tauri::async_runtime::spawn(async move {
        let response = async {
            if method != Method::GET && method != Method::HEAD {
                return Err((
                    StatusCode::METHOD_NOT_ALLOWED,
                    "本地图片协议只支持读取".to_owned(),
                ));
            }
            let source_url = parse_protocol_source_url(&request_url)
                .map_err(|error| (StatusCode::BAD_REQUEST, error))?;
            #[cfg(desktop)]
            let asset = app
                .try_state::<crate::remote::AppRemoteGatewayState>()
                .ok_or_else(|| {
                    (
                        StatusCode::SERVICE_UNAVAILABLE,
                        "图片缓存状态未完成装配".to_owned(),
                    )
                })?
                .load_image_asset(&source_url)
                .await
                .map_err(|error| (StatusCode::BAD_GATEWAY, error))?;
            #[cfg(mobile)]
            let asset = app
                .try_state::<AppImageCacheState>()
                .ok_or_else(|| {
                    (
                        StatusCode::SERVICE_UNAVAILABLE,
                        "移动图片缓存状态未完成装配".to_owned(),
                    )
                })?
                .load_image_asset(&source_url)
                .await
                .map_err(|error| (StatusCode::BAD_GATEWAY, error))?;
            let bytes = tokio::fs::read(&asset.file_path).await.map_err(|error| {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("读取图片缓存文件失败：{error}"),
                )
            })?;
            Ok((asset.content_type, asset.size, bytes))
        }
        .await;

        let response = match response {
            Ok((content_type, size, bytes)) => Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, content_type)
                .header(header::CONTENT_LENGTH, size)
                .header(header::CACHE_CONTROL, "public, max-age=86400")
                .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
                .body(if method == Method::HEAD {
                    Vec::new()
                } else {
                    bytes
                }),
            Err((status, error)) => {
                log::warn!("Tauri 本地图片协议请求失败 url={request_url} error={error}");
                Response::builder()
                    .status(status)
                    .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
                    .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                    .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
                    .body(error.into_bytes())
            }
        }
        .unwrap_or_else(|error| {
            log::error!("Tauri 本地图片协议响应构建失败 error={error}");
            Response::builder()
                .status(StatusCode::INTERNAL_SERVER_ERROR)
                .body(Vec::new())
                .expect("静态图片错误响应必须有效")
        });
        responder.respond(response);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn public_image_url_rejects_unsupported_sources() {
        assert!(normalize_public_image_url("file:///tmp/cover.jpg").is_err());
        assert!(normalize_public_image_url("https://user@example.com/cover.jpg").is_err());
        assert!(normalize_public_image_url("https://example.com:8443/cover.jpg").is_err());
    }

    #[test]
    fn local_protocol_url_round_trips_unicode_and_query_values() {
        let source_url = "https://example.com/海报 image.jpg?size=large&crop=1#ignored";
        let protocol_url = resolve_local_image_url(source_url).expect("protocol URL");
        assert_eq!(
            parse_protocol_source_url(&protocol_url).expect("source URL"),
            "https://example.com/%E6%B5%B7%E6%8A%A5%20image.jpg?size=large&crop=1"
        );
    }
}
