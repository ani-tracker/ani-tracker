use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use ani_contracts::QbittorrentManagedStatus;
use ani_domain::AppSettings;
use ani_downloads::QbittorrentEngine;
use chrono::{SecondsFormat, Utc};
use serde_json::Value;
use tauri::{AppHandle, Manager};
use tokio::sync::Mutex;

#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
use std::ffi::OsString;
#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
use std::io::{BufRead, BufReader};
#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
use std::process::{Child, Command, Stdio};

const MIN_WEBUI_PORT: u16 = 10_000;
const DEFAULT_WEBUI_PORT: u16 = 18_080;
const DEFAULT_USERNAME: &str = "admin";
const DEFAULT_PASSWORD: &str = "ani-tracker";

/// 托管 qBittorrent 启动所需的固定路径和本地 WebUI 参数。
#[derive(Debug, Clone, PartialEq, Eq)]
struct ManagedPlan {
    binary_path: Option<PathBuf>,
    profile_directory: PathBuf,
    web_ui_url: String,
    web_ui_port: u16,
    startup_timeout: Duration,
}

struct ManagedRuntime {
    #[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
    child: Option<Child>,
    active_plan: Option<ManagedPlan>,
    startup_output: Arc<StdMutex<String>>,
    last_started_at: Option<String>,
    last_stopped_at: Option<String>,
    last_error: Option<String>,
}

impl Default for ManagedRuntime {
    fn default() -> Self {
        Self {
            #[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
            child: None,
            active_plan: None,
            startup_output: Arc::new(StdMutex::new(String::new())),
            last_started_at: None,
            last_stopped_at: None,
            last_error: None,
        }
    }
}

/// Tauri 生命周期内持有托管 qBittorrent-nox 子进程。
#[derive(Clone)]
pub(crate) struct AppManagedQbittorrentState {
    runtime: Arc<Mutex<ManagedRuntime>>,
    resource_roots: Arc<Vec<PathBuf>>,
}

impl AppManagedQbittorrentState {
    /// 从 Tauri 资源目录和开发目录创建二进制解析边界。
    pub(crate) fn new(app: &AppHandle) -> Self {
        let current = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        let mut roots = Vec::new();
        if let Ok(resources) = app.path().resource_dir() {
            roots.push(resources.join("qbittorrent"));
        }
        roots.extend([
            current.join("out/qbittorrent"),
            current.join("resources/qbittorrent"),
        ]);
        roots.dedup();
        Self {
            runtime: Arc::new(Mutex::new(ManagedRuntime::default())),
            resource_roots: Arc::new(roots),
        }
    }

    /// 返回设置是否要求随应用自动启动托管进程。
    pub(crate) fn should_auto_start(settings: &AppSettings) -> bool {
        settings
            .pointer("/download/defaultTorrentEngine")
            .and_then(Value::as_str)
            == Some("qbittorrent")
            && setting_bool(settings, "/download/qbittorrent/managed/enabled", false)
            && setting_bool(settings, "/download/qbittorrent/autoConnect", false)
    }

    /// 返回设置是否选择了托管 qBittorrent 模式。
    pub(crate) fn is_managed_enabled(settings: &AppSettings) -> bool {
        setting_bool(settings, "/download/qbittorrent/managed/enabled", false)
    }

