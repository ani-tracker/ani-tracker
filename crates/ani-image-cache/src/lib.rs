//! 跨桌面与移动宿主复用的持久图片缓存。

use std::collections::HashMap;
use std::net::{IpAddr, Ipv6Addr};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use chrono::Utc;
use hmac::{Hmac, Mac};
use reqwest::redirect::Policy;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::AsyncReadExt;
use tokio::sync::{Mutex, RwLock};
use url::{Host, Url};

const DEFAULT_MAX_BYTES: u64 = 5 * 1024 * 1024 * 1024;
const DEFAULT_MAX_IMAGE_BYTES: u64 = 20 * 1024 * 1024;
const TOKEN_LIFETIME: Duration = Duration::from_secs(7 * 24 * 60 * 60);
const REMOTE_PATH_PRUNE_THRESHOLD: usize = 4_096;
const MAX_REDIRECTS: usize = 3;

type HmacSha256 = Hmac<Sha256>;

/// 持久图片缓存返回的受控磁盘资源。
#[derive(Debug, Clone)]
pub struct ImageCacheAsset {
    pub cache_key: String,
    pub file_path: PathBuf,
    pub content_type: String,
    pub size: u64,
}

/// 图片缓存对远程协议暴露的稳定错误。
#[derive(Debug, thiserror::Error)]
#[error("{message}")]
pub struct ImageCacheError {
    pub code: &'static str,
    pub message: String,
}

