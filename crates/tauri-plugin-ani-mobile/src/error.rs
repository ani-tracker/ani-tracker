use thiserror::Error;

/// 移动平台端口初始化或原生调用失败。
#[derive(Debug, Error)]
pub enum Error {
    #[cfg(target_os = "android")]
    #[error(transparent)]
    PluginInvoke(#[from] tauri::plugin::mobile::PluginInvokeError),
    #[error("当前平台不提供移动端原生能力")]
    UnsupportedPlatform,
}

pub type Result<T> = std::result::Result<T, Error>;
