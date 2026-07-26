use std::path::PathBuf;

use serde::de::DeserializeOwned;
use tauri::{plugin::PluginApi, AppHandle, Runtime};

use crate::{MobileNavigationIntent, MobilePlatformStatus};

/// 为非 Android 构建装配无原生依赖的兼容状态。
pub fn init<R: Runtime, C: DeserializeOwned>(
    app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> crate::Result<AniMobile<R>> {
    Ok(AniMobile(app.clone()))
}

/// 桌面平台的兼容句柄；移动原生能力在对应平台模块实现。
pub struct AniMobile<R: Runtime>(AppHandle<R>);

impl<R: Runtime> AniMobile<R> {
    /// 返回当前非移动宿主的稳定状态。
    pub fn status(&self) -> crate::Result<MobilePlatformStatus> {
        Ok(MobilePlatformStatus {
            lifecycle: "foreground".to_owned(),
            network: "unknown".to_owned(),
            metered: false,
            storage: "ok".to_owned(),
            available_bytes: 0,
            orientation: "unknown".to_owned(),
            notification_permission: "not-required".to_owned(),
        })
    }

    /// 非 Android 平台没有待处理的 Android 原生导航。
    pub fn consume_navigation(&self) -> crate::Result<Option<MobileNavigationIntent>> {
        Ok(None)
    }

    /// 非移动平台没有原生后台补跑标记。
    pub fn consume_background_refresh(&self) -> crate::Result<bool> {
        Ok(false)
    }

    /// 桌面外链由宿主系统集成处理，不经过移动插件。
    pub fn open_external(&self, _url: &str) -> crate::Result<()> {
        Err(crate::Error::UnsupportedPlatform)
    }

    /// 拒绝在尚未实现的平台写入移动安全存储。
    pub fn secure_set(&self, _key: &str, _value: &str) -> crate::Result<()> {
        Err(crate::Error::UnsupportedPlatform)
    }

    /// 拒绝在尚未实现的平台读取移动安全存储。
    pub fn secure_get(&self, _key: &str) -> crate::Result<Option<String>> {
        Err(crate::Error::UnsupportedPlatform)
    }

    /// 拒绝在尚未实现的平台删除移动安全存储。
    pub fn secure_delete(&self, _key: &str) -> crate::Result<()> {
        Err(crate::Error::UnsupportedPlatform)
    }

    /// 非 Android 平台不处理 ContentResolver 文档。
    pub fn import_document(&self, _uri: &str, _kind: &str) -> crate::Result<PathBuf> {
        Err(crate::Error::UnsupportedPlatform)
    }

    /// 非 Android 平台不处理 ContentResolver 文档。
    pub fn export_document(&self, _uri: &str, _source_path: &str) -> crate::Result<()> {
        Err(crate::Error::UnsupportedPlatform)
    }
}
