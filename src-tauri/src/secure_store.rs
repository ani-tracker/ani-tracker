use ani_domain::{SecretReference, SecretValue, SecureStore};
use ani_storage::SecureStoreError;
use tauri::AppHandle;
use tauri_plugin_ani_mobile::AniMobileExt;

/// 将 Rust 安全存储端口连接到 Android Keystore 插件。
pub(crate) struct PlatformSecureStore {
    app: AppHandle,
}

impl PlatformSecureStore {
    /// 创建只持有应用句柄的平台安全存储适配器。
    pub(crate) fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

impl SecureStore for PlatformSecureStore {
    type Error = SecureStoreError;

    /// 从 Android Keystore 保护的偏好中读取敏感值。
    fn read_secret(&self, reference: &SecretReference) -> Result<Option<SecretValue>, Self::Error> {
        let key = storage_key(reference)?;
        self.app
            .ani_mobile()
            .secure_get(&key)
            .map(|value| value.map(|value| SecretValue::new(value.into_bytes())))
            .map_err(|error| SecureStoreError(error.to_string()))
    }

    /// 使用 Android Keystore AES-GCM 保存 UTF-8 敏感值。
    fn write_secret(
        &self,
        reference: &SecretReference,
        value: &SecretValue,
    ) -> Result<(), Self::Error> {
        let key = storage_key(reference)?;
        let value = std::str::from_utf8(value.expose())
            .map_err(|error| SecureStoreError(format!("安全值不是 UTF-8：{error}")))?;
        self.app
            .ani_mobile()
            .secure_set(&key, value)
            .map_err(|error| SecureStoreError(error.to_string()))
    }

    /// 删除 Android Keystore 保护的敏感值。
    fn delete_secret(&self, reference: &SecretReference) -> Result<(), Self::Error> {
        let key = storage_key(reference)?;
        self.app
            .ani_mobile()
            .secure_delete(&key)
            .map_err(|error| SecureStoreError(error.to_string()))
    }
}

/// 将命名空间和业务键映射为原生插件允许的稳定键名。
fn storage_key(reference: &SecretReference) -> Result<String, SecureStoreError> {
    let key = format!("{}.{}", reference.namespace, reference.key);
    if key.len() > 128
        || !key
            .bytes()
            .all(|value| value.is_ascii_alphanumeric() || matches!(value, b'.' | b'_' | b'-'))
    {
        return Err(SecureStoreError("安全存储引用无效".to_owned()));
    }
    Ok(key)
}
