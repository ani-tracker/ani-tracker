use std::net::{IpAddr, Ipv4Addr};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum_server::tls_rustls::RustlsConfig;
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use chrono::{SecondsFormat, TimeZone, Utc};
use rcgen::{
    BasicConstraints, CertificateParams, DistinguishedName, DnType, IsCa, Issuer, KeyPair,
    KeyUsagePurpose, SanType,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use time::{Duration, OffsetDateTime};

use crate::auth::RemoteSecretStore;

const CA_KEY_SECRET: &str = "remote-tls-ca-key-v1";
const SERVER_KEY_SECRET: &str = "remote-tls-server-key-v1";
const SERVER_LIFETIME_DAYS: i64 = 365;
const AUTHORITY_LIFETIME_DAYS: i64 = 3_650;
const ROTATE_SERVER_BEFORE_DAYS: i64 = 30;
const ROTATE_AUTHORITY_BEFORE_DAYS: i64 = 365;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CertificateMetadata {
    version: u8,
    addresses: Vec<Ipv4Addr>,
    fingerprint: String,
    expires_at_unix: i64,
    authority_expires_at_unix: i64,
}

/// HTTPS 监听器使用的证书、私钥和可公开元数据。
#[derive(Clone)]
pub struct RemoteTlsBundle {
    pub(crate) key_pem: Vec<u8>,
    pub(crate) cert_pem: Vec<u8>,
    pub ca_pem: Vec<u8>,
    pub fingerprint: String,
    pub expires_at: String,
    pub authority_certificate_path: PathBuf,
}

impl RemoteTlsBundle {
    /// 创建并校验证书与私钥匹配的 rustls 配置。
    pub async fn rustls_config(&self) -> Result<RustlsConfig, String> {
        // 工作区依赖可能同时启用多个密码学后端，必须在构建 TLS 配置前显式选择。
        let _ = rustls::crypto::ring::default_provider().install_default();
        RustlsConfig::from_pem(self.cert_pem.clone(), self.key_pem.clone())
            .await
            .map_err(|error| format!("加载远程 TLS 证书失败：{error}"))
    }
}

/// 使用平台安全存储保护私钥，并在地址变化或临近过期时轮换证书。
pub struct RemoteTlsCertificateStore {
    directory: PathBuf,
    secret_store: Arc<dyn RemoteSecretStore>,
}

impl RemoteTlsCertificateStore {
    /// 创建远程 TLS 证书仓库。
    pub fn new(directory: PathBuf, secret_store: Arc<dyn RemoteSecretStore>) -> Self {
        Self {
            directory,
            secret_store,
        }
    }

    /// 读取仍可复用的证书，必要时使用稳定本地 CA 重新签发。
    pub async fn load_or_create(&self, addresses: &[Ipv4Addr]) -> Result<RemoteTlsBundle, String> {
        let mut addresses = addresses.to_vec();
        addresses.sort_unstable();
        addresses.dedup();
        if addresses.is_empty()
            || addresses
                .iter()
                .any(|address| !crate::is_private_ipv4(*address))
        {
            return Err("远程 TLS 证书必须绑定至少一个私有 IPv4 地址".to_owned());
        }
        if let Some(bundle) = self.read_current(&addresses).await? {
            return Ok(bundle);
        }

        tokio::fs::create_dir_all(&self.directory)
            .await
            .map_err(|error| format!("创建远程证书目录失败：{error}"))?;
        let now = OffsetDateTime::now_utc();
        let existing_metadata = read_metadata(&self.metadata_path()).await.ok();
        let authority = self
            .read_authority(existing_metadata.as_ref(), now)
            .await?
            .unwrap_or_else(|| generate_authority(now).expect("rcgen authority generation"));
        let server = generate_server(&addresses, now, &authority)?;
        let metadata = CertificateMetadata {
            version: 1,
            addresses,
            fingerprint: server.fingerprint.clone(),
            expires_at_unix: server.expires_at.unix_timestamp(),
            authority_expires_at_unix: authority.expires_at.unix_timestamp(),
        };
        self.persist(&authority, &server, &metadata).await?;
        log::info!(
            "Rust 远程 TLS 证书已签发 addresses={} expires_at={}",
            metadata.addresses.len(),
            metadata.expires_at_unix
        );
        Ok(self.bundle(server, authority.certificate_pem))
    }

    async fn read_current(
        &self,
        addresses: &[Ipv4Addr],
    ) -> Result<Option<RemoteTlsBundle>, String> {
        let metadata = match read_metadata(&self.metadata_path()).await {
            Ok(metadata) => metadata,
            Err(_) => return Ok(None),
        };
        let rotate_before = OffsetDateTime::now_utc() + Duration::days(ROTATE_SERVER_BEFORE_DAYS);
        if metadata.version != 1
            || metadata.addresses != addresses
            || metadata.expires_at_unix <= rotate_before.unix_timestamp()
        {
            return Ok(None);
        }
        let (certificate_pem, authority_pem) = match tokio::try_join!(
            tokio::fs::read(self.certificate_path()),
            tokio::fs::read(self.authority_path())
        ) {
            Ok(value) => value,
            Err(_) => return Ok(None),
        };
        let key_pem = match self.secret_store.read(SERVER_KEY_SECRET).await? {
            Some(value) => value,
            None => return Ok(None),
        };
        let fingerprint = certificate_fingerprint(&certificate_pem)?;
        if fingerprint != metadata.fingerprint {
            return Ok(None);
        }
        let bundle = RemoteTlsBundle {
            key_pem,
            cert_pem: certificate_pem,
            ca_pem: authority_pem,
            fingerprint,
            expires_at: unix_timestamp(metadata.expires_at_unix),
            authority_certificate_path: self.authority_path(),
        };
        if bundle.rustls_config().await.is_err() {
            return Ok(None);
        }
        Ok(Some(bundle))
    }

    async fn read_authority(
        &self,
        metadata: Option<&CertificateMetadata>,
        now: OffsetDateTime,
    ) -> Result<Option<GeneratedAuthority>, String> {
        let Some(metadata) = metadata else {
            return Ok(None);
        };
        if metadata.authority_expires_at_unix
            <= (now + Duration::days(ROTATE_AUTHORITY_BEFORE_DAYS)).unix_timestamp()
        {
            return Ok(None);
        }
        let certificate_pem = match tokio::fs::read_to_string(self.authority_path()).await {
            Ok(value) => value,
            Err(_) => return Ok(None),
        };
        let key_pem = match self.secret_store.read(CA_KEY_SECRET).await? {
            Some(value) => String::from_utf8(value)
                .map_err(|error| format!("远程 CA 私钥编码无效：{error}"))?,
            None => return Ok(None),
        };
        let key_pair = KeyPair::from_pem(&key_pem)
            .map_err(|error| format!("读取远程 CA 私钥失败：{error}"))?;
        Ok(Some(GeneratedAuthority {
            certificate_pem,
            key_pem,
            key_pair,
            expires_at: OffsetDateTime::from_unix_timestamp(metadata.authority_expires_at_unix)
                .map_err(|error| format!("远程 CA 到期时间无效：{error}"))?,
        }))
    }

    async fn persist(
        &self,
        authority: &GeneratedAuthority,
        server: &GeneratedServer,
        metadata: &CertificateMetadata,
    ) -> Result<(), String> {
        write_atomic(&self.authority_path(), authority.certificate_pem.as_bytes()).await?;
        write_atomic(&self.certificate_path(), server.certificate_pem.as_bytes()).await?;
        write_atomic(
            &self.metadata_path(),
            &serde_json::to_vec_pretty(metadata)
                .map_err(|error| format!("编码远程证书元数据失败：{error}"))?,
        )
        .await?;
        self.secret_store
            .write(CA_KEY_SECRET, authority.key_pem.as_bytes())
            .await?;
        self.secret_store
            .write(SERVER_KEY_SECRET, server.key_pem.as_bytes())
            .await?;
        Ok(())
    }

    fn bundle(&self, server: GeneratedServer, authority_pem: String) -> RemoteTlsBundle {
        RemoteTlsBundle {
            key_pem: server.key_pem.into_bytes(),
            cert_pem: server.certificate_pem.into_bytes(),
            ca_pem: authority_pem.into_bytes(),
            fingerprint: server.fingerprint,
            expires_at: server
                .expires_at
                .format(&time::format_description::well_known::Rfc3339)
                .unwrap_or_else(|_| unix_timestamp(server.expires_at.unix_timestamp())),
            authority_certificate_path: self.authority_path(),
        }
    }

    fn authority_path(&self) -> PathBuf {
        self.directory.join("ani-tracker-ca.crt")
    }

    fn certificate_path(&self) -> PathBuf {
        self.directory.join("ani-tracker-server.crt")
    }

    fn metadata_path(&self) -> PathBuf {
        self.directory.join("ani-tracker-certificate.json")
    }
}

struct GeneratedAuthority {
    certificate_pem: String,
    key_pem: String,
    key_pair: KeyPair,
    expires_at: OffsetDateTime,
}

struct GeneratedServer {
    certificate_pem: String,
    key_pem: String,
    fingerprint: String,
    expires_at: OffsetDateTime,
}

fn generate_authority(now: OffsetDateTime) -> Result<GeneratedAuthority, String> {
    let mut params = CertificateParams::default();
    params.not_before = now - Duration::minutes(1);
    params.not_after = now + Duration::days(AUTHORITY_LIFETIME_DAYS);
    params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    params.key_usages = vec![
        KeyUsagePurpose::KeyCertSign,
        KeyUsagePurpose::CrlSign,
        KeyUsagePurpose::DigitalSignature,
    ];
    let mut name = DistinguishedName::new();
    name.push(DnType::CommonName, "Ani Tracker Local CA");
    params.distinguished_name = name;
    let key_pair = KeyPair::generate().map_err(|error| format!("生成远程 CA 私钥失败：{error}"))?;
    let certificate = params
        .self_signed(&key_pair)
        .map_err(|error| format!("签发远程 CA 失败：{error}"))?;
    Ok(GeneratedAuthority {
        certificate_pem: certificate.pem(),
        key_pem: key_pair.serialize_pem(),
        key_pair,
        expires_at: params.not_after,
    })
}

fn generate_server(
    addresses: &[Ipv4Addr],
    now: OffsetDateTime,
    authority: &GeneratedAuthority,
) -> Result<GeneratedServer, String> {
    let mut params = CertificateParams::new(vec!["localhost".to_owned()])
        .map_err(|error| format!("创建远程服务端证书参数失败：{error}"))?;
    params.not_before = now - Duration::minutes(1);
    params.not_after = now + Duration::days(SERVER_LIFETIME_DAYS);
    params.is_ca = IsCa::NoCa;
    params.key_usages = vec![
        KeyUsagePurpose::DigitalSignature,
        KeyUsagePurpose::KeyEncipherment,
    ];
    params
        .subject_alt_names
        .push(SanType::IpAddress(IpAddr::V4(Ipv4Addr::LOCALHOST)));
    params.subject_alt_names.extend(
        addresses
            .iter()
            .copied()
            .map(|address| SanType::IpAddress(IpAddr::V4(address))),
    );
    let mut name = DistinguishedName::new();
    name.push(DnType::CommonName, "Ani Tracker");
    params.distinguished_name = name;
    let key_pair =
        KeyPair::generate().map_err(|error| format!("生成远程服务端私钥失败：{error}"))?;
    let issuer = Issuer::from_ca_cert_pem(&authority.certificate_pem, &authority.key_pair)
        .map_err(|error| format!("读取远程 CA 失败：{error}"))?;
    let certificate = params
        .signed_by(&key_pair, &issuer)
        .map_err(|error| format!("签发远程服务端证书失败：{error}"))?;
    let der = certificate.der().as_ref();
    Ok(GeneratedServer {
        certificate_pem: certificate.pem(),
        key_pem: key_pair.serialize_pem(),
        fingerprint: hex_digest(Sha256::digest(der)),
        expires_at: params.not_after,
    })
}

async fn read_metadata(path: &Path) -> Result<CertificateMetadata, String> {
    let bytes = tokio::fs::read(path)
        .await
        .map_err(|error| error.to_string())?;
    serde_json::from_slice(&bytes).map_err(|error| error.to_string())
}

async fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "远程证书路径没有父目录".to_owned())?;
    tokio::fs::create_dir_all(parent)
        .await
        .map_err(|error| format!("创建远程证书目录失败：{error}"))?;
    let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    tokio::fs::write(&temporary, bytes)
        .await
        .map_err(|error| format!("写入远程证书临时文件失败：{error}"))?;
    if let Err(error) = tokio::fs::rename(&temporary, path).await {
        if tokio::fs::try_exists(path).await.unwrap_or(false) {
            tokio::fs::remove_file(path)
                .await
                .map_err(|remove_error| format!("替换远程证书失败：{remove_error}"))?;
            tokio::fs::rename(&temporary, path)
                .await
                .map_err(|rename_error| format!("替换远程证书失败：{rename_error}"))?;
        } else {
            return Err(format!("保存远程证书失败：{error}"));
        }
    }
    Ok(())
}