    /// 启动受管进程并等待本地 WebUI 端口就绪。
    pub(crate) async fn start(
        &self,
        settings: &AppSettings,
    ) -> Result<QbittorrentManagedStatus, String> {
        if !Self::is_managed_enabled(settings) {
            return Err("托管 qBittorrent 未启用".to_owned());
        }
        #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
        {
            let mut runtime = self.runtime.lock().await;
            runtime.last_error = Some("移动端不支持托管 qBittorrent 进程".to_owned());
            return Ok(status_snapshot(settings, &mut runtime, None));
        }
        #[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
        {
            {
                let mut runtime = self.runtime.lock().await;
                refresh_child_status(&mut runtime);
                if runtime.child.is_some() {
                    return Ok(status_snapshot(settings, &mut runtime, None));
                }
            }
            let plan = build_start_plan(settings, &self.resource_roots).await?;
            let binary_path = plan
                .binary_path
                .as_ref()
                .ok_or_else(|| "未找到项目内置的 qBittorrent-nox 二进制".to_owned())?;
            tokio::fs::create_dir_all(&plan.profile_directory)
                .await
                .map_err(|error| format!("创建 qBittorrent profile 目录失败：{error}"))?;
            let mut command = Command::new(binary_path);
            command
                .arg(format!("--webui-port={}", plan.web_ui_port))
                .arg(format!("--profile={}", plan.profile_directory.display()))
                .arg("--confirm-legal-notice")
                .current_dir(binary_path.parent().unwrap_or_else(|| Path::new(".")))
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            apply_launch_environment(&mut command, binary_path)?;
            #[cfg(target_os = "windows")]
            {
                use std::os::windows::process::CommandExt;
                command.creation_flags(0x0800_0000);
            }
            let mut child = command
                .spawn()
                .map_err(|error| format!("启动托管 qBittorrent 失败：{error}"))?;
            let pid = child.id();
            let output = Arc::new(StdMutex::new(String::new()));
            if let Some(stdout) = child.stdout.take() {
                spawn_output_reader(stdout, Arc::clone(&output), false);
            }
            if let Some(stderr) = child.stderr.take() {
                spawn_output_reader(stderr, Arc::clone(&output), true);
            }
            {
                let mut runtime = self.runtime.lock().await;
                runtime.child = Some(child);
                runtime.active_plan = Some(plan.clone());
                runtime.startup_output = output;
                runtime.last_started_at = Some(now_iso());
                runtime.last_stopped_at = None;
                runtime.last_error = None;
            }
            log::info!(
                "托管 qBittorrent 已启动 pid={pid} binary={} webui={}",
                binary_path.display(),
                plan.web_ui_url
            );
            if !wait_for_web_ui(plan.web_ui_port, plan.startup_timeout).await {
                let message = format!(
                    "qBittorrent WebUI 未在 {}ms 内就绪",
                    plan.startup_timeout.as_millis()
                );
                self.runtime.lock().await.last_error = Some(message.clone());
                self.stop(settings, None).await;
                self.runtime.lock().await.last_error = Some(message.clone());
                return Err(message);
            }
            Ok(self.status(settings).await)
        }
    }

    /// 先请求 WebUI 保存退出，超时后再终止并回收子进程。
    pub(crate) async fn stop(
        &self,
        settings: &AppSettings,
        engine: Option<&QbittorrentEngine>,
    ) -> QbittorrentManagedStatus {
        #[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
        {
            let running = {
                let mut runtime = self.runtime.lock().await;
                refresh_child_status(&mut runtime);
                runtime.child.is_some()
            };
            if running {
                if let Some(engine) = engine {
                    if let Err(error) = engine.shutdown_application().await {
                        log::warn!("托管 qBittorrent WebUI 关闭请求失败：{error}");
                    }
                }
                if !self.wait_for_exit(Duration::from_secs(5)).await {
                    let mut runtime = self.runtime.lock().await;
                    if let Some(child) = runtime.child.as_mut() {
                        log::warn!("托管 qBittorrent 优雅关闭超时，终止 pid={}", child.id());
                        let _ = child.kill();
                        let _ = child.wait();
                    }
                    runtime.child = None;
                }
                let mut runtime = self.runtime.lock().await;
                runtime.active_plan = None;
                runtime.last_stopped_at = Some(now_iso());
                log::info!("托管 qBittorrent 已停止");
            }
        }
        self.status(settings).await
    }

    /// 读取进程、路径和最近错误状态，不会隐式启动服务。
    pub(crate) async fn status(&self, settings: &AppSettings) -> QbittorrentManagedStatus {
        let fallback = build_status_plan(settings, &self.resource_roots);
        let mut runtime = self.runtime.lock().await;
        #[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
        refresh_child_status(&mut runtime);
        status_snapshot(settings, &mut runtime, Some(&fallback))
    }

    /// 返回当前进程实际 WebUI 地址，未运行时回退到设置地址。
    pub(crate) async fn runtime_base_url(&self, settings: &AppSettings) -> String {
        let mut runtime = self.runtime.lock().await;
        #[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
        refresh_child_status(&mut runtime);
        runtime
            .active_plan
            .as_ref()
            .map(|plan| plan.web_ui_url.clone())
            .unwrap_or_else(|| {
                setting_string(
                    settings,
                    "/download/qbittorrent/baseUrl",
                    "http://127.0.0.1:18080",
                )
            })
    }

    /// 从已脱离日志的启动缓冲中提取一次性临时密码。
    pub(crate) async fn temporary_password(&self) -> Option<String> {
        let output = Arc::clone(&self.runtime.lock().await.startup_output);
        let output = output.lock().ok()?.clone();
        extract_temporary_password(&output)
    }