impl ImageCacheError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    /// 返回适合网关响应的 HTTP 状态码。
    pub fn status(&self) -> u16 {
        match self.code {
            "IMAGE_TOKEN_INVALID" | "IMAGE_TOKEN_EXPIRED" => 404,
            "IMAGE_FETCH_FAILED" | "IMAGE_REDIRECT_INVALID" => 502,
            _ => 400,
        }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ImageTokenPayload {
    source_url: String,
    expires_at: u64,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ImageCacheMetadata {
    version: u8,
    cache_key: String,
    file_name: String,
    content_type: String,
    size: u64,
    created_at: String,
}

#[derive(Debug, Clone)]
struct RemoteImagePath {
    path: String,
    expires_at: u64,
}

/// 下载公网图片到共享磁盘缓存，并签发短期防篡改同源 URL。
pub struct ImageCache {
    cache_directory: RwLock<PathBuf>,
    signing_secret: Vec<u8>,
    http_client: reqwest::Client,
    max_bytes: u64,
    max_image_bytes: u64,
    key_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    remote_paths: StdMutex<HashMap<String, RemoteImagePath>>,
}

impl ImageCache {
    /// 使用至少 32 字节的平台安全随机密钥创建图片缓存。
    pub fn new(cache_directory: PathBuf, signing_secret: Vec<u8>) -> Result<Self, String> {
        if signing_secret.len() < 32 {
            return Err("图片缓存签名密钥至少需要 32 字节".to_owned());
        }
        let http_client = reqwest::Client::builder()
            .redirect(Policy::none())
            .build()
            .map_err(|error| format!("图片缓存网络客户端创建失败：{error}"))?;
        Ok(Self {
            cache_directory: RwLock::new(cache_directory),
            signing_secret,
            http_client,
            max_bytes: DEFAULT_MAX_BYTES,
            max_image_bytes: DEFAULT_MAX_IMAGE_BYTES,
            key_locks: Mutex::new(HashMap::new()),
            remote_paths: StdMutex::new(HashMap::new()),
        })
    }

    /// 创建只供本地协议使用的缓存，签名密钥仅在当前进程内随机生成。
    pub fn new_local(cache_directory: PathBuf) -> Result<Self, String> {
        let mut signing_secret = Vec::with_capacity(32);
        signing_secret.extend_from_slice(uuid::Uuid::new_v4().as_bytes());
        signing_secret.extend_from_slice(uuid::Uuid::new_v4().as_bytes());
        Self::new(cache_directory, signing_secret)
    }

    /// 设置变更后切换后续请求使用的缓存目录。
    pub async fn set_cache_directory(&self, directory: PathBuf) {
        *self.cache_directory.write().await = directory;
    }

    /// 为公开 HTTP(S) 图片复用或创建七天有效的同源缓存路径。
    pub fn create_remote_path(&self, source_url: &str) -> Result<String, ImageCacheError> {
        self.create_remote_path_at(source_url, now_millis())
    }

    /// 在指定时间复用未过期路径，供签名逻辑和边界测试共用。
    fn create_remote_path_at(
        &self,
        source_url: &str,
        now_millis: u64,
    ) -> Result<String, ImageCacheError> {
        let source_url = normalize_source_url(source_url)?;
        let cache_key = hex_digest(Sha256::digest(source_url.as_bytes()));
        let mut remote_paths = self
            .remote_paths
            .lock()
            .map_err(|_| ImageCacheError::new("IMAGE_TOKEN_INVALID", "图片签名缓存暂时不可用"))?;
        if let Some(record) = remote_paths.get(&cache_key) {
            if record.expires_at >= now_millis {
                log::debug!(
                    "图片签名路径复用 cache_key={cache_key}, expires_at={}",
                    record.expires_at
                );
                return Ok(record.path.clone());
            }
            remote_paths.remove(&cache_key);
        }
        let payload = ImageTokenPayload {
            source_url,
            expires_at: now_millis
                .saturating_add(TOKEN_LIFETIME.as_millis().try_into().unwrap_or(u64::MAX)),
        };
        let expires_at = payload.expires_at;
        let payload = URL_SAFE_NO_PAD.encode(
            serde_json::to_vec(&payload)
                .map_err(|_| ImageCacheError::new("IMAGE_TOKEN_INVALID", "图片地址无效"))?,
        );
        let signature = self.sign(payload.as_bytes());
        let path = format!(
            "/api/images/{payload}.{}",
            URL_SAFE_NO_PAD.encode(signature)
        );
        if remote_paths.len() >= REMOTE_PATH_PRUNE_THRESHOLD {
            remote_paths.retain(|_, record| record.expires_at >= now_millis);
        }
        log::debug!("图片签名路径已签发 cache_key={cache_key}, expires_at={expires_at}");
        remote_paths.insert(
            cache_key,
            RemoteImagePath {
                path: path.clone(),
                expires_at,
            },
        );
        Ok(path)
    }

    /// 校验签名令牌，命中磁盘缓存或安全下载图片。
    pub async fn get_by_token(&self, token: &str) -> Result<ImageCacheAsset, ImageCacheError> {
        let source_url = self.read_token(token)?;
        self.get(&source_url).await
    }

    /// 合并同一 URL 的并发下载，并返回完整缓存资源。
    pub async fn get(&self, source_url: &str) -> Result<ImageCacheAsset, ImageCacheError> {
        let source_url = normalize_source_url(source_url)?;
        let cache_key = hex_digest(Sha256::digest(source_url.as_bytes()));
        if let Some(asset) = self.read_cached(&cache_key).await {
            return Ok(asset);
        }
        let key_lock = {
            let mut locks = self.key_locks.lock().await;
            Arc::clone(
                locks
                    .entry(cache_key.clone())
                    .or_insert_with(|| Arc::new(Mutex::new(()))),
            )
        };
        let _guard = key_lock.lock().await;
        if let Some(asset) = self.read_cached(&cache_key).await {
            return Ok(asset);
        }
        let result = self.download_and_store(&source_url, &cache_key).await;
        self.key_locks.lock().await.remove(&cache_key);
        result
    }

    /// 主动失效指定公网地址的缓存文件，供 WebView 解码失败后重试。
    pub async fn invalidate(&self, source_url: &str) -> Result<(), ImageCacheError> {
        let source_url = normalize_source_url(source_url)?;
        let cache_key = hex_digest(Sha256::digest(source_url.as_bytes()));
        let directory = self.cache_directory.read().await.clone();
        self.remove_cache_entry(&directory, &cache_key).await;
        log_cache_invalidation(&cache_key);
        Ok(())
    }

    fn read_token(&self, token: &str) -> Result<String, ImageCacheError> {
        if token.is_empty() || token.len() > 4_096 {
            return Err(ImageCacheError::new("IMAGE_TOKEN_INVALID", "图片地址无效"));
        }
        let mut parts = token.split('.');
        let (Some(payload), Some(signature), None) = (parts.next(), parts.next(), parts.next())
        else {
            return Err(ImageCacheError::new("IMAGE_TOKEN_INVALID", "图片地址无效"));
        };
        let signature = URL_SAFE_NO_PAD
            .decode(signature)
            .map_err(|_| ImageCacheError::new("IMAGE_TOKEN_INVALID", "图片地址无效"))?;
        let mut verifier = HmacSha256::new_from_slice(&self.signing_secret)
            .map_err(|_| ImageCacheError::new("IMAGE_TOKEN_INVALID", "图片地址无效"))?;
        verifier.update(payload.as_bytes());
        verifier
            .verify_slice(&signature)
            .map_err(|_| ImageCacheError::new("IMAGE_TOKEN_INVALID", "图片地址无效"))?;
        let payload: ImageTokenPayload = serde_json::from_slice(
            &URL_SAFE_NO_PAD
                .decode(payload)
                .map_err(|_| ImageCacheError::new("IMAGE_TOKEN_INVALID", "图片地址无效"))?,
        )
        .map_err(|_| ImageCacheError::new("IMAGE_TOKEN_INVALID", "图片地址无效"))?;
        if payload.expires_at < now_millis() {
            return Err(ImageCacheError::new(
                "IMAGE_TOKEN_EXPIRED",
                "图片地址已过期",
            ));
        }
        normalize_source_url(&payload.source_url)
    }

    fn sign(&self, value: &[u8]) -> Vec<u8> {
        let mut hmac = HmacSha256::new_from_slice(&self.signing_secret)
            .expect("HMAC accepts arbitrary key lengths");
        hmac.update(value);
        hmac.finalize().into_bytes().to_vec()
    }

    async fn read_cached(&self, cache_key: &str) -> Option<ImageCacheAsset> {
        let directory = self.cache_directory.read().await.clone();
        let metadata_path = directory.join(format!("{cache_key}.json"));
        let metadata_bytes = tokio::fs::read(&metadata_path).await.ok()?;
        let metadata: ImageCacheMetadata = match serde_json::from_slice(&metadata_bytes) {
            Ok(metadata) => metadata,
            Err(_) => {
                self.remove_cache_entry(&directory, cache_key).await;
                return None;
            }
        };
        if metadata.version != 1
            || metadata.cache_key != cache_key
            || !is_cache_file_name(&metadata.file_name, cache_key)
            || !image_extension(&metadata.content_type).is_some()
            || metadata.size == 0
        {
            self.remove_cache_entry(&directory, cache_key).await;
            return None;
        }
        let file_path = directory.join(&metadata.file_name);
        let file = tokio::fs::metadata(&file_path).await.ok()?;
        if !file.is_file() || file.len() != metadata.size {
            self.remove_cache_entry(&directory, cache_key).await;
            return None;
        }
        let mut header = [0_u8; 32];
        let mut cached_file = match tokio::fs::File::open(&file_path).await {
            Ok(file) => file,
            Err(_) => {
                self.remove_cache_entry(&directory, cache_key).await;
                return None;
            }
        };
        let header_length = match cached_file.read(&mut header).await {
            Ok(length) => length,
            Err(_) => {
                self.remove_cache_entry(&directory, cache_key).await;
                return None;
            }
        };
        if !matches_image_signature(&metadata.content_type, &header[..header_length]) {
            self.remove_cache_entry(&directory, cache_key).await;
            return None;
        }
        Some(ImageCacheAsset {
            cache_key: cache_key.to_owned(),
            file_path,
            content_type: metadata.content_type,
            size: metadata.size,
        })
    }

    async fn download_and_store(
        &self,
        source_url: &str,
        cache_key: &str,
    ) -> Result<ImageCacheAsset, ImageCacheError> {
        let mut current_url = source_url.to_owned();
        let mut redirect_count = 0_usize;
        let response = loop {
            let url = Url::parse(&current_url)
                .map_err(|_| ImageCacheError::new("IMAGE_URL_INVALID", "图片地址无效"))?;
            validate_request_target(&url).await?;
            let response = self
                .http_client
                .get(url.clone())
                .send()
                .await
                .map_err(|error| {
                    log::warn!(
                        "图片缓存下载连接失败 connect={} timeout={} request={}",
                        error.is_connect(),
                        error.is_timeout(),
                        error.is_request()
                    );
                    ImageCacheError::new("IMAGE_FETCH_FAILED", "图片下载失败")
                })?;
            if response.status().is_redirection() {
                let location = response
                    .headers()
                    .get(reqwest::header::LOCATION)
                    .and_then(|value| value.to_str().ok())
                    .ok_or_else(|| {
                        ImageCacheError::new("IMAGE_REDIRECT_INVALID", "图片重定向无效")
                    })?;
                if redirect_count >= MAX_REDIRECTS {
                    return Err(ImageCacheError::new(
                        "IMAGE_REDIRECT_INVALID",
                        "图片重定向超过限制",
                    ));
                }
                let next = url.join(location).map_err(|_| {
                    ImageCacheError::new("IMAGE_REDIRECT_INVALID", "图片重定向无效")
                })?;
                current_url = normalize_source_url(next.as_str())?;
                redirect_count += 1;
                continue;
            }
            if !response.status().is_success() {
                return Err(ImageCacheError::new(
                    "IMAGE_FETCH_FAILED",
                    format!("图片下载失败：HTTP {}", response.status()),
                ));
            }
            break response;
        };
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .split(';')
            .next()
            .unwrap_or_default()
            .trim()
            .to_ascii_lowercase();
        let extension = image_extension(&content_type)
            .ok_or_else(|| ImageCacheError::new("IMAGE_TYPE_UNSUPPORTED", "图片格式不受支持"))?;
        if response
            .content_length()
            .is_some_and(|size| size > self.max_image_bytes)
        {
            return Err(ImageCacheError::new(
                "IMAGE_TOO_LARGE",
                "图片文件超过 20MB 限制",
            ));
        }
        let mut response = response;
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| ImageCacheError::new("IMAGE_FETCH_FAILED", "图片下载中断"))?
        {
            if bytes.len().saturating_add(chunk.len()) > self.max_image_bytes as usize {
                return Err(ImageCacheError::new(
                    "IMAGE_TOO_LARGE",
                    "图片文件超过 20MB 限制",
                ));
            }
            bytes.extend_from_slice(&chunk);
        }
        if bytes.is_empty() {
            return Err(ImageCacheError::new("IMAGE_EMPTY", "图片内容为空"));
        }
        if !matches_image_signature(&content_type, &bytes) {
            return Err(ImageCacheError::new(
                "IMAGE_CONTENT_INVALID",
                "图片内容与声明格式不一致",
            ));
        }
        let directory = self.cache_directory.read().await.clone();
        tokio::fs::create_dir_all(&directory)
            .await
            .map_err(|_| ImageCacheError::new("IMAGE_CACHE_WRITE_FAILED", "图片缓存目录不可用"))?;
        let file_name = format!("{cache_key}.{extension}");
        let file_path = directory.join(&file_name);
        let metadata = ImageCacheMetadata {
            version: 1,
            cache_key: cache_key.to_owned(),
            file_name,
            content_type: content_type.clone(),
            size: bytes.len() as u64,
            created_at: Utc::now().to_rfc3339(),
        };
        write_atomic(&file_path, &bytes).await?;
        write_atomic(
            &directory.join(format!("{cache_key}.json")),
            &serde_json::to_vec(&metadata).map_err(|_| {
                ImageCacheError::new("IMAGE_CACHE_WRITE_FAILED", "图片缓存元数据无效")
            })?,
        )
        .await?;
        self.prune(&directory).await;
        Ok(ImageCacheAsset {
            cache_key: cache_key.to_owned(),
            file_path,
            content_type,
            size: bytes.len() as u64,
        })
    }

    async fn prune(&self, directory: &Path) {
        let Ok(mut entries) = tokio::fs::read_dir(directory).await else {
            return;
        };
        let mut files = Vec::new();
        let mut total = 0_u64;
        while let Ok(Some(entry)) = entries.next_entry().await {
            let name = entry.file_name().to_string_lossy().into_owned();
            if !is_cache_data_file(&name) {
                continue;
            }
            if let Ok(metadata) = entry.metadata().await {
                total = total.saturating_add(metadata.len());
                files.push((
                    entry.path(),
                    name,
                    metadata.len(),
                    metadata.modified().unwrap_or(UNIX_EPOCH),
                ));
            }
        }
        if total <= self.max_bytes {
            return;
        }
        files.sort_by_key(|entry| entry.3);
        for (path, name, size, _) in files {
            if total <= self.max_bytes {
                break;
            }
            let cache_key = name.split('.').next().unwrap_or_default();
            let _ = tokio::fs::remove_file(path).await;
            let _ = tokio::fs::remove_file(directory.join(format!("{cache_key}.json"))).await;
            total = total.saturating_sub(size);
        }
    }

    async fn remove_cache_entry(&self, directory: &Path, cache_key: &str) {
        let _ = tokio::fs::remove_file(directory.join(format!("{cache_key}.json"))).await;
        for extension in ["jpg", "png", "webp", "gif", "avif"] {
            let _ =
                tokio::fs::remove_file(directory.join(format!("{cache_key}.{extension}"))).await;
        }
    }
}

/// 校验图片请求目标；官方图片域名交由系统网络栈解析，兼容系统代理与 VPN 路由。
async fn validate_request_target(url: &Url) -> Result<(), ImageCacheError> {
    let hostname = url
        .host_str()
        .map(str::to_ascii_lowercase)
        .ok_or_else(|| ImageCacheError::new("IMAGE_URL_INVALID", "图片地址无效"))?;
    if hostname == "localhost" || hostname.ends_with(".localhost") || hostname.ends_with(".local") {
        return Err(ImageCacheError::new(
            "IMAGE_HOST_FORBIDDEN",
            "图片地址不允许访问本机或私有网络",
        ));
    }
    match url.host() {
        Some(Host::Ipv4(address)) if is_private_or_reserved(IpAddr::V4(address)) => {
            return Err(ImageCacheError::new(
                "IMAGE_HOST_FORBIDDEN",
                "图片地址不允许访问本机或私有网络",
            ));
        }
        Some(Host::Ipv6(address)) if is_private_or_reserved(IpAddr::V6(address)) => {
            return Err(ImageCacheError::new(
                "IMAGE_HOST_FORBIDDEN",
                "图片地址不允许访问本机或私有网络",
            ));
        }
        _ => {}
    }
    if uses_system_routed_image_host(&hostname) {
        log::debug!("官方图片缓存请求遵循系统网络路由 host={hostname}");
        return Ok(());
    }
    let port = url
        .port_or_known_default()
        .ok_or_else(|| ImageCacheError::new("IMAGE_URL_INVALID", "图片地址端口无效"))?;
    let addresses = tokio::net::lookup_host((hostname.as_str(), port))
        .await
        .map_err(|_| ImageCacheError::new("IMAGE_FETCH_FAILED", "图片主机解析失败"))?
        .collect::<Vec<_>>();
    if addresses.is_empty()
        || addresses
            .iter()
            .any(|address| is_private_or_reserved(address.ip()))
    {
        return Err(ImageCacheError::new(
            "IMAGE_HOST_FORBIDDEN",
            "图片地址不允许访问本机或私有网络",
        ));
    }
    Ok(())
}

/// 判断图片域名是否属于需要完整遵循系统代理/VPN 策略的官方来源。
fn uses_system_routed_image_host(hostname: &str) -> bool {
    [
        "mikanani.me",
        "bgm.tv",
        "bangumi.tv",
        "chii.in",
        "anilist.co",
    ]
    .iter()
    .any(|root| hostname == *root || hostname.ends_with(&format!(".{root}")))
}

fn normalize_source_url(value: &str) -> Result<String, ImageCacheError> {
    let mut url =
        Url::parse(value).map_err(|_| ImageCacheError::new("IMAGE_URL_INVALID", "图片地址无效"))?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(ImageCacheError::new(
            "IMAGE_URL_INVALID",
            "图片地址只支持公开 HTTP 或 HTTPS URL",
        ));
    }
    if url.port().is_some_and(|port| {
        !((url.scheme() == "http" && port == 80) || (url.scheme() == "https" && port == 443))
    }) {
        return Err(ImageCacheError::new(
            "IMAGE_URL_INVALID",
            "图片地址端口不受支持",
        ));
    }
    url.set_fragment(None);
    Ok(url.to_string())
}

