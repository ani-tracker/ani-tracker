use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use ani_contracts::{
    DesktopPlaybackSessionInput, DesktopPlayerWindowInput, PlaybackSession, PlaybackSubtitle,
    PlayerAvailability, PlayerBackend, PlayerCapabilities, PlayerCommand, PlayerCommandAction,
    PlayerCommandResult, PlayerHostPlatform, PlayerMediaMode, PlayerSubtitleType,
};
use ani_domain::{DownloadTask, TorrentFile};
use ani_media::player::PlayerService;
use ani_repository::{DownloadRepository, MediaRepository, PlaybackRepository};
use ani_storage::Storage;
use chrono::{Duration as ChronoDuration, SecondsFormat, Utc};
use tauri::window::{Color, WindowBuilder};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, Runtime, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder, Window, WindowEvent,
};
use tauri_plugin_ani_player::{AniPlayerExt, DesktopVideoTarget, DesktopWindowController};
use tokio::sync::RwLock;

pub(crate) const PLAYER_CONTROL_WINDOW_LABEL: &str = "ani-player-controls";
const PLAYER_VIDEO_WINDOW_LABEL: &str = "ani-player-video";
pub(crate) const PLAYER_SNAPSHOT_EVENT: &str = "player-snapshot";
const PLAYER_WINDOW_WIDTH: f64 = 1120.0;
const PLAYER_WINDOW_HEIGHT: f64 = 630.0;
const SESSION_TTL_HOURS: i64 = 4;

#[derive(Clone)]
struct ResolvedPlaybackSession {
    public: PlaybackSession,
    media_path: PathBuf,
    subtitle_paths: HashMap<String, PathBuf>,
    expires_at: SystemTime,
}

/// Tauri 生命周期内共享的播放窗口、受控会话和平台 transport。
#[derive(Clone)]
pub(crate) struct AppPlayerState {
    app: AppHandle,
    storage: Arc<Mutex<Storage>>,
    service: Arc<RwLock<Option<Arc<PlayerService>>>>,
    sessions: Arc<Mutex<HashMap<String, ResolvedPlaybackSession>>>,
    id_sequence: Arc<AtomicU64>,
    poll_generation: Arc<AtomicU64>,
}

impl AppPlayerState {
    /// 创建尚未打开媒体窗口的播放器状态。
    pub(crate) fn new(app: &AppHandle, storage: Arc<Mutex<Storage>>) -> Self {
        Self {
            app: app.clone(),
            storage,
            service: Arc::new(RwLock::new(None)),
            sessions: Arc::new(Mutex::new(HashMap::new())),
            id_sequence: Arc::new(AtomicU64::new(0)),
            poll_generation: Arc::new(AtomicU64::new(0)),
        }
    }

    /// 创建视频原生窗口与透明控制层，并装配当前平台 libVLC transport。
    #[cfg(desktop)]
    pub(crate) async fn open_desktop_window(
        &self,
        input: DesktopPlayerWindowInput,
    ) -> Result<(), String> {
        validate_player_target(&input)?;
        self.close_desktop_window().await?;

        let video = WindowBuilder::new(&self.app, PLAYER_VIDEO_WINDOW_LABEL)
            .title("Ani Tracker Player Video")
            .inner_size(PLAYER_WINDOW_WIDTH, PLAYER_WINDOW_HEIGHT)
            .min_inner_size(640.0, 360.0)
            .decorations(false)
            .background_color(Color(0, 0, 0, 255))
            .visible(false)
            .build()
            .map_err(|error| format!("创建 libVLC 视频窗口失败：{error}"))?;
        video
            .center()
            .map_err(|error| format!("定位 libVLC 视频窗口失败：{error}"))?;

        let route = player_route(&input);
        let controls = match WebviewWindowBuilder::new(
            &self.app,
            PLAYER_CONTROL_WINDOW_LABEL,
            WebviewUrl::App(route.into()),
        )
        .title("Ani Tracker Player")
        .inner_size(PLAYER_WINDOW_WIDTH, PLAYER_WINDOW_HEIGHT)
        .min_inner_size(640.0, 360.0)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .visible(false)
        .build()
        {
            Ok(window) => window,
            Err(error) => {
                let _ = video.close();
                return Err(format!("创建 libVLC 控制层失败：{error}"));
            }
        };
        sync_window_bounds(&video, &controls)?;

        let target = resolve_video_target(&video)?;
        let controller = Arc::new(TauriPlayerWindowController {
            app: self.app.clone(),
        });
        let transport = self
            .app
            .ani_player()
            .create_desktop_transport(target, controller);
        *self.service.write().await = Some(Arc::new(PlayerService::new(transport)));
        self.start_snapshot_polling();

        video
            .show()
            .map_err(|error| format!("显示 libVLC 视频窗口失败：{error}"))?;
        controls
            .show()
            .map_err(|error| format!("显示 libVLC 控制层失败：{error}"))?;
        controls
            .set_focus()
            .map_err(|error| format!("聚焦 libVLC 控制层失败：{error}"))?;
        log::info!(
            "Tauri 桌面播放器窗口已打开 task_id={} file_index={:?}",
            input.task_id,
            input.file_index
        );
        Ok(())
    }

