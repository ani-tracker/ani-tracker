//! 桌面远程访问核心：HTTPS、配对认证、RPC、媒体代理与图片缓存。

mod auth;
mod gateway;
mod image_cache;
mod media;
mod network;
mod rpc;
mod tls;

pub use auth::{PairingResult, RemoteDeviceAuth, RemoteDeviceAuthError, RemoteSecretStore};
pub use gateway::{
    ByteRange, GatewayConfig, RemoteGateway, RemoteGatewayDependencies, RemoteGatewayError,
};
pub use image_cache::{ImageCache, ImageCacheAsset, ImageCacheError};
pub use media::{
    RemoteMediaAsset, RemoteMediaError, RemoteMediaRepository, RemoteMediaSessionService,
    RemoteMediaTools,
};
pub use network::{
    is_private_ipv4, list_private_ipv4_addresses, parse_trusted_origins, TrustedOrigin,
};
pub use rpc::{RemoteRpcError, RemoteRpcHandler, RemoteRpcService};
pub use tls::{RemoteTlsBundle, RemoteTlsCertificateStore};