fn is_private_or_reserved(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => {
            let [first, second, _, _] = address.octets();
            address.is_unspecified()
                || address.is_loopback()
                || address.is_link_local()
                || address.is_broadcast()
                || address.is_multicast()
                || address.is_documentation()
                || first == 10
                || (first == 100 && (64..=127).contains(&second))
                || (first == 172 && (16..=31).contains(&second))
                || (first == 192 && matches!(second, 0 | 168))
                || (first == 198 && matches!(second, 18 | 19 | 51))
                || first >= 224
        }
        IpAddr::V6(address) => {
            address.is_unspecified()
                || address.is_loopback()
                || address.is_multicast()
                || is_ipv6_unique_local(address)
                || is_ipv6_link_local(address)
                || is_ipv6_documentation(address)
                || address
                    .to_ipv4_mapped()
                    .is_some_and(|address| is_private_or_reserved(IpAddr::V4(address)))
        }
    }
}

fn is_ipv6_unique_local(address: Ipv6Addr) -> bool {
    address.segments()[0] & 0xfe00 == 0xfc00
}

fn is_ipv6_link_local(address: Ipv6Addr) -> bool {
    address.segments()[0] & 0xffc0 == 0xfe80
}

fn is_ipv6_documentation(address: Ipv6Addr) -> bool {
    address.segments()[0] == 0x2001 && address.segments()[1] == 0x0db8
}

async fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), ImageCacheError> {
    let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    tokio::fs::write(&temporary, bytes)
        .await
        .map_err(|_| ImageCacheError::new("IMAGE_CACHE_WRITE_FAILED", "图片缓存写入失败"))?;
    if let Err(error) = tokio::fs::rename(&temporary, path).await {
        if tokio::fs::try_exists(path).await.unwrap_or(false) {
            let _ = tokio::fs::remove_file(path).await;
            tokio::fs::rename(&temporary, path).await.map_err(|_| {
                ImageCacheError::new("IMAGE_CACHE_WRITE_FAILED", "图片缓存替换失败")
            })?;
        } else {
            return Err(ImageCacheError::new(
                "IMAGE_CACHE_WRITE_FAILED",
                format!("图片缓存保存失败：{error}"),
            ));
        }
    }
    Ok(())
}

fn image_extension(content_type: &str) -> Option<&'static str> {
    match content_type {
        "image/jpeg" => Some("jpg"),
        "image/png" => Some("png"),
        "image/webp" => Some("webp"),
        "image/gif" => Some("gif"),
        "image/avif" => Some("avif"),
        _ => None,
    }
}

/// 校验图片 MIME 与文件签名一致，阻止 HTML 错误页进入持久缓存。
fn matches_image_signature(content_type: &str, bytes: &[u8]) -> bool {
    match content_type {
        "image/jpeg" => bytes.starts_with(&[0xff, 0xd8, 0xff]),
        "image/png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "image/gif" => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
        "image/webp" => bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP",
        "image/avif" => {
            bytes.len() >= 12
                && &bytes[4..8] == b"ftyp"
                && matches!(&bytes[8..12], b"avif" | b"avis")
        }
        _ => false,
    }
}