fn certificate_fingerprint(pem: &[u8]) -> Result<String, String> {
    let text = std::str::from_utf8(pem).map_err(|error| error.to_string())?;
    let encoded = text
        .lines()
        .filter(|line| !line.starts_with("-----"))
        .collect::<String>();
    let der = STANDARD
        .decode(encoded)
        .map_err(|error| format!("远程证书 PEM 无效：{error}"))?;
    Ok(hex_digest(Sha256::digest(der)))
}

fn hex_digest(bytes: impl AsRef<[u8]>) -> String {
    bytes
        .as_ref()
        .iter()
        .map(|value| format!("{value:02x}"))
        .collect()
}

fn unix_timestamp(value: i64) -> String {
    Utc.timestamp_opt(value, 0)
        .single()
        .unwrap_or_else(Utc::now)
        .to_rfc3339_opts(SecondsFormat::Secs, true)
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use async_trait::async_trait;
    use tempfile::tempdir;
    use tokio::sync::Mutex;

    use super::*;

    #[derive(Default)]
    struct MemorySecretStore(Mutex<HashMap<String, Vec<u8>>>);

    #[async_trait]
    impl RemoteSecretStore for MemorySecretStore {
        async fn read(&self, key: &str) -> Result<Option<Vec<u8>>, String> {
            Ok(self.0.lock().await.get(key).cloned())
        }

        async fn write(&self, key: &str, value: &[u8]) -> Result<(), String> {
            self.0.lock().await.insert(key.to_owned(), value.to_vec());
            Ok(())
        }

        async fn delete(&self, key: &str) -> Result<(), String> {
            self.0.lock().await.remove(key);
            Ok(())
        }
    }

    /// 验证服务端证书覆盖私网地址，并在地址不变时稳定复用。
    #[tokio::test]
    async fn creates_and_reuses_tls_bundle() {
        let directory = tempdir().expect("create temp directory");
        let store = Arc::new(MemorySecretStore::default());
        let certificates = RemoteTlsCertificateStore::new(directory.path().to_owned(), store);
        let first = certificates
            .load_or_create(&[Ipv4Addr::new(192, 168, 1, 8)])
            .await
            .expect("create certificate");
        let second = certificates
            .load_or_create(&[Ipv4Addr::new(192, 168, 1, 8)])
            .await
            .expect("reuse certificate");

        assert_eq!(first.fingerprint, second.fingerprint);
        assert_eq!(first.ca_pem, second.ca_pem);
        first.rustls_config().await.expect("load rustls config");
    }
}
