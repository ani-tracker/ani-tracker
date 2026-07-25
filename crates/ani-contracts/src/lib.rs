use serde::{Deserialize, Serialize};

/// 跨语言契约金样的版本化外层结构。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContractFixture<T> {
    pub schema_version: u32,
    pub kind: String,
    pub payload: T,
}

/// 无边框窗口控制区需要的最小窗口状态。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppWindowState {
    pub maximized: bool,
}

/// Tauri 命令返回给 Renderer 的稳定错误结构。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppCommandError {
    pub code: String,
    pub message: String,
}

/// 当前默认下载服务的实现模式。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DownloadServiceMode {
    Embedded,
    Managed,
    External,
}

/// 当前默认下载服务的健康状态。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DownloadServiceState {
    Online,
    Idle,
    Error,
}

/// 应用壳展示的统一下载服务状态。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadServiceStatus {
    pub mode: DownloadServiceMode,
    pub state: DownloadServiceState,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_count: Option<usize>,
}

/// 外部 qBittorrent 连接测试结果。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TorrentConnectionTestResult {
    pub ok: bool,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_count: Option<usize>,
}

/// 托管 qBittorrent-nox 的进程状态。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QbittorrentManagedStatus {
    pub enabled: bool,
    pub auto_start: bool,
    pub running: bool,
    pub web_ui_url: String,
    pub platform: String,
    pub arch: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub binary_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_dir: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_started_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_stopped_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
}

/// 内置 torrent-core 的进程和协议状态。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedTorrentCoreStatus {
    pub enabled: bool,
    pub running: bool,
    pub platform: String,
    pub arch: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub binary_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data_dir: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub foreground_service: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_count: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub listen_port: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_started_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_stopped_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
}

/// 单个桌面媒体工具的解析和版本状态。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaToolStatus {
    pub available: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// 桌面 FFprobe 与 FFmpeg 的统一可用状态。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopMediaToolsStatus {
    pub ffprobe: MediaToolStatus,
    pub ffmpeg: MediaToolStatus,
}

/// 播放器后端类型。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PlayerBackend {
    Artplayer,
    Libvlc,
}

/// 播放器所在的平台宿主。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PlayerHostPlatform {
    RemoteWeb,
    Electron,
    TauriDesktop,
    Android,
    Ios,
}

/// 播放器运行时可用状态。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PlayerAvailability {
    Unknown,
    Available,
    Unavailable,
}

/// 播放器生命周期与播放状态。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PlayerStatus {
    Idle,
    Loading,
    Ready,
    Buffering,
    Playing,
    Paused,
    Ended,
    Error,
    Closed,
}

/// 播放器错误的稳定分类。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PlayerErrorCode {
    ResourceUnavailable,
    Network,
    Decoder,
    Permission,
    Transcode,
    RuntimeMissing,
    Unsupported,
    Unknown,
}

/// 播放失败后可展示的恢复动作。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PlayerRecoveryAction {
    Retry,
    Transcode,
    Close,
}

/// 跨平台播放器的结构化错误。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerError {
    pub code: PlayerErrorCode,
    pub message: String,
    pub recoverable: bool,
    pub recovery_actions: Vec<PlayerRecoveryAction>,
}

/// 画面比例选项。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum PlayerAspectRatio {
    #[serde(rename = "default")]
    Default,
    #[serde(rename = "16:9")]
    Ratio16x9,
    #[serde(rename = "4:3")]
    Ratio4x3,
    #[serde(rename = "fill")]
    Fill,
    #[serde(rename = "fit")]
    Fit,
    #[serde(rename = "custom")]
    Custom,
}