/// 记录缓存自愈动作，不输出可能包含敏感查询参数的原始 URL。
fn log_cache_invalidation(cache_key: &str) {
    log::info!("图片缓存已失效 cache_key={cache_key}");
}

fn is_cache_file_name(value: &str, cache_key: &str) -> bool {
    value
        .strip_prefix(cache_key)
        .and_then(|value| value.strip_prefix('.'))
        .is_some_and(|extension| ["jpg", "png", "webp", "gif", "avif"].contains(&extension))
}

fn is_cache_data_file(value: &str) -> bool {
    let mut parts = value.split('.');
    let (Some(key), Some(extension), None) = (parts.next(), parts.next(), parts.next()) else {
        return false;
    };
    key.len() == 64
        && key.bytes().all(|byte| byte.is_ascii_hexdigit())
        && ["jpg", "png", "webp", "gif", "avif"].contains(&extension)
}

fn hex_digest(bytes: impl AsRef<[u8]>) -> String {
    bytes
        .as_ref()
        .iter()
        .map(|value| format!("{value:02x}"))
        .collect()
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use std::net::Ipv4Addr;

    use super::*;

    /// 验证图片签名令牌可往返且任何篡改均被拒绝。
    #[test]
    fn signs_and_verifies_image_tokens() {
        let cache = ImageCache::new(PathBuf::from("cache"), vec![7; 32]).expect("create cache");
        let path = cache
            .create_remote_path("https://example.com/image.png#fragment")
            .expect("create token");
        let token = path.strip_prefix("/api/images/").expect("token path");
        assert_eq!(
            cache.read_token(token).expect("read token"),
            "https://example.com/image.png"
        );
        let mut tampered = token.to_owned();
        tampered.push('a');
        assert_eq!(
            cache
                .read_token(&tampered)
                .expect_err("tampered token")
                .code,
            "IMAGE_TOKEN_INVALID"
        );
    }

    /// 验证同一源图在签名有效期内复用原路径，过期后才重新签发。
    #[test]
    fn reuses_remote_path_until_token_expires() {
        let cache = ImageCache::new(PathBuf::from("cache"), vec![7; 32]).expect("create cache");
        let first = cache
            .create_remote_path_at("https://example.com/image.png", 1_000)
            .expect("create first token");
        let reused = cache
            .create_remote_path_at("https://example.com/image.png", 2_000)
            .expect("reuse token");
        let renewed = cache
            .create_remote_path_at(
                "https://example.com/image.png",
                1_001 + TOKEN_LIFETIME.as_millis() as u64,
            )
            .expect("renew token");

        assert_eq!(reused, first);
        assert_ne!(renewed, first);
    }

    /// 验证常见本地、私网和文档地址均不能被缓存入口访问。
    #[test]
    fn rejects_private_and_reserved_addresses() {
        assert!(is_private_or_reserved(IpAddr::V4(Ipv4Addr::LOCALHOST)));
        assert!(is_private_or_reserved(IpAddr::V4(Ipv4Addr::new(
            192, 168, 1, 2
        ))));
        assert!(is_private_or_reserved(IpAddr::V6(Ipv6Addr::LOCALHOST)));
        assert!(!is_private_or_reserved(IpAddr::V4(Ipv4Addr::new(
            8, 8, 8, 8
        ))));
    }

    /// 验证官方图片域名遵循系统路由，近似域名不能绕过公网校验。
    #[test]
    fn identifies_system_routed_image_hosts() {
        assert!(uses_system_routed_image_host("mikanani.me"));
        assert!(uses_system_routed_image_host("img.mikanani.me"));
        assert!(uses_system_routed_image_host("lain.bgm.tv"));
        assert!(uses_system_routed_image_host("api.bangumi.tv"));
        assert!(uses_system_routed_image_host("s4.anilist.co"));
        assert!(!uses_system_routed_image_host("fakebgm.tv"));
        assert!(!uses_system_routed_image_host("bgm.tv.example.com"));
        assert!(!uses_system_routed_image_host("anilist.co.example.com"));
    }

    /// 验证系统路由来源无需预解析，直写私网地址仍会在发起请求前被拒绝。
    #[tokio::test]
    async fn validates_system_routed_and_private_targets() {
        let mikan = Url::parse("https://mikanani.me/images/cover.jpg").expect("mikan url");
        validate_request_target(&mikan)
            .await
            .expect("trusted source follows system route");

        let private = Url::parse("http://192.168.1.2/cover.jpg").expect("private url");
        assert_eq!(
            validate_request_target(&private)
                .await
                .expect_err("private target must fail")
                .code,
            "IMAGE_HOST_FORBIDDEN"
        );
    }

    /// 验证各受支持 MIME 必须匹配对应文件签名。
    #[test]
    fn validates_image_signatures() {
        assert!(matches_image_signature(
            "image/png",
            b"\x89PNG\r\n\x1a\nrest"
        ));
        assert!(matches_image_signature(
            "image/webp",
            b"RIFF\x04\x00\x00\x00WEBPrest"
        ));
        assert!(!matches_image_signature(
            "image/png",
            b"<html>upstream error</html>"
        ));
        assert!(!matches_image_signature("image/jpeg", b"\x89PNG\r\n\x1a\n"));
    }

    /// 验证命中 MIME 不符的磁盘内容时自动删除缓存记录。
    #[tokio::test]
    async fn invalidates_corrupt_cached_file() {
        let directory = tempfile::tempdir().expect("create image cache directory");
        let cache = ImageCache::new_local(directory.path().to_path_buf()).expect("create cache");
        let source_url = normalize_source_url("https://example.com/cover.png").expect("url");
        let cache_key = hex_digest(Sha256::digest(source_url.as_bytes()));
        let file_name = format!("{cache_key}.png");
        let bytes = b"<html>upstream error</html>";
        tokio::fs::write(directory.path().join(&file_name), bytes)
            .await
            .expect("write corrupt cache");
        let metadata = ImageCacheMetadata {
            version: 1,
            cache_key: cache_key.clone(),
            file_name: file_name.clone(),
            content_type: "image/png".to_owned(),
            size: bytes.len() as u64,
            created_at: Utc::now().to_rfc3339(),
        };
        tokio::fs::write(
            directory.path().join(format!("{cache_key}.json")),
            serde_json::to_vec(&metadata).expect("encode metadata"),
        )
        .await
        .expect("write metadata");

        assert!(cache.read_cached(&cache_key).await.is_none());
        assert!(!directory.path().join(file_name).exists());
        assert!(!directory.path().join(format!("{cache_key}.json")).exists());
    }
}
