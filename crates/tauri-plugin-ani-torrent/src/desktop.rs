use serde::de::DeserializeOwned;
use tauri::{plugin::PluginApi, AppHandle, Runtime};

/// 桌面构建占位句柄；桌面继续使用进程型 torrent-core transport。
pub fn init<R: Runtime, C: DeserializeOwned>(
    app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> crate::Result<AniTorrent<R>> {
    Ok(AniTorrent(app.clone()))
}

/// 保持插件在桌面工作区可编译，不暴露移动原生能力。
pub struct AniTorrent<R: Runtime>(AppHandle<R>);

impl<R: Runtime> AniTorrent<R> {
    /// 返回桌面宿主句柄，仅用于证明插件已完成装配。
    pub fn app_handle(&self) -> &AppHandle<R> {
        &self.0
    }
}