    /// 关闭桌面播放器窗口并幂等释放 libVLC。
    pub(crate) async fn close_desktop_window(&self) -> Result<(), String> {
        self.poll_generation.fetch_add(1, Ordering::SeqCst);
        if let Some(service) = self.service.write().await.take() {
            service
                .shutdown()
                .await
                .map_err(|error| error.to_string())?;
        }
        if let Some(window) = self.app.get_webview_window(PLAYER_CONTROL_WINDOW_LABEL) {
            window
                .close()
                .map_err(|error| format!("关闭播放器控制层失败：{error}"))?;
        }
        if let Some(window) = self.app.get_window(PLAYER_VIDEO_WINDOW_LABEL) {
            window
                .close()
                .map_err(|error| format!("关闭播放器视频窗口失败：{error}"))?;
        }
        Ok(())
    }

    /// 将播放器控制层拖动委托给当前 Tauri 窗口。
    pub(crate) fn start_dragging(&self) -> Result<(), String> {
        let window = self
            .app
            .get_webview_window(PLAYER_CONTROL_WINDOW_LABEL)
            .ok_or_else(|| "播放器控制层不存在".to_owned())?;
        window
            .start_dragging()
            .map_err(|error| format!("拖动播放器窗口失败：{error}"))
    }
}

struct TauriPlayerWindowController {
    app: AppHandle,
}

impl DesktopWindowController for TauriPlayerWindowController {
    fn set_fullscreen(&self, fullscreen: bool) -> Result<bool, String> {
        let video = self
            .app
            .get_window(PLAYER_VIDEO_WINDOW_LABEL)
            .ok_or_else(|| "播放器视频窗口不存在".to_owned())?;
        let controls = self
            .app
            .get_webview_window(PLAYER_CONTROL_WINDOW_LABEL)
            .ok_or_else(|| "播放器控制层不存在".to_owned())?;
        video
            .set_fullscreen(fullscreen)
            .map_err(|error| format!("切换视频窗口全屏失败：{error}"))?;
        controls
            .set_fullscreen(fullscreen)
            .map_err(|error| format!("切换控制层全屏失败：{error}"))?;
        Ok(fullscreen)
    }

    fn close(&self) -> Result<(), String> {
        if let Some(window) = self.app.get_webview_window(PLAYER_CONTROL_WINDOW_LABEL) {
            window
                .close()
                .map_err(|error| format!("关闭播放器控制层失败：{error}"))?;
        }
        if let Some(window) = self.app.get_window(PLAYER_VIDEO_WINDOW_LABEL) {
            window
                .close()
                .map_err(|error| format!("关闭播放器视频窗口失败：{error}"))?;
        }
        Ok(())
    }
}

fn validate_player_target(input: &DesktopPlayerWindowInput) -> Result<(), String> {
    validate_identifier(&input.task_id, true)
}

fn validate_identifier(value: &str, allow_colon: bool) -> Result<(), String> {
    let valid = !value.is_empty()
        && value.len() <= 160
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric()
                || matches!(byte, b'_' | b'-' | b'.')
                || (allow_colon && byte == b':')
        });
    if valid {
        Ok(())
    } else {
        Err("播放器标识无效".to_owned())
    }
}

fn player_route(input: &DesktopPlayerWindowInput) -> String {
    let mut route = format!("index.html?aniView=desktop-player&taskId={}", input.task_id);
    if let Some(file_index) = input.file_index {
        route.push_str(&format!("&fileIndex={file_index}"));
    }
    route
}