    #[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
    async fn wait_for_exit(&self, timeout: Duration) -> bool {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            {
                let mut runtime = self.runtime.lock().await;
                refresh_child_status(&mut runtime);
                if runtime.child.is_none() {
                    return true;
                }
            }
            if tokio::time::Instant::now() >= deadline {
                return false;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
}

fn build_status_plan(settings: &AppSettings, roots: &[PathBuf]) -> ManagedPlan {
    let requested_port = requested_web_ui_port(settings);
    ManagedPlan {
        binary_path: resolve_binary(settings, roots),
        profile_directory: profile_directory(settings),
        web_ui_url: format!("http://127.0.0.1:{requested_port}/"),
        web_ui_port: requested_port,
        startup_timeout: Duration::from_millis(
            setting_u64(
                settings,
                "/download/qbittorrent/managed/startupTimeoutMs",
                15_000,
            )
            .clamp(1_000, 60_000),
        ),
    }
}

#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
async fn build_start_plan(
    settings: &AppSettings,
    roots: &[PathBuf],
) -> Result<ManagedPlan, String> {
    let mut plan = build_status_plan(settings, roots);
    plan.web_ui_port = select_web_ui_port(plan.web_ui_port).await?;
    plan.web_ui_url = format!("http://127.0.0.1:{}/", plan.web_ui_port);
    Ok(plan)
}

fn status_snapshot(
    settings: &AppSettings,
    runtime: &mut ManagedRuntime,
    fallback: Option<&ManagedPlan>,
) -> QbittorrentManagedStatus {
    let plan = runtime.active_plan.as_ref().or(fallback);
    #[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
    let pid = runtime.child.as_ref().map(Child::id);
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    let pid = None;
    QbittorrentManagedStatus {
        enabled: AppManagedQbittorrentState::is_managed_enabled(settings),
        auto_start: setting_bool(settings, "/download/qbittorrent/autoConnect", false),
        running: pid.is_some(),
        web_ui_url: plan
            .map(|value| value.web_ui_url.clone())
            .unwrap_or_else(|| "http://127.0.0.1:18080/".to_owned()),
        platform: std::env::consts::OS.to_owned(),
        arch: std::env::consts::ARCH.to_owned(),
        binary_path: plan
            .and_then(|value| value.binary_path.as_ref())
            .map(|value| value.to_string_lossy().into_owned()),
        profile_dir: plan.map(|value| value.profile_directory.to_string_lossy().into_owned()),
        pid,
        last_started_at: runtime.last_started_at.clone(),
        last_stopped_at: runtime.last_stopped_at.clone(),
        last_error: runtime.last_error.clone(),
    }
}

#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
fn refresh_child_status(runtime: &mut ManagedRuntime) {
    let Some(child) = runtime.child.as_mut() else {
        return;
    };
    match child.try_wait() {
        Ok(Some(status)) => {
            if !status.success() && runtime.last_error.is_none() {
                runtime.last_error = Some(format!("qBittorrent 进程异常退出：{status}"));
            }
            runtime.child = None;
            runtime.active_plan = None;
            runtime.last_stopped_at = Some(now_iso());
        }
        Ok(None) => {}
        Err(error) => runtime.last_error = Some(format!("读取 qBittorrent 进程状态失败：{error}")),
    }
}

fn requested_web_ui_port(settings: &AppSettings) -> u16 {
    let configured = setting_string(
        settings,
        "/download/qbittorrent/baseUrl",
        "http://127.0.0.1:18080",
    );
    let port = url::Url::parse(&configured)
        .ok()
        .and_then(|url| url.port_or_known_default())
        .unwrap_or(DEFAULT_WEBUI_PORT);
    if port < MIN_WEBUI_PORT {
        DEFAULT_WEBUI_PORT
    } else {
        port
    }
}

fn profile_directory(settings: &AppSettings) -> PathBuf {
    settings
        .pointer("/download/qbittorrent/managed/profileDir")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(setting_string(settings, "/storage/userDataDir", ".")).join("qbittorrent")
        })
}

