use ani_contracts::{
    AppCommandError, ImageCacheResolveResult, RemoteGatewayStatus, RemotePairingChallenge,
};
use tauri::AppHandle;

/// 将远程网关错误转换为稳定命令错误。
fn map_remote_error(action: &str, error: impl std::fmt::Display) -> AppCommandError {
    log::error!("Tauri 远程网关命令失败 action={action} error={error}");
    AppCommandError {
        code: "remote_gateway_operation_failed".to_owned(),
        message: format!("{action}失败：{error}"),
    }
}

/// 读取桌面远程网关、证书和已配对设备状态。
#[tauri::command]
pub(crate) async fn get_remote_gateway_status(
    app: AppHandle,
) -> Result<RemoteGatewayStatus, AppCommandError> {
    #[cfg(desktop)]
    {
        use tauri::Manager;

        let state = app
            .try_state::<crate::remote::AppRemoteGatewayState>()
            .ok_or_else(|| map_remote_error("读取远程网关状态", "远程网关状态未装配"))?;
        Ok(state.status().await)
    }
    #[cfg(not(desktop))]
    {
        let _ = app;
        Err(map_remote_error(
            "读取远程网关状态",
            "移动端不包含远程 Web 网关",
        ))
    }
}

/// 创建两分钟有效的一次性桌面远程配对码。
#[tauri::command]
pub(crate) async fn create_remote_pairing_code(
    app: AppHandle,
) -> Result<RemotePairingChallenge, AppCommandError> {
    #[cfg(desktop)]
    {
        use tauri::Manager;

        let state = app
            .try_state::<crate::remote::AppRemoteGatewayState>()
            .ok_or_else(|| map_remote_error("创建远程配对码", "远程网关状态未装配"))?;
        state
            .create_pairing_code()
            .await
            .map_err(|error| map_remote_error("创建远程配对码", error))
    }
    #[cfg(not(desktop))]
    {
        let _ = app;
        Err(map_remote_error(
            "创建远程配对码",
            "移动端不包含远程 Web 网关",
        ))
    }
}

/// 吊销一个桌面远程设备及其令牌和媒体会话。
#[tauri::command]
pub(crate) async fn revoke_remote_device(
    device_id: String,
    app: AppHandle,
) -> Result<RemoteGatewayStatus, AppCommandError> {
    #[cfg(desktop)]
    {
        use tauri::Manager;

        let state = app
            .try_state::<crate::remote::AppRemoteGatewayState>()
            .ok_or_else(|| map_remote_error("吊销远程设备", "远程网关状态未装配"))?;
        state
            .revoke_device(&device_id)
            .await
            .map_err(|error| map_remote_error("吊销远程设备", error))
    }
    #[cfg(not(desktop))]
    {
        let _ = (device_id, app);
        Err(map_remote_error(
            "吊销远程设备",
            "移动端不包含远程 Web 网关",
        ))
    }
}

/// 为 Renderer 解析平台适用的图片地址。
#[tauri::command]
pub(crate) async fn resolve_cached_image_url(
    source_url: String,
    app: AppHandle,
) -> Result<ImageCacheResolveResult, AppCommandError> {
    #[cfg(desktop)]
    {
        let _ = app;
        let url = crate::image_cache::resolve_local_image_url(&source_url)
            .map_err(|error| map_remote_error("解析缓存图片地址", error))?;
        Ok(ImageCacheResolveResult { url })
    }
    #[cfg(not(desktop))]
    {
        let _ = app;
        let url = crate::image_cache::resolve_public_image_url(&source_url)
            .map_err(|error| map_remote_error("解析图片地址", error))?;
        Ok(ImageCacheResolveResult { url })
    }
}