fn select_playable_file(
    task: &DownloadTask,
    requested_index: Option<u32>,
) -> Result<&TorrentFile, String> {
    task.files
        .iter()
        .filter(|file| file.selected && (task.is_completed() || file.progress >= 1.0))
        .filter(|file| is_video_path(&file.name))
        .find(|file| requested_index.map_or(true, |index| file.index == i64::from(index)))
        .ok_or_else(|| "当前任务没有已完成的可播放视频".to_owned())
}

fn resolve_task_file_path(task: &DownloadTask, file: &TorrentFile) -> Result<PathBuf, String> {
    let file_path = Path::new(&file.name);
    let unresolved = if file_path.is_absolute() {
        file_path.to_path_buf()
    } else {
        Path::new(&task.save_path).join(file_path)
    };
    let resolved =
        std::fs::canonicalize(&unresolved).map_err(|error| format!("播放文件不可访问：{error}"))?;
    if !file_path.is_absolute() {
        let root = std::fs::canonicalize(&task.save_path)
            .map_err(|error| format!("下载目录不可访问：{error}"))?;
        if !resolved.starts_with(root) {
            return Err("播放文件路径超出任务保存目录".to_owned());
        }
    }
    Ok(resolved)
}

fn discover_sidecar_subtitles(
    session_id: &str,
    media_path: &Path,
) -> (Vec<PlaybackSubtitle>, HashMap<String, PathBuf>) {
    let Some(directory) = media_path.parent() else {
        return (Vec::new(), HashMap::new());
    };
    let media_stem = media_path
        .file_stem()
        .map(|value| value.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let mut candidates = std::fs::read_dir(directory)
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            let extension = path
                .extension()
                .map(|value| value.to_string_lossy().to_lowercase());
            let stem = path
                .file_stem()
                .map(|value| value.to_string_lossy().to_lowercase())
                .unwrap_or_default();
            matches!(extension.as_deref(), Some("ass" | "vtt")) && stem.starts_with(&media_stem)
        })
        .take(32)
        .collect::<Vec<_>>();
    candidates.sort();
    let mut subtitles = Vec::new();
    let mut paths = HashMap::new();
    for (index, path) in candidates.into_iter().enumerate() {
        let id = format!("subtitle-{session_id}-{index}");
        let extension = path
            .extension()
            .map(|value| value.to_string_lossy().to_lowercase())
            .unwrap_or_else(|| "vtt".to_owned());
        subtitles.push(PlaybackSubtitle {
            id: id.clone(),
            label: path
                .file_name()
                .map(|value| value.to_string_lossy().into_owned())
                .unwrap_or_else(|| format!("字幕 {}", index + 1)),
            language: None,
            subtitle_type: if extension == "ass" {
                PlayerSubtitleType::Ass
            } else {
                PlayerSubtitleType::Vtt
            },
            url: format!("ani-player://session/{session_id}/subtitle/{index}"),
            default: index == 0,
        });
        paths.insert(id, path);
    }
    (subtitles, paths)
}

fn same_path(left: &Path, right: &Path) -> bool {
    let left = std::fs::canonicalize(left).unwrap_or_else(|_| left.to_path_buf());
    let right = std::fs::canonicalize(right).unwrap_or_else(|_| right.to_path_buf());
    if cfg!(target_os = "windows") {
        left.to_string_lossy()
            .eq_ignore_ascii_case(&right.to_string_lossy())
    } else {
        left == right
    }
}

fn is_video_path(value: &str) -> bool {
    let value = value.to_lowercase();
    [".mkv", ".mp4", ".avi", ".mov", ".webm"]
        .iter()
        .any(|extension| value.ends_with(extension))
}

fn sync_window_bounds<R: Runtime>(
    video: &Window<R>,
    controls: &WebviewWindow<R>,
) -> Result<(), String> {
    let position: PhysicalPosition<i32> = video
        .outer_position()
        .map_err(|error| format!("读取视频窗口位置失败：{error}"))?;
    let size: PhysicalSize<u32> = video
        .inner_size()
        .map_err(|error| format!("读取视频窗口尺寸失败：{error}"))?;
    controls
        .set_position(position)
        .map_err(|error| format!("同步控制层位置失败：{error}"))?;
    controls
        .set_size(size)
        .map_err(|error| format!("同步控制层尺寸失败：{error}"))
}

#[cfg(target_os = "windows")]
fn resolve_video_target(video: &Window) -> Result<DesktopVideoTarget, String> {
    let hwnd = video
        .hwnd()
        .map_err(|error| format!("读取播放器 HWND 失败：{error}"))?;
    Ok(DesktopVideoTarget::Windows(hwnd.0 as isize))
}