fn resolve_binary(settings: &AppSettings, roots: &[PathBuf]) -> Option<PathBuf> {
    let override_path = std::env::var_os("ANI_QBITTORRENT_NOX_PATH")
        .map(PathBuf::from)
        .or_else(|| {
            settings
                .pointer("/download/qbittorrent/managed/binaryPath")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
        });
    if let Some(path) = override_path {
        let path = if path.is_absolute() {
            path
        } else {
            std::env::current_dir()
                .unwrap_or_else(|_| PathBuf::from("."))
                .join(path)
        };
        return path.is_file().then_some(path);
    }
    let platform = if cfg!(target_os = "windows") {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    };
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        value => value,
    };
    let names: &[&str] = if cfg!(target_os = "windows") {
        &["qbittorrent-nox.exe"]
    } else if cfg!(target_os = "macos") {
        &[
            "qbittorrent-nox",
            "qbittorrent-nox.app/Contents/MacOS/qbittorrent-nox",
            "qBittorrent-nox.app/Contents/MacOS/qbittorrent-nox",
        ]
    } else {
        &["qbittorrent-nox"]
    };
    for root in roots {
        for directory in [
            format!("{platform}-{arch}"),
            platform.to_owned(),
            String::new(),
        ] {
            for name in names {
                let candidate = root.join(&directory).join(name);
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
    }
    None
}

#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
async fn select_web_ui_port(preferred: u16) -> Result<u16, String> {
    if tokio::net::TcpListener::bind(("127.0.0.1", preferred))
        .await
        .is_ok()
    {
        return Ok(preferred);
    }
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|error| format!("分配 qBittorrent WebUI 端口失败：{error}"))?;
    let port = listener
        .local_addr()
        .map_err(|error| format!("读取 qBittorrent WebUI 端口失败：{error}"))?
        .port();
    drop(listener);
    if port < MIN_WEBUI_PORT {
        return Err("系统未分配 10000 以上的 qBittorrent WebUI 端口".to_owned());
    }
    log::info!("托管 qBittorrent 使用备用 WebUI 端口 port={port}");
    Ok(port)
}