/// 播放器稳定公开的能力集合。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerCapabilities {
    pub backend: PlayerBackend,
    pub platform: PlayerHostPlatform,
    pub availability: PlayerAvailability,
    pub can_seek: bool,
    pub can_set_volume: bool,
    pub can_mute: bool,
    pub playback_rates: Vec<f64>,
    pub supports_audio_tracks: bool,
    pub supports_subtitle_tracks: bool,
    pub supports_aspect_ratio: bool,
    pub supports_fullscreen: bool,
    pub supports_picture_in_picture: bool,
    pub supports_playlist_navigation: bool,
    pub supports_direct_playback: bool,
    pub supports_transcoding_fallback: bool,
    pub supports_hdr: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unavailable_reason: Option<String>,
}

/// 外挂字幕来源。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerSubtitleSource {
    pub id: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    #[serde(rename = "type")]
    pub subtitle_type: PlayerSubtitleType,
    pub uri: String,
    pub default: bool,
}

/// 播放器支持的字幕格式。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PlayerSubtitleType {
    Ass,
    Vtt,
}

/// 播放器加载的受控媒体来源。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerMediaSource {
    pub task_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_index: Option<u32>,
    pub title: String,
    pub uri: String,
    pub mode: PlayerMediaMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_seconds: Option<f64>,
    pub subtitles: Vec<PlayerSubtitleSource>,
}

/// 媒体交付模式。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PlayerMediaMode {
    Direct,
    Hls,
}

/// 音频或字幕轨道类型。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PlayerTrackKind {
    Audio,
    Subtitle,
}

/// 当前可选择的音频或字幕轨道。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerTrack {
    pub id: String,
    pub kind: PlayerTrackKind,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    pub selected: bool,
}

/// 播放列表中的单集。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerPlaylistItem {
    pub id: String,
    pub task_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_index: Option<u32>,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub episode_label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_seconds: Option<f64>,
}

/// 当前播放列表和活动项。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerPlaylist {
    pub items: Vec<PlayerPlaylistItem>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_item_id: Option<String>,
}

/// 播放器命令的公共信封，动作字段会平铺到 JSON 顶层。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerCommand {
    pub command_id: String,
    pub session_id: String,
    #[serde(flatten)]
    pub action: PlayerCommandAction,
}

/// 所有原生播放器后端必须识别的动作。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum PlayerCommandAction {
    Load {
        source: PlayerMediaSource,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        start_position_seconds: Option<f64>,
    },
    Play,
    Pause,
    Seek {
        position_seconds: f64,
    },
    SetVolume {
        volume: f64,
    },
    SetMuted {
        muted: bool,
    },
    SetRate {
        rate: f64,
    },
    SelectAudioTrack {
        track_id: String,
    },
    SelectSubtitleTrack {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        track_id: Option<String>,
    },
    SetAspectRatio {
        aspect_ratio: PlayerAspectRatio,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        value: Option<String>,
    },
    SetFullscreen {
        fullscreen: bool,
    },
    SetPictureInPicture {
        enabled: bool,
    },
    PreviousItem,
    NextItem,
    Retry,
    Close,
}

impl PlayerCommand {
    /// 返回动作的稳定短名，供日志和能力检查使用。
    pub fn action_name(&self) -> &'static str {
        match &self.action {
            PlayerCommandAction::Load { .. } => "load",
            PlayerCommandAction::Play => "play",
            PlayerCommandAction::Pause => "pause",
            PlayerCommandAction::Seek { .. } => "seek",
            PlayerCommandAction::SetVolume { .. } => "set-volume",
            PlayerCommandAction::SetMuted { .. } => "set-muted",
            PlayerCommandAction::SetRate { .. } => "set-rate",
            PlayerCommandAction::SelectAudioTrack { .. } => "select-audio-track",
            PlayerCommandAction::SelectSubtitleTrack { .. } => "select-subtitle-track",
            PlayerCommandAction::SetAspectRatio { .. } => "set-aspect-ratio",
            PlayerCommandAction::SetFullscreen { .. } => "set-fullscreen",
            PlayerCommandAction::SetPictureInPicture { .. } => "set-picture-in-picture",
            PlayerCommandAction::PreviousItem => "previous-item",
            PlayerCommandAction::NextItem => "next-item",
            PlayerCommandAction::Retry => "retry",
            PlayerCommandAction::Close => "close",
        }
    }
}