#[cfg(target_os = "macos")]
fn resolve_video_target(video: &Window) -> Result<DesktopVideoTarget, String> {
    video
        .ns_view()
        .map(|view| DesktopVideoTarget::MacOs(view as usize))
        .map_err(|error| format!("读取播放器 NSView 失败：{error}"))
}

#[cfg(target_os = "linux")]
fn resolve_video_target(video: &Window) -> Result<DesktopVideoTarget, String> {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};

    match video
        .window_handle()
        .map_err(|error| format!("读取播放器 X11 窗口失败：{error}"))?
        .as_raw()
    {
        RawWindowHandle::Xlib(handle) => Ok(DesktopVideoTarget::X11(handle.window as u32)),
        RawWindowHandle::Xcb(handle) => Ok(DesktopVideoTarget::X11(handle.window.get())),
        _ => Err("Linux 首期仅支持 X11/XWayland 播放窗口".to_owned()),
    }
}

fn unavailable_capabilities(reason: String) -> PlayerCapabilities {
    PlayerCapabilities {
        backend: PlayerBackend::Libvlc,
        platform: PlayerHostPlatform::TauriDesktop,
        availability: PlayerAvailability::Unavailable,
        can_seek: false,
        can_set_volume: false,
        can_mute: false,
        playback_rates: vec![1.0],
        supports_audio_tracks: false,
        supports_subtitle_tracks: false,
        supports_aspect_ratio: false,
        supports_fullscreen: false,
        supports_picture_in_picture: false,
        supports_playlist_navigation: false,
        supports_direct_playback: false,
        supports_transcoding_fallback: false,
        supports_hdr: false,
        unavailable_reason: Some(reason),
    }
}

fn rejected_command(command_id: &str, message: String) -> PlayerCommandResult {
    PlayerCommandResult {
        command_id: command_id.to_owned(),
        accepted: false,
        error: Some(ani_contracts::PlayerError {
            code: ani_contracts::PlayerErrorCode::ResourceUnavailable,
            message,
            recoverable: true,
            recovery_actions: vec![
                ani_contracts::PlayerRecoveryAction::Retry,
                ani_contracts::PlayerRecoveryAction::Close,
            ],
        }),
    }
}

impl AppPlayerState {
    /// 为下载文件创建不泄漏真实路径的短期播放会话。
    pub(crate) fn create_session(
        &self,
        input: DesktopPlaybackSessionInput,
    ) -> Result<PlaybackSession, String> {
        validate_player_target(&input)?;
        self.prune_expired_sessions()?;
        let storage = self
            .storage
            .lock()
            .map_err(|error| format!("读取播放器数据失败：{error}"))?;
        let repository = storage.repository();
        let task = repository
            .list_downloads()
            .map_err(|error| error.to_string())?
            .into_iter()
            .find(|task| task.id == input.task_id)
            .ok_or_else(|| "播放任务不存在或已被删除".to_owned())?;
        let file = select_playable_file(&task, input.file_index)?;
        let file_index =
            u32::try_from(file.index).map_err(|_| "播放文件索引超出支持范围".to_owned())?;
        let file_name = file.name.clone();
        let media_path = resolve_task_file_path(&task, file)?;
        let media_files = repository
            .list_media_files()
            .map_err(|error| error.to_string())?;
        let duration_seconds = media_files
            .iter()
            .find(|media| {
                media.download_task_id.as_deref() == Some(task.id.as_str())
                    && same_path(Path::new(&media.file_path), &media_path)
            })
            .and_then(|media| media.duration_seconds)
            .map(|value| value as f64);
        let checkpoint = repository
            .get_playback_checkpoint(&task.id, Some(i64::from(file_index)))
            .map_err(|error| error.to_string())?;
        drop(storage);

        let session_id = self.next_session_id();
        let expires_at = SystemTime::now()
            .checked_add(Duration::from_secs((SESSION_TTL_HOURS * 60 * 60) as u64))
            .ok_or_else(|| "计算播放器会话有效期失败".to_owned())?;
        let (subtitles, subtitle_paths) = discover_sidecar_subtitles(&session_id, &media_path);
        let public = PlaybackSession {
            id: session_id.clone(),
            task_id: task.id.clone(),
            file_index: Some(file_index),
            file_name: media_path
                .file_name()
                .map(|value| value.to_string_lossy().into_owned())
                .unwrap_or(file_name),
            mode: PlayerMediaMode::Direct,
            stream_url: format!("ani-player://session/{session_id}/media"),
            expires_at: (Utc::now() + ChronoDuration::hours(SESSION_TTL_HOURS))
                .to_rfc3339_opts(SecondsFormat::Millis, true),
            duration_seconds,
            start_position_seconds: checkpoint
                .filter(|value| !value.completed)
                .map(|value| value.position_seconds),
            subtitles,
        };
        self.sessions
            .lock()
            .map_err(|error| format!("保存播放器会话失败：{error}"))?
            .insert(
                session_id,
                ResolvedPlaybackSession {
                    public: public.clone(),
                    media_path,
                    subtitle_paths,
                    expires_at,
                },
            );
        log::info!(
            "Tauri 受控播放会话已创建 session_id={} task_id={} file_index={}",
            public.id,
            public.task_id,
            file_index
        );
        Ok(public)
    }

