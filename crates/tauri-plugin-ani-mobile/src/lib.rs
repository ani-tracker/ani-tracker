use serde::{Deserialize, Serialize};
use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

#[cfg(target_os = "android")]
mod android;
mod error;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod fallback;
#[cfg(target_os = "ios")]
mod ios;

pub use error::{Error, Result};

#[cfg(target_os = "android")]
pub use android::AniMobile;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub use fallback::AniMobile;
#[cfg(target_os = "ios")]
pub use ios::AniMobile;

/// 原生端返回的移动运行状态，用于确定性处理生命周期与资源限制。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MobilePlatformStatus {
    pub lifecycle: String,
    pub network: String,
    pub metered: bool,
    pub storage: String,
    pub available_bytes: u64,
    pub orientation: String,
    pub notification_permission: String,
}

/// 原生通知或系统入口要求打开的应用内页面。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MobileNavigationIntent {
    pub page_id: String,
}

/// 从 Tauri Manager 读取已装配的移动平台插件。
pub trait AniMobileExt<R: Runtime> {
    /// 返回当前宿主持有的平台插件句柄。
    fn ani_mobile(&self) -> &AniMobile<R>;
}

impl<R: Runtime, T: Manager<R>> AniMobileExt<R> for T {
    fn ani_mobile(&self) -> &AniMobile<R> {
        self.state::<AniMobile<R>>().inner()
    }
}

/// 初始化移动平台插件；原生能力仅由 Rust 核心调用。
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("ani-mobile")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            let mobile = android::init(app, api)?;
            #[cfg(target_os = "ios")]
            let mobile = ios::init(app, api)?;
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            let mobile = fallback::init(app, api)?;
            app.manage(mobile);
            Ok(())
        })
        .build()
}