/// 原生播放器对单条命令的结构化响应。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerCommandResult {
    pub command_id: String,
    pub accepted: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<PlayerError>,
}

/// 跨平台播放器的完整状态快照。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerSnapshot {
    pub session_id: String,
    pub sequence: u64,
    pub backend: PlayerBackend,
    pub platform: PlayerHostPlatform,
    pub status: PlayerStatus,
    pub capabilities: PlayerCapabilities,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<PlayerMediaSource>,
    pub playlist: PlayerPlaylist,
    pub position_seconds: f64,
    pub duration_seconds: f64,
    pub buffered_seconds: f64,
    pub volume: f64,
    pub muted: bool,
    pub playback_rate: f64,
    pub audio_tracks: Vec<PlayerTrack>,
    pub subtitle_tracks: Vec<PlayerTrack>,
    pub aspect_ratio: PlayerAspectRatio,
    pub fullscreen: bool,
    pub picture_in_picture: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<PlayerError>,
}

/// 创建桌面播放器窗口时使用的受限目标。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopPlayerWindowInput {
    pub task_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_index: Option<u32>,
}

/// 桌面透明控制层发送的受限窗口拖动阶段。
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "phase",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub enum DesktopPlayerWindowDragInput {
    Start { screen_x: f64, screen_y: f64 },
    Move { screen_x: f64, screen_y: f64 },
    End,
}

/// 创建受控播放会话时使用的下载文件目标。
pub type DesktopPlaybackSessionInput = DesktopPlayerWindowInput;

/// 播放器可加载的一条受控字幕资源。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackSubtitle {
    pub id: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    #[serde(rename = "type")]
    pub subtitle_type: PlayerSubtitleType,
    pub url: String,
    pub default: bool,
}

/// Renderer 获取的受控播放会话，不泄漏真实本地路径。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackSession {
    pub id: String,
    pub task_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_index: Option<u32>,
    pub file_name: String,
    pub mode: PlayerMediaMode,
    pub stream_url: String,
    pub expires_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_seconds: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_position_seconds: Option<f64>,
    pub subtitles: Vec<PlaybackSubtitle>,
}

#[cfg(test)]
mod tests {
    use serde::Deserialize;

    use super::{
        ContractFixture, DesktopMediaToolsStatus, DownloadServiceMode, DownloadServiceState,
        DownloadServiceStatus, EmbeddedTorrentCoreStatus, PlaybackSession, PlayerCommand,
        PlayerCommandAction, PlayerCommandResult, PlayerHostPlatform, PlayerSnapshot, PlayerStatus,
        QbittorrentManagedStatus, TorrentConnectionTestResult,
    };

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct DownloadServiceFixture {
        service_status: DownloadServiceStatus,
        connection_test: TorrentConnectionTestResult,
        managed_status: QbittorrentManagedStatus,
        embedded_status: EmbeddedTorrentCoreStatus,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct MediaFixture {
        media_tools_status: DesktopMediaToolsStatus,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct MobileTorrentLifecycleFixture {
        android_status: EmbeddedTorrentCoreStatus,
        ios_status: EmbeddedTorrentCoreStatus,
        execute_request: serde_json::Value,
        execute_response: serde_json::Value,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct PlayerCommandFixture {
        load_command: PlayerCommand,
        rejected_result: PlayerCommandResult,
        playback_session: PlaybackSession,
    }

    /// 验证 Rust 能严格解码前端共用的播放器快照金样。
    #[test]
    fn decodes_player_snapshot_fixture() {
        let fixture = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../fixtures/contracts/player-snapshot.v1.json"
        ));
        let decoded: ContractFixture<PlayerSnapshot> =
            serde_json::from_str(fixture).expect("player snapshot fixture must decode");

        assert_eq!(decoded.schema_version, 1);
        assert_eq!(decoded.kind, "player-snapshot");
        assert_eq!(decoded.payload.platform, PlayerHostPlatform::TauriDesktop);
        assert_eq!(decoded.payload.status, PlayerStatus::Playing);
        assert_eq!(decoded.payload.sequence, 7);
        assert_eq!(decoded.payload.audio_tracks.len(), 2);
        assert_eq!(decoded.payload.subtitle_tracks.len(), 1);
    }

    /// 验证 Rust 能严格解码下载服务、托管进程和内置核心状态金样。
    #[test]
    fn decodes_download_service_fixture() {
        let fixture = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../fixtures/contracts/p4-download-service-model.v1.json"
        ));
        let decoded: ContractFixture<DownloadServiceFixture> =
            serde_json::from_str(fixture).expect("download service fixture must decode");