    /// 删除指定受控会话及真实路径映射。
    pub(crate) fn close_session(&self, session_id: &str) -> Result<(), String> {
        validate_identifier(session_id, false)?;
        self.sessions
            .lock()
            .map_err(|error| format!("关闭播放器会话失败：{error}"))?
            .remove(session_id);
        Ok(())
    }

    /// 返回当前平台播放器能力；窗口未打开时给出明确不可用状态。
    pub(crate) async fn capabilities(&self) -> PlayerCapabilities {
        let service = self.service.read().await.clone();
        match service {
            Some(service) => service.capabilities().await.unwrap_or_else(|error| {
                unavailable_capabilities(format!("读取 libVLC 能力失败：{error}"))
            }),
            None => unavailable_capabilities("播放器窗口尚未打开".to_owned()),
        }
    }

    /// 解析受控 URI 后将命令交给统一播放器服务。
    pub(crate) async fn dispatch(&self, mut command: PlayerCommand) -> PlayerCommandResult {
        if let PlayerCommandAction::Load { source, .. } = &mut command.action {
            if let Err(error) = self.resolve_source(&command.session_id, source) {
                return rejected_command(&command.command_id, error);
            }
        }
        let service = self.service.read().await.clone();
        match service {
            Some(service) => service.dispatch(command).await,
            None => rejected_command(&command.command_id, "播放器窗口尚未打开".to_owned()),
        }
    }

    /// 同步控制层移动与缩放，并在窗口销毁后回收播放器。
    pub(crate) fn handle_window_event<R: Runtime>(window: &Window<R>, event: &WindowEvent) {
        if window.label() != PLAYER_CONTROL_WINDOW_LABEL {
            return;
        }
        match event {
            WindowEvent::Moved(position) => {
                if let Some(video) = window.app_handle().get_window(PLAYER_VIDEO_WINDOW_LABEL) {
                    if let Err(error) = video.set_position(*position) {
                        log::warn!("同步 libVLC 视频窗口位置失败 error={error}");
                    }
                }
            }
            WindowEvent::Resized(size) => {
                if let Some(video) = window.app_handle().get_window(PLAYER_VIDEO_WINDOW_LABEL) {
                    if let Err(error) = video.set_size(*size) {
                        log::warn!("同步 libVLC 视频窗口尺寸失败 error={error}");
                    }
                }
            }
            WindowEvent::Destroyed => {
                let app = window.app_handle().clone();
                tauri::async_runtime::spawn(async move {
                    if let Some(state) = app.try_state::<AppPlayerState>() {
                        state.poll_generation.fetch_add(1, Ordering::SeqCst);
                        if let Some(service) = state.service.write().await.take() {
                            if let Err(error) = service.shutdown().await {
                                log::warn!("播放器窗口销毁后释放 libVLC 失败 error={error}");
                            }
                        }
                    }
                    if let Some(video) = app.get_window(PLAYER_VIDEO_WINDOW_LABEL) {
                        let _ = video.close();
                    }
                });
            }
            _ => {}
        }
    }

    /// 应用退出时关闭播放器和全部受控会话。
    pub(crate) async fn shutdown(&self) {
        if let Err(error) = self.close_desktop_window().await {
            log::warn!("Tauri 退出时关闭播放器失败 error={error}");
        }
        if let Ok(mut sessions) = self.sessions.lock() {
            sessions.clear();
        }
    }

