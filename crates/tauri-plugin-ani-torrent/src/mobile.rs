use serde::de::DeserializeOwned;
use tauri::{
    plugin::{PluginApi, PluginHandle},
    AppHandle, Runtime,
};

use crate::transport::{
    ExecuteRequest, ExecuteResponse, MobileTorrentBackend, MobileTorrentCoreTransport,
    NativeTorrentCoreStatus, ShutdownResponse,
};

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_ani_torrent);

/// 注册 Kotlin 或 Swift 插件并保留原生调用句柄。
pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> crate::Result<AniTorrent<R>> {
    #[cfg(target_os = "android")]
    let handle = api.register_android_plugin("dev.ani.tracker.torrent", "AniTorrentPlugin")?;
    #[cfg(target_os = "ios")]
    let handle = api.register_ios_plugin(init_plugin_ani_torrent)?;
    Ok(AniTorrent(handle))
}

/// Tauri 应用持有的移动原生 torrent-core 入口。
pub struct AniTorrent<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> AniTorrent<R> {
    /// 创建可注册到统一下载引擎的移动 transport。
    pub fn transport(&self) -> MobileTorrentCoreTransport {
        MobileTorrentCoreTransport::new(std::sync::Arc::new(PluginBackend {
            handle: self.0.clone(),
        }))
    }
}

struct PluginBackend<R: Runtime> {
    handle: PluginHandle<R>,
}

#[async_trait::async_trait]
impl<R: Runtime> MobileTorrentBackend for PluginBackend<R> {
    /// 将完整 NDJSON 请求交给平台插件串行执行。
    async fn execute(&self, request_json: String) -> Result<String, String> {
        self.handle
            .run_mobile_plugin_async::<ExecuteResponse>("execute", ExecuteRequest { request_json })
            .await
            .map(|response| response.response_json)
            .map_err(|error| error.to_string())
    }

    /// 查询原生 Service 或 iOS Session，不隐式创建核心。
    async fn status(&self) -> Result<NativeTorrentCoreStatus, String> {
        self.handle
            .run_mobile_plugin_async("status", ())
            .await
            .map_err(|error| error.to_string())
    }

    /// 请求平台保存恢复数据并结束当前原生 Session。
    async fn shutdown(&self) -> Result<(), String> {
        let response = self
            .handle
            .run_mobile_plugin_async::<ShutdownResponse>("shutdown", ())
            .await
            .map_err(|error| error.to_string())?;
        if response.stopped {
            Ok(())
        } else {
            Err("移动 torrent-core 未确认停止".to_owned())
        }
    }
}