        assert_eq!(decoded.schema_version, 1);
        assert_eq!(decoded.kind, "p4-download-service-model");
        assert_eq!(
            decoded.payload.service_status.mode,
            DownloadServiceMode::Managed
        );
        assert_eq!(
            decoded.payload.service_status.state,
            DownloadServiceState::Online
        );
        assert!(decoded.payload.connection_test.ok);
        assert!(decoded.payload.managed_status.running);
        assert_eq!(decoded.payload.embedded_status.listen_port, Some(6881));
    }

    /// 验证 Rust 能解码桌面 FFprobe 与 FFmpeg 状态金样。
    #[test]
    fn decodes_media_tools_fixture() {
        let fixture = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../fixtures/contracts/p4-media-model.v1.json"
        ));
        let decoded: ContractFixture<MediaFixture> =
            serde_json::from_str(fixture).expect("media tools fixture must decode");

        assert_eq!(decoded.schema_version, 1);
        assert_eq!(decoded.kind, "p4-media-model");
        assert!(decoded.payload.media_tools_status.ffprobe.available);
        assert!(decoded.payload.media_tools_status.ffmpeg.available);
    }

    /// 验证 Android 前台服务与 iOS Session 使用同一生命周期契约。
    #[test]
    fn decodes_mobile_torrent_lifecycle_fixture() {
        let fixture = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../fixtures/contracts/p4-mobile-torrent-lifecycle.v1.json"
        ));
        let decoded: ContractFixture<MobileTorrentLifecycleFixture> =
            serde_json::from_str(fixture).expect("mobile torrent fixture must decode");

        assert_eq!(decoded.schema_version, 1);
        assert_eq!(decoded.kind, "p4-mobile-torrent-lifecycle");
        assert_eq!(
            decoded.payload.android_status.foreground_service,
            Some(true)
        );
        assert_eq!(decoded.payload.ios_status.foreground_service, Some(false));
        assert_eq!(decoded.payload.execute_request["method"], "listTasks");
        assert_eq!(decoded.payload.execute_response["ok"], "true");
    }

    /// 验证 Rust 与 TypeScript 共用平铺播放器命令和受控会话字段。
    #[test]
    fn decodes_player_command_fixture() {
        let fixture = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../fixtures/contracts/p5-player-command.v1.json"
        ));
        let decoded: ContractFixture<PlayerCommandFixture> =
            serde_json::from_str(fixture).expect("player command fixture must decode");

        assert_eq!(decoded.schema_version, 1);
        assert_eq!(decoded.kind, "p5-player-command");
        assert!(matches!(
            &decoded.payload.load_command.action,
            PlayerCommandAction::Load { .. }
        ));
        assert_eq!(decoded.payload.load_command.action_name(), "load");
        assert!(!decoded.payload.rejected_result.accepted);
        assert_eq!(decoded.payload.playback_session.file_index, Some(0));
    }
}