    fn resolve_source(
        &self,
        session_id: &str,
        source: &mut ani_contracts::PlayerMediaSource,
    ) -> Result<(), String> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|error| format!("读取播放器会话失败：{error}"))?;
        if sessions
            .get(session_id)
            .is_some_and(|session| session.expires_at <= SystemTime::now())
        {
            sessions.remove(session_id);
            return Err("播放会话不存在或已过期".to_owned());
        }
        let session = sessions
            .get(session_id)
            .ok_or_else(|| "播放会话不存在或已过期".to_owned())?;
        if session.public.task_id != source.task_id
            || session.public.file_index != source.file_index
            || source.uri != session.public.stream_url
        {
            return Err("播放媒体与受控会话不匹配".to_owned());
        }
        source.uri = session.media_path.to_string_lossy().into_owned();
        for subtitle in &mut source.subtitles {
            let path = session
                .subtitle_paths
                .get(&subtitle.id)
                .ok_or_else(|| "外挂字幕不属于当前播放会话".to_owned())?;
            subtitle.uri = path.to_string_lossy().into_owned();
        }
        Ok(())
    }

    /// 清理超过有效期的路径映射，避免关闭异常时长期保留本地资源引用。
    fn prune_expired_sessions(&self) -> Result<(), String> {
        let now = SystemTime::now();
        self.sessions
            .lock()
            .map_err(|error| format!("清理播放器会话失败：{error}"))?
            .retain(|_, session| session.expires_at > now);
        Ok(())
    }

    fn start_snapshot_polling(&self) {
        let generation = self.poll_generation.fetch_add(1, Ordering::SeqCst) + 1;
        let state = self.clone();
        tauri::async_runtime::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_millis(250));
            loop {
                interval.tick().await;
                if state.poll_generation.load(Ordering::SeqCst) != generation {
                    break;
                }
                let Some(service) = state.service.read().await.clone() else {
                    break;
                };
                match service.snapshot().await {
                    Ok(Some(snapshot)) => {
                        if let Err(error) = state.app.emit_to(
                            PLAYER_CONTROL_WINDOW_LABEL,
                            PLAYER_SNAPSHOT_EVENT,
                            snapshot,
                        ) {
                            log::warn!("发布 libVLC 播放快照失败 error={error}");
                        }
                    }
                    Ok(None) => {}
                    Err(error) => log::warn!("读取 libVLC 播放快照失败 error={error}"),
                }
            }
        });
    }

    fn next_session_id(&self) -> String {
        let epoch = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        let sequence = self.id_sequence.fetch_add(1, Ordering::Relaxed) + 1;
        format!("tauri-{epoch}-{sequence}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 播放器路由只携带经过验证的任务和文件索引。
    #[test]
    fn builds_player_route() {
        let route = player_route(&DesktopPlayerWindowInput {
            task_id: "download-1".to_owned(),
            file_index: Some(3),
        });

        assert_eq!(
            route,
            "index.html?aniView=desktop-player&taskId=download-1&fileIndex=3"
        );
    }

    /// 播放器只接受已选择、已完成的视频文件。
    #[test]
    fn selects_completed_video_file() {
        let task = DownloadTask {
            id: "download-1".to_owned(),
            release_id: None,
            anime_id: None,
            episode_id: None,
            anime_title: None,
            episode_no: None,
            fansub_group_id: None,
            fansub_name: None,
            resolution: None,
            declared_video_codec: None,
            normalized_video_codec: None,
            bit_depth: None,
            subtitle_languages: Vec::new(),
            subtitle: None,
            correlation_tag: None,
            engine: ani_domain::TorrentEngineKind::Embedded,
            torrent_hash: None,
            name: "测试任务".to_owned(),
            status: ani_domain::DownloadStatus::Completed,
            progress: 1.0,
            download_speed: 0,
            upload_speed: 0,
            eta_seconds: Some(0),
            save_path: "C:/downloads".to_owned(),
            files: vec![TorrentFile {
                id: "file-1".to_owned(),
                index: 1,
                name: "episode.mkv".to_owned(),
                episode_id: None,
                episode_no: None,
                size: 4,
                progress: 1.0,
                priority: 1,
                selected: true,
            }],
            created_at: "2026-07-25T00:00:00.000Z".to_owned(),
            completed_at: Some("2026-07-25T00:10:00.000Z".to_owned()),
        };

        assert_eq!(
            select_playable_file(&task, Some(1))
                .expect("select media")
                .index,
            1
        );
        assert!(select_playable_file(&task, Some(2)).is_err());
    }
}
