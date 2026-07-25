use std::sync::Arc;

use ani_contracts::{PlayerCapabilities, PlayerCommand, PlayerCommandResult, PlayerSnapshot};
use ani_media::player::{PlayerTransport, PlayerTransportError};
use async_trait::async_trait;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use tauri::{
    plugin::{PluginApi, PluginHandle},
    AppHandle, Manager, Runtime,
};

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_ani_player);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DispatchRequest {
    command_json: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DispatchResponse {
    result_json: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CapabilitiesResponse {
    capabilities_json: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotResponse {
    #[serde(default)]
    snapshot_json: Option<String>,
}

#[derive(Deserialize)]
struct ShutdownResponse {
    stopped: bool,
}

/// 注册 Kotlin 或 Swift 播放器插件并保留原生调用句柄。
pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> crate::Result<AniPlayer<R>> {
    #[cfg(target_os = "android")]
    let handle = api.register_android_plugin("dev.ani.tracker.player", "AniPlayerPlugin")?;
    #[cfg(target_os = "ios")]
    let handle = api.register_ios_plugin(init_plugin_ani_player)?;
    Ok(AniPlayer(handle))
}

/// Tauri 应用持有的移动原生 libVLC 入口。
pub struct AniPlayer<R: Runtime>(PluginHandle<R>);

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

impl<R: Runtime> AniPlayer<R> {
    /// 创建可装配到统一 PlayerService 的移动 transport。
    pub fn transport(&self) -> Arc<dyn PlayerTransport> {
        Arc::new(MobilePlayerTransport {
            handle: self.0.clone(),
        })
    }
}

struct MobilePlayerTransport<R: Runtime> {
    handle: PluginHandle<R>,
}

#[async_trait]
impl<R: Runtime> PlayerTransport for MobilePlayerTransport<R> {
    /// 从原生 SDK 返回移动平台实际支持的播放器能力。
    async fn capabilities(&self) -> Result<PlayerCapabilities, PlayerTransportError> {
        let response = self
            .handle
            .run_mobile_plugin_async::<CapabilitiesResponse>("capabilities", ())
            .await
            .map_err(native_error)?;
        decode_json(&response.capabilities_json, "播放器能力")
    }

    /// 将已解析真实路径的命令交给 Kotlin 或 Swift 串行执行。
    async fn dispatch(
        &self,
        command: PlayerCommand,
    ) -> Result<PlayerCommandResult, PlayerTransportError> {
        let command_json = serde_json::to_string(&command).map_err(|error| {
            PlayerTransportError::InvalidResponse(format!("序列化播放器命令失败：{error}"))
        })?;
        let response = self
            .handle
            .run_mobile_plugin_async::<DispatchResponse>(
                "dispatch",
                DispatchRequest { command_json },
            )
            .await
            .map_err(native_error)?;
        decode_json(&response.result_json, "播放器命令结果")
    }

    /// 读取原生播放器完整快照；未打开 Activity/ViewController 时返回空。
    async fn snapshot(&self) -> Result<Option<PlayerSnapshot>, PlayerTransportError> {
        let response = self
            .handle
            .run_mobile_plugin_async::<SnapshotResponse>("snapshot", ())
            .await
            .map_err(native_error)?;
        response
            .snapshot_json
            .as_deref()
            .map(|value| decode_json(value, "播放器快照"))
            .transpose()
    }

    /// 请求原生播放器停止媒体并幂等释放会话。
    async fn shutdown(&self) -> Result<(), PlayerTransportError> {
        let response = self
            .handle
            .run_mobile_plugin_async::<ShutdownResponse>("shutdown", ())
            .await
            .map_err(native_error)?;
        if response.stopped {
            Ok(())
        } else {
            Err(PlayerTransportError::InvalidResponse(
                "移动播放器未确认停止".to_owned(),
            ))
        }
    }
}

fn decode_json<T: DeserializeOwned>(value: &str, label: &str) -> Result<T, PlayerTransportError> {
    serde_json::from_str(value).map_err(|error| {
        PlayerTransportError::InvalidResponse(format!("{label}不是有效 JSON：{error}"))
    })
}

fn native_error(error: impl std::fmt::Display) -> PlayerTransportError {
    PlayerTransportError::Native(error.to_string())
}
