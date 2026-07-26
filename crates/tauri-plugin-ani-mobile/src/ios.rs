use std::path::PathBuf;

use serde::{de::DeserializeOwned, Deserialize, Serialize};
use tauri::{
    plugin::{PluginApi, PluginHandle},
    AppHandle, Runtime,
};

use crate::{MobileNavigationIntent, MobilePlatformStatus};

tauri::ios_plugin_binding!(init_plugin_ani_mobile);

/// 注册 iOS 平台插件并保存原生调用句柄。
pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> crate::Result<AniMobile<R>> {
    let handle = api.register_ios_plugin(init_plugin_ani_mobile)?;
    Ok(AniMobile(handle))
}

/// Tauri 应用持有的 iOS 生命周期、安全存储和文档入口。
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
    /// 读取 iOS 生命周期、网络、存储、方向和通知权限状态。
    pub fn status(&self) -> crate::Result<MobilePlatformStatus> {
        self.0.run_mobile_plugin("status", ()).map_err(Into::into)
    }

    /// 读取并清除最近一次 iOS 通知导航意图。
    pub fn consume_navigation(&self) -> crate::Result<Option<MobileNavigationIntent>> {
        self.0
            .run_mobile_plugin("consumeNavigation", ())
            .map_err(Into::into)
    }

    /// 读取并清除 iOS BGTask 要求的前台补跑标记。
    pub fn consume_background_refresh(&self) -> crate::Result<bool> {
        self.0
            .run_mobile_plugin::<BackgroundRefreshResponse>("consumeBackgroundRefresh", ())
            .map(|response| response.due)
            .map_err(Into::into)
    }

    /// 使用 iOS Keychain 保存敏感值。
    pub fn secure_set(&self, key: &str, value: &str) -> crate::Result<()> {
        self.0
            .run_mobile_plugin::<()>("secureSet", SecureValue { key, value })
            .map_err(Into::into)
    }

    /// 从 iOS Keychain 读取敏感值。
    pub fn secure_get(&self, key: &str) -> crate::Result<Option<String>> {
        self.0
            .run_mobile_plugin::<SecureValueResponse>("secureGet", SecureKey { key })
            .map(|response| response.value)
            .map_err(Into::into)
    }

    /// 删除 iOS Keychain 中的敏感值。
    pub fn secure_delete(&self, key: &str) -> crate::Result<()> {
        self.0
            .run_mobile_plugin::<()>("secureDelete", SecureKey { key })
            .map_err(Into::into)
    }

    /// 将安全作用域文档复制到应用私有缓存。
    pub fn import_document(&self, uri: &str, kind: &str) -> crate::Result<PathBuf> {
        self.0
            .run_mobile_plugin::<DocumentPathResponse>(
                "importDocument",
                ImportDocumentRequest { uri, kind },
            )
            .map(|response| PathBuf::from(response.path))
            .map_err(Into::into)
    }

    /// 将应用私有文件写入用户选择的安全作用域文档。
    pub fn export_document(&self, uri: &str, source_path: &str) -> crate::Result<()> {
        self.0
            .run_mobile_plugin::<()>("exportDocument", ExportDocumentRequest { uri, source_path })
            .map_err(Into::into)
    }
}
