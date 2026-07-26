use std::path::PathBuf;

use serde::{de::DeserializeOwned, Deserialize, Serialize};
use tauri::{
    plugin::{PluginApi, PluginHandle},
    AppHandle, Runtime,
};

use crate::{MobileNavigationIntent, MobilePlatformStatus};

/// 注册 Android 平台插件并保存原生调用句柄。
pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> crate::Result<AniMobile<R>> {
    let handle = api.register_android_plugin("dev.ani.tracker.mobile", "AniMobilePlugin")?;
    Ok(AniMobile(handle))
}

/// Tauri 应用持有的 Android 生命周期与安全存储入口。
pub struct AniMobile<R: Runtime>(PluginHandle<R>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SecureKey<'a> {
    key: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SecureValue<'a> {
    key: &'a str,
    value: &'a str,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SecureValueResponse {
    value: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportDocumentRequest<'a> {
    uri: &'a str,
    kind: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportDocumentRequest<'a> {
    uri: &'a str,
    source_path: &'a str,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DocumentPathResponse {
    path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackgroundRefreshResponse {
    due: bool,
}

impl<R: Runtime> AniMobile<R> {
    /// 读取网络、存储、方向、通知权限和生命周期状态。
    pub fn status(&self) -> crate::Result<MobilePlatformStatus> {
        self.0.run_mobile_plugin("status", ()).map_err(Into::into)
    }

    /// 读取并清除最近一次原生导航意图。
    pub fn consume_navigation(&self) -> crate::Result<Option<MobileNavigationIntent>> {
        self.0
            .run_mobile_plugin("consumeNavigation", ())
            .map_err(Into::into)
    }

    /// 读取并清除原生后台调度要求的补跑标记。
    pub fn consume_background_refresh(&self) -> crate::Result<bool> {
        self.0
            .run_mobile_plugin::<BackgroundRefreshResponse>("consumeBackgroundRefresh", ())
            .map(|response| response.due)
            .map_err(Into::into)
    }

    /// 使用 Android Keystore 加密保存敏感值。
    pub fn secure_set(&self, key: &str, value: &str) -> crate::Result<()> {
        self.0
            .run_mobile_plugin::<()>("secureSet", SecureValue { key, value })
            .map_err(Into::into)
    }

    /// 从 Android Keystore 保护的存储读取敏感值。
    pub fn secure_get(&self, key: &str) -> crate::Result<Option<String>> {
        self.0
            .run_mobile_plugin::<SecureValueResponse>("secureGet", SecureKey { key })
            .map(|response| response.value)
            .map_err(Into::into)
    }

    /// 删除 Android Keystore 保护的敏感值。
    pub fn secure_delete(&self, key: &str) -> crate::Result<()> {
        self.0
            .run_mobile_plugin::<()>("secureDelete", SecureKey { key })
            .map_err(Into::into)
    }

    /// 将 Android ContentResolver 文档复制到应用私有临时目录。
    pub fn import_document(&self, uri: &str, kind: &str) -> crate::Result<PathBuf> {
        self.0
            .run_mobile_plugin::<DocumentPathResponse>(
                "importDocument",
                ImportDocumentRequest { uri, kind },
            )
            .map(|response| PathBuf::from(response.path))
            .map_err(Into::into)
    }

    /// 将应用私有文件写入用户通过系统选择的 ContentResolver 文档。
    pub fn export_document(&self, uri: &str, source_path: &str) -> crate::Result<()> {
        self.0
            .run_mobile_plugin::<()>("exportDocument", ExportDocumentRequest { uri, source_path })
            .map_err(Into::into)
    }
}