#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
async fn wait_for_web_ui(port: u16, timeout: Duration) -> bool {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        if tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .is_ok()
        {
            return true;
        }
        if tokio::time::Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
fn spawn_output_reader<R>(reader: R, output: Arc<StdMutex<String>>, warning: bool)
where
    R: std::io::Read + Send + 'static,
{
    std::thread::spawn(move || {
        let mut reader = BufReader::new(reader);
        let mut bytes = Vec::new();
        loop {
            bytes.clear();
            match reader.read_until(b'\n', &mut bytes) {
                Ok(0) => break,
                Ok(_) => {
                    while matches!(bytes.last(), Some(b'\n' | b'\r')) {
                        bytes.pop();
                    }
                    // Qt 在 Windows 上可能按系统代码页输出中文，损失解码仍能保留 ASCII 临时密码。
                    let line = String::from_utf8_lossy(&bytes).into_owned();
                    if let Ok(mut current) = output.lock() {
                        current.push_str(&line);
                        current.push('\n');
                        if current.len() > 16_000 {
                            let mut split = current.len() - 16_000;
                            while !current.is_char_boundary(split) {
                                split += 1;
                            }
                            current.drain(..split);
                        }
                    }
                    let display = redact_process_line(&line);
                    if !display.is_empty() {
                        if warning {
                            log::warn!("托管 qBittorrent stderr：{display}");
                        } else {
                            log::info!("托管 qBittorrent stdout：{display}");
                        }
                    }
                }
                Err(error) => {
                    log::warn!("托管 qBittorrent 输出读取失败：{error}");
                    break;
                }
            }
        }
    });
}

fn extract_temporary_password(output: &str) -> Option<String> {
    let pattern = regex::Regex::new(
        r"(?i)(?:临时密码|temporary password)[^:\n：]*(?::|：)\s*([A-Za-z0-9]{8,32})",
    )
    .ok()?;
    let matched = pattern
        .captures_iter(output)
        .filter_map(|capture| capture.get(1).map(|value| value.as_str().to_owned()))
        .last();
    matched.or_else(|| {
        let ignored = [
            "localhost",
            "qbittorrent",
            "administrator",
            "temporary",
            "password",
            "provided",
            "session",
        ];
        output
            .split(|character: char| !character.is_ascii_alphanumeric())
            .filter(|value| (8..=32).contains(&value.len()))
            .filter(|value| {
                !ignored
                    .iter()
                    .any(|ignored| value.eq_ignore_ascii_case(ignored))
            })
            .map(str::to_owned)
            .next_back()
    })
}

fn redact_process_line(line: &str) -> String {
    let lower = line.to_ascii_lowercase();
    if lower.contains("password") || line.contains("密码") {
        "[包含凭据的启动输出已脱敏]".to_owned()
    } else {
        line.split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .chars()
            .take(500)
            .collect()
    }
}

#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
fn apply_launch_environment(command: &mut Command, binary_path: &Path) -> Result<(), String> {
    let directory = binary_path.parent().unwrap_or_else(|| Path::new("."));
    prepend_environment_path(command, "PATH", directory)?;
    let plugin_path = if cfg!(target_os = "macos") {
        mac_contents_directory(binary_path)
            .map(|contents| contents.join("PlugIns"))
            .unwrap_or_else(|| directory.to_path_buf())
    } else {
        directory.to_path_buf()
    };
    if plugin_path.is_dir() {
        command.env("QT_PLUGIN_PATH", plugin_path);
    }
    let openssl_modules = if cfg!(target_os = "macos") {
        mac_contents_directory(binary_path)
            .map(|contents| contents.join("Frameworks/ossl-modules"))
            .unwrap_or_else(|| directory.join("ossl-modules"))
    } else {
        directory.join("ossl-modules")
    };
    if openssl_modules.is_dir() {
        command.env("OPENSSL_MODULES", openssl_modules);
    }
    if cfg!(target_os = "macos") {
        prepend_environment_path(command, "DYLD_LIBRARY_PATH", directory)?;
    } else if cfg!(target_os = "linux") {
        prepend_environment_path(command, "LD_LIBRARY_PATH", directory)?;
    }
    Ok(())
}

#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
fn prepend_environment_path(
    command: &mut Command,
    variable: &str,
    path: &Path,
) -> Result<(), String> {
    let mut paths = vec![path.to_path_buf()];
    if let Some(current) = std::env::var_os(variable) {
        paths.extend(std::env::split_paths(&current));
    }
    let joined: OsString = std::env::join_paths(paths)
        .map_err(|error| format!("qBittorrent {variable} 无效：{error}"))?;
    command.env(variable, joined);
    Ok(())
}

#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
fn mac_contents_directory(binary_path: &Path) -> Option<PathBuf> {
    let executable_directory = binary_path.parent()?;
    if executable_directory.file_name()?.to_str()? != "MacOS" {
        return None;
    }
    let contents = executable_directory.parent()?;
    (contents.file_name()?.to_str()? == "Contents").then(|| contents.to_path_buf())
}

fn desired_credentials(settings: &AppSettings) -> (String, String) {
    let username = setting_string(settings, "/download/qbittorrent/username", DEFAULT_USERNAME);
    let password = setting_string(settings, "/download/qbittorrent/password", DEFAULT_PASSWORD);
    (
        if username.trim().is_empty() {
            DEFAULT_USERNAME.to_owned()
        } else {
            username
        },
        if password.is_empty() {
            DEFAULT_PASSWORD.to_owned()
        } else {
            password
        },
    )
}

pub(crate) fn managed_credentials(settings: &AppSettings) -> (String, String) {
    desired_credentials(settings)
}

fn setting_bool(settings: &AppSettings, pointer: &str, fallback: bool) -> bool {
    settings
        .pointer(pointer)
        .and_then(Value::as_bool)
        .unwrap_or(fallback)
}

fn setting_u64(settings: &AppSettings, pointer: &str, fallback: u64) -> u64 {
    settings
        .pointer(pointer)
        .and_then(Value::as_u64)
        .unwrap_or(fallback)
}

fn setting_string(settings: &AppSettings, pointer: &str, fallback: &str) -> String {
    settings
        .pointer(pointer)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(fallback)
        .to_owned()
}

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    /// 验证启动输出中的临时密码可提取且日志始终脱敏。
    #[test]
    fn extracts_and_redacts_temporary_password() {
        let line = "A temporary password is provided for this session: AbCd123456";
        assert_eq!(
            extract_temporary_password(line).as_deref(),
            Some("AbCd123456")
        );
        assert_eq!(redact_process_line(line), "[包含凭据的启动输出已脱敏]");
        let chinese = "未设置 WebUI 管理员密码。为此会话提供了一个临时密码：XyZ987654321";
        assert_eq!(
            extract_temporary_password(chinese).as_deref(),
            Some("XyZ987654321")
        );
        let localized = "WebUI localhost admin \u{fffd}\u{fffd}\u{fffd} XyZ987654321";
        assert_eq!(
            extract_temporary_password(localized).as_deref(),
            Some("XyZ987654321")
        );
    }

    /// 验证低端口被替换且托管凭据拥有稳定默认值。
    #[test]
    fn normalizes_managed_settings() {
        let settings = json!({
            "storage": { "userDataDir": "C:/Ani" },
            "download": {
                "qbittorrent": {
                    "baseUrl": "http://127.0.0.1:8080",
                    "username": "",
                    "password": "",
                    "managed": { "enabled": true }
                }
            }
        });
        assert_eq!(requested_web_ui_port(&settings), DEFAULT_WEBUI_PORT);
        assert_eq!(
            profile_directory(&settings),
            PathBuf::from("C:/Ani/qbittorrent")
        );
        assert_eq!(
            managed_credentials(&settings),
            (DEFAULT_USERNAME.to_owned(), DEFAULT_PASSWORD.to_owned())
        );
    }
}
