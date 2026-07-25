use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

#[cfg(desktop)]
mod desktop;
#[cfg(mobile)]
mod mobile;

mod error;
mod transport;

pub use error::{Error, Result};
pub use transport::{MobileTorrentCoreTransport, NativeTorrentCoreStatus};

#[cfg(desktop)]
pub use desktop::AniTorrent;
#[cfg(mobile)]
pub use mobile::AniTorrent;

/// 从 Tauri Manager 读取已装配的移动 torrent 插件。
pub trait AniTorrentExt<R: Runtime> {
    /// 返回当前宿主持有的平台插件句柄。
    fn ani_torrent(&self) -> &AniTorrent<R>;
}

impl<R: Runtime, T: Manager<R>> crate::AniTorrentExt<R> for T {
    fn ani_torrent(&self) -> &AniTorrent<R> {
        self.state::<AniTorrent<R>>().inner()
    }
}

/// 初始化内部插件；不向 Renderer 暴露原生 NDJSON 调用。
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("ani-torrent")
        .setup(|app, api| {
            #[cfg(mobile)]
            let ani_torrent = mobile::init(app, api)?;
            #[cfg(desktop)]
            let ani_torrent = desktop::init(app, api)?;
            app.manage(ani_torrent);
            Ok(())
        })
        .build()
}
