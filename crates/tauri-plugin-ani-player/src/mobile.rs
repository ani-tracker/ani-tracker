use serde::de::DeserializeOwned;
use tauri::{plugin::PluginApi, AppHandle, Manager, Runtime};

/// 移动播放器插件句柄；原生 transport 在 Android/iOS 阶段装配。
pub struct AniPlayer<R: Runtime>(AppHandle<R>);

/// 从任意 Tauri Manager 读取移动播放器插件句柄。
pub trait AniPlayerExt<R: Runtime> {
    /// 返回当前宿主持有的平台播放器插件。
    fn ani_player(&self) -> &AniPlayer<R>;
}

impl<R: Runtime, T: Manager<R>> AniPlayerExt<R> for T {
    fn ani_player(&self) -> &AniPlayer<R> {
        self.state::<AniPlayer<R>>().inner()
    }
}

/// 注册移动插件；具体 Kotlin/Swift 句柄在对应平台实现中补齐。
pub fn init<R: Runtime, C: DeserializeOwned>(
    app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> crate::Result<AniPlayer<R>> {
    Ok(AniPlayer(app.clone()))
}

impl<R: Runtime> AniPlayer<R> {
    /// 返回移动 Tauri 宿主句柄。
    pub fn app_handle(&self) -> &AppHandle<R> {
        &self.0
    }
}
