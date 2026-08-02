use std::collections::{BTreeSet, HashMap};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use ani_contracts::{RemoteDeviceInfo, RemotePairingChallenge};
use async_trait::async_trait;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use chrono::{SecondsFormat, TimeZone, Utc};
use rand::rngs::OsRng;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use tokio::sync::{Mutex, RwLock};

const SECRET_KEY: &str = "remote-devices-v1";
const PAIRING_TTL_MILLIS: u64 = 2 * 60 * 1_000;
const ACCESS_PERSIST_INTERVAL_MILLIS: u64 = 60 * 1_000;
const MAX_PAIRING_ATTEMPTS: u8 = 5;
const PAIRING_CODE_RANGE: u32 = 1_000_000;

const LEGACY_REMOTE_SCOPES: &[&str] = &[
    "dashboard.read",
    "notifications.read",
    "notifications.write",
    "library.read",
    "library.write",
    "catalog.read",
    "downloads.read",
    "downloads.control",
];

pub(crate) const ALL_REMOTE_SCOPES: &[&str] = &[
    "dashboard.read",
    "notifications.read",
    "notifications.write",
    "library.read",
    "library.write",
    "catalog.read",
    "downloads.read",
    "downloads.control",
    "sources.read",
    "sources.write",
    "settings.read",
    "settings.write",
    "host.control",
];

/// 平台安全存储端口；实现负责使用 DPAPI、Keychain 或 Secret Service。
#[async_trait]
pub trait RemoteSecretStore: Send + Sync {
    /// 读取指定远程凭据。
    async fn read(&self, key: &str) -> Result<Option<Vec<u8>>, String>;

    /// 原子写入指定远程凭据。
    async fn write(&self, key: &str, value: &[u8]) -> Result<(), String>;

    /// 删除指定远程凭据。
    async fn delete(&self, key: &str) -> Result<(), String>;
}

/// 配对成功后仅返回一次的设备令牌。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingResult {
    pub device: RemoteDeviceInfo,
    pub token: String,
}

/// 远程设备配对与鉴权的稳定错误。
#[derive(Debug, thiserror::Error)]
pub enum RemoteDeviceAuthError {
    #[error("当前没有有效配对会话")]
    PairingNotActive,
    #[error("配对码已过期")]
    PairingExpired,
    #[error("配对码无效")]
    PairingCodeInvalid,
    #[error("错误次数过多，配对会话已锁定")]
    PairingLocked,
    #[error("设备名称无效")]
    DeviceNameInvalid,
    #[error("远程设备凭据不可用：{0}")]
    Persistence(String),
}

impl RemoteDeviceAuthError {
    /// 返回兼容现有远程协议的稳定错误码。
    pub(crate) fn code(&self) -> &'static str {
        match self {
            Self::PairingNotActive => "PAIRING_NOT_ACTIVE",
            Self::PairingExpired => "PAIRING_EXPIRED",
            Self::PairingCodeInvalid => "PAIRING_CODE_INVALID",
            Self::PairingLocked => "PAIRING_LOCKED",
            Self::DeviceNameInvalid => "DEVICE_NAME_INVALID",
            Self::Persistence(_) => "REMOTE_CREDENTIAL_STORE_FAILED",
        }
    }
}

struct PairingSession {
    code_hash: [u8; 32],
    expires_at_millis: u64,
    failed_attempts: u8,
}

#[derive(Clone)]
struct DeviceRecord {
    info: RemoteDeviceInfo,
    token_hash: [u8; 32],
    last_persisted_access_millis: u64,
}

#[derive(Default)]
struct AuthState {
    initialized: bool,
    devices: HashMap<String, DeviceRecord>,
    pairing: Option<PairingSession>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredDeviceFile {
    version: u8,
    devices: Vec<StoredDevice>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredDevice {
    id: String,
    name: String,
    scopes: Vec<String>,
    created_at: String,
    last_accessed_at: Option<String>,
    token_hash: String,
}

/// 保存令牌摘要、一次性配对码和设备权限的线程安全鉴权核心。
pub struct RemoteDeviceAuth {
    secret_store: Arc<dyn RemoteSecretStore>,
    state: RwLock<AuthState>,
    persistence_lock: Mutex<()>,
}

impl RemoteDeviceAuth {
    /// 使用平台安全存储创建远程鉴权核心。
    pub fn new(secret_store: Arc<dyn RemoteSecretStore>) -> Self {
        Self {
            secret_store,
            state: RwLock::new(AuthState::default()),
            persistence_lock: Mutex::new(()),
        }
    }

    /// 从平台安全存储恢复设备摘要，重复调用保持幂等。
    pub async fn initialize(&self) -> Result<(), RemoteDeviceAuthError> {
        {
            let state = self.state.read().await;
            if state.initialized {
                return Ok(());
            }
        }
        let bytes = self
            .secret_store
            .read(SECRET_KEY)
            .await
            .map_err(RemoteDeviceAuthError::Persistence)?;
        let mut devices = HashMap::new();
        if let Some(bytes) = bytes {
            let stored: StoredDeviceFile = serde_json::from_slice(&bytes)
                .map_err(|error| RemoteDeviceAuthError::Persistence(error.to_string()))?;
            if stored.version != 1 {
                return Err(RemoteDeviceAuthError::Persistence(
                    "远程设备凭据版本不受支持".to_owned(),
                ));
            }
            for item in stored.devices {
                let record = parse_stored_device(item)?;
                devices.insert(record.info.id.clone(), record);
            }
        }
        let mut state = self.state.write().await;
        if !state.initialized {
            state.devices = devices;
            state.initialized = true;
        }
        log::info!("Rust 远程设备凭据已恢复 count={}", state.devices.len());
        Ok(())
    }

    /// 创建两分钟有效的六位一次性配对码，并废止旧配对码。
    pub async fn create_pairing_code(&self) -> RemotePairingChallenge {
        let code = generate_pairing_code();
        let expires_at_millis = now_millis().saturating_add(PAIRING_TTL_MILLIS);
        self.state.write().await.pairing = Some(PairingSession {
            code_hash: hash_secret(code.as_bytes()),
            expires_at_millis,
            failed_attempts: 0,
        });
        log::info!("Rust 远程设备配对会话已创建 expires_at={expires_at_millis}");
        RemotePairingChallenge {
            code,
            expires_at: timestamp(expires_at_millis),
        }
    }

    /// 使用一次性配对码登记设备，并只在本次响应返回明文令牌。
    pub async fn pair_device(
        &self,
        code: &str,
        name: &str,
    ) -> Result<PairingResult, RemoteDeviceAuthError> {
        let name = name.trim();
        if name.is_empty() || name.chars().count() > 80 || name.chars().any(char::is_control) {
            return Err(RemoteDeviceAuthError::DeviceNameInvalid);
        }
        let now = now_millis();
        let mut state = self.state.write().await;
        let session = state
            .pairing
            .as_mut()
            .ok_or(RemoteDeviceAuthError::PairingNotActive)?;
        if now >= session.expires_at_millis {
            state.pairing = None;
            return Err(RemoteDeviceAuthError::PairingExpired);
        }
        if hash_secret(code.as_bytes())
            .ct_eq(&session.code_hash)
            .unwrap_u8()
            != 1
        {
            session.failed_attempts = session.failed_attempts.saturating_add(1);
            if session.failed_attempts >= MAX_PAIRING_ATTEMPTS {
                state.pairing = None;
                return Err(RemoteDeviceAuthError::PairingLocked);
            }
            return Err(RemoteDeviceAuthError::PairingCodeInvalid);
        }

        state.pairing = None;
        let token = random_token(32);
        let id = random_hex(16);
        let info = RemoteDeviceInfo {
            id: id.clone(),
            name: name.to_owned(),
            scopes: ALL_REMOTE_SCOPES
                .iter()
                .map(|scope| (*scope).to_owned())
                .collect(),
            created_at: timestamp(now),
            last_accessed_at: None,
        };
        state.devices.insert(
            id,
            DeviceRecord {
                info: info.clone(),
                token_hash: hash_secret(token.as_bytes()),
                last_persisted_access_millis: 0,
            },
        );
        drop(state);
        if let Err(error) = self.persist().await {
            self.state.write().await.devices.remove(&info.id);
            return Err(error);
        }
        log::info!("Rust 远程设备配对完成 device_id={}", info.id);
        Ok(PairingResult {
            device: info,
            token,
        })
    }

    /// 使用常量时间比较验证 Bearer 令牌，并节流保存最后访问时间。
    pub async fn authenticate(&self, token: &str) -> Option<RemoteDeviceInfo> {
        let candidate = hash_secret(token.as_bytes());
        let now = now_millis();
        let mut should_persist = false;
        let mut matched = None;
        {
            let mut state = self.state.write().await;
            for record in state.devices.values_mut() {
                if candidate.ct_eq(&record.token_hash).unwrap_u8() == 1 {
                    record.info.last_accessed_at = Some(timestamp(now));
                    if now.saturating_sub(record.last_persisted_access_millis)
                        >= ACCESS_PERSIST_INTERVAL_MILLIS
                    {
                        record.last_persisted_access_millis = now;
                        should_persist = true;
                    }
                    matched = Some(record.info.clone());
                }
            }
        }
        if matched.is_some() && should_persist {
            if let Err(error) = self.persist().await {
                log::warn!("Rust 远程设备访问时间保存失败 error={error}");
            }
        }
        matched
    }

    /// 返回不包含令牌摘要的设备列表。
    pub async fn list_devices(&self) -> Vec<RemoteDeviceInfo> {
        let mut devices = self
            .state
            .read()
            .await
            .devices
            .values()
            .map(|record| record.info.clone())
            .collect::<Vec<_>>();
        devices.sort_by(|left, right| left.created_at.cmp(&right.created_at));
        devices
    }

    /// 吊销设备及其令牌，并同步平台安全存储。
    pub async fn revoke(&self, device_id: &str) -> Result<bool, RemoteDeviceAuthError> {
        let removed = self.state.write().await.devices.remove(device_id).is_some();
        if removed {
            self.persist().await?;
            log::info!("Rust 远程设备已吊销 device_id={device_id}");
        }
        Ok(removed)
    }

    /// 顺序写入完整设备快照，避免并发认证覆盖吊销结果。
    async fn persist(&self) -> Result<(), RemoteDeviceAuthError> {
        let _guard = self.persistence_lock.lock().await;
        let state = self.state.read().await;
        let mut devices = state
            .devices
            .values()
            .map(|record| StoredDevice {
                id: record.info.id.clone(),
                name: record.info.name.clone(),
                scopes: record.info.scopes.clone(),
                created_at: record.info.created_at.clone(),
                last_accessed_at: record.info.last_accessed_at.clone(),
                token_hash: URL_SAFE_NO_PAD.encode(record.token_hash),
            })
            .collect::<Vec<_>>();
        devices.sort_by(|left, right| left.id.cmp(&right.id));
        let payload = serde_json::to_vec(&StoredDeviceFile {
            version: 1,
            devices,
        })
        .map_err(|error| RemoteDeviceAuthError::Persistence(error.to_string()))?;
        drop(state);
        self.secret_store
            .write(SECRET_KEY, &payload)
            .await
            .map_err(RemoteDeviceAuthError::Persistence)
    }
}

/// 严格校验从安全存储解码的设备记录。
fn parse_stored_device(mut item: StoredDevice) -> Result<DeviceRecord, RemoteDeviceAuthError> {
    // 旧版本配对设备已拥有当时全部权限，升级时补齐新增的等价业务 scope。
    if LEGACY_REMOTE_SCOPES
        .iter()
        .all(|scope| item.scopes.iter().any(|current| current == scope))
    {
        item.scopes.extend(
            ALL_REMOTE_SCOPES
                .iter()
                .filter(|scope| !item.scopes.iter().any(|current| current == **scope))
                .map(|scope| (*scope).to_owned())
                .collect::<Vec<_>>(),
        );
    }
    if item.id.len() != 32
        || !item.id.bytes().all(|value| value.is_ascii_hexdigit())
        || item.name.trim().is_empty()
        || item.name.chars().count() > 80
        || item.scopes.iter().any(|scope| {
            !ALL_REMOTE_SCOPES.contains(&scope.as_str()) || scope.is_empty() || scope.len() > 80
        })
        || chrono::DateTime::parse_from_rfc3339(&item.created_at).is_err()
        || item
            .last_accessed_at
            .as_deref()
            .is_some_and(|value| chrono::DateTime::parse_from_rfc3339(value).is_err())
    {
        return Err(RemoteDeviceAuthError::Persistence(
            "远程设备凭据记录无效".to_owned(),
        ));
    }
    let token_hash = URL_SAFE_NO_PAD
        .decode(item.token_hash)
        .ok()
        .and_then(|bytes| <[u8; 32]>::try_from(bytes).ok())
        .ok_or_else(|| RemoteDeviceAuthError::Persistence("远程设备令牌摘要无效".to_owned()))?;
    Ok(DeviceRecord {
        info: RemoteDeviceInfo {
            id: item.id.to_ascii_lowercase(),
            name: item.name,
            scopes: item
                .scopes
                .into_iter()
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect(),
            created_at: item.created_at,
            last_accessed_at: item.last_accessed_at,
        },
        token_hash,
        last_persisted_access_millis: 0,
    })
}

fn hash_secret(value: &[u8]) -> [u8; 32] {
    Sha256::digest(value).into()
}

fn generate_pairing_code() -> String {
    let acceptance_limit = u32::MAX - (u32::MAX % PAIRING_CODE_RANGE);
    let value = loop {
        let value = OsRng.next_u32();
        if value < acceptance_limit {
            break value;
        }
    };
    format!("{:06}", value % PAIRING_CODE_RANGE)
}

fn random_token(size: usize) -> String {
    let mut bytes = vec![0_u8; size];
    OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

fn random_hex(size: usize) -> String {
    let mut bytes = vec![0_u8; size];
    OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|value| format!("{value:02x}")).collect()
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn timestamp(millis: u64) -> String {
    Utc.timestamp_millis_opt(i64::try_from(millis).unwrap_or(i64::MAX))
        .single()
        .unwrap_or_else(Utc::now)
        .to_rfc3339_opts(SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
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

    /// 验证配对令牌只返回一次，持久化中仅保存摘要且吊销立即生效。
    #[tokio::test]
    async fn pairs_authenticates_persists_and_revokes_device() {
        let store = Arc::new(MemorySecretStore::default());
        let auth = RemoteDeviceAuth::new(store.clone());
        auth.initialize().await.expect("initialize auth");
        let challenge = auth.create_pairing_code().await;
        let paired = auth
            .pair_device(&challenge.code, "客厅平板")
            .await
            .expect("pair device");

        assert!(auth.authenticate(&paired.token).await.is_some());
        let persisted = store
            .read(SECRET_KEY)
            .await
            .expect("read store")
            .expect("stored devices");
        assert!(!String::from_utf8_lossy(&persisted).contains(&paired.token));

        let restored = RemoteDeviceAuth::new(store);
        restored.initialize().await.expect("restore auth");
        assert!(restored.authenticate(&paired.token).await.is_some());
        assert!(restored.revoke(&paired.device.id).await.expect("revoke"));
        assert!(restored.authenticate(&paired.token).await.is_none());
    }

    /// 验证配对错误达到上限后锁定当前会话。
    #[tokio::test]
    async fn locks_pairing_after_invalid_attempts() {
        let auth = RemoteDeviceAuth::new(Arc::new(MemorySecretStore::default()));
        auth.initialize().await.expect("initialize auth");
        auth.create_pairing_code().await;
        for _ in 0..MAX_PAIRING_ATTEMPTS - 1 {
            assert!(matches!(
                auth.pair_device("999999", "测试设备").await,
                Err(RemoteDeviceAuthError::PairingCodeInvalid)
            ));
        }
        assert!(matches!(
            auth.pair_device("999999", "测试设备").await,
            Err(RemoteDeviceAuthError::PairingLocked)
        ));
    }
}
