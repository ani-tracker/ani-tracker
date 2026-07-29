use std::path::PathBuf;
use std::sync::Arc;

use ani_media::player::PlayerTransport;
use serde::de::DeserializeOwned;
use tauri::{plugin::PluginApi, AppHandle, Manager, Runtime};

use crate::desktop_runtime::DesktopPlayerTransport;

/// libVLC 视频输出绑定的平台原生窗口句柄。
#[derive(Debug, Clone, Copy)]
pub enum DesktopVideoTarget {
    Windows(isize),
    MacOs(usize),
    X11(u32),
}

/// 桌面控制层窗口由应用宿主实现的最小操作端口。
pub trait DesktopWindowController: Send + Sync {
    /// 同步视频窗口和控制层的全屏状态。
    fn set_fullscreen(&self, fullscreen: bool) -> Result<bool, String>;
    /// 关闭视频窗口和控制层窗口。
    fn close(&self) -> Result<(), String>;
}

/// 保存应用句柄并按播放窗口创建独立 libVLC transport。
pub struct AniPlayer<R: Runtime>(AppHandle<R>);

impl<R: Runtime> AniPlayer<R> {
    /// 为一个原生视频窗口创建播放器 transport。
    pub fn create_desktop_transport(
        &self,
        target: DesktopVideoTarget,
        controller: Arc<dyn DesktopWindowController>,
    ) -> Arc<dyn PlayerTransport> {
        Arc::new(DesktopPlayerTransport::new(
            target,
            controller,
            desktop_runtime_roots(&self.0),
        ))
    }
}

/// 从任意 Tauri Manager 读取播放器插件句柄。
pub trait AniPlayerExt<R: Runtime> {
    /// 返回当前宿主持有的平台播放器插件。
    fn ani_player(&self) -> &AniPlayer<R>;
}

impl<R: Runtime, T: Manager<R>> AniPlayerExt<R> for T {
    fn ani_player(&self) -> &AniPlayer<R> {
        self.state::<AniPlayer<R>>().inner()
    }
}

/// 注册桌面插件句柄，不向 Renderer 暴露原生 FFI。
pub fn init<R: Runtime, C: DeserializeOwned>(
    app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> crate::Result<AniPlayer<R>> {
    Ok(AniPlayer(app.clone()))
}

fn desktop_runtime_roots<R: Runtime>(app: &AppHandle<R>) -> Vec<PathBuf> {
    let executable_directory = std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(PathBuf::from));
    let current = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    runtime_roots_for(
        &platform_directory(),
        std::env::var_os("ANI_LIBVLC_DIR").map(PathBuf::from),
        executable_directory,
        app.path().resource_dir().ok(),
        current,
    )
}

/// 生成 libVLC 搜索根，兼容自定义 Cargo target-dir 的开发产物目录。
fn runtime_roots_for(
    platform: &str,
    configured: Option<PathBuf>,
    executable_directory: Option<PathBuf>,
    resource_directory: Option<PathBuf>,
    current_directory: PathBuf,
) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(configured) = configured {
        push_unique_root(&mut roots, configured);
    }
    if let Some(resource_directory) = resource_directory {
        push_unique_root(&mut roots, resource_directory.join("libvlc").join(platform));
    }
    if let Some(executable_directory) = executable_directory {
        push_unique_root(
            &mut roots,
            executable_directory.join("libvlc").join(platform),
        );
    }
    push_unique_root(
        &mut roots,
        current_directory.join("out/libvlc").join(platform),
    );
    push_unique_root(
        &mut roots,
        current_directory.join("resources/libvlc").join(platform),
    );
    roots
}

/// 追加尚未出现的运行时根目录，避免重复探测与重复日志。
fn push_unique_root(roots: &mut Vec<PathBuf>, root: PathBuf) {
    if !roots.contains(&root) {
        roots.push(root);
    }
}

/// 返回当前桌面目标对应的资源目录名。
pub(crate) fn platform_directory() -> String {
    platform_directory_for(std::env::consts::OS, std::env::consts::ARCH)
}

/// 将 Rust 平台和架构名称转换为桌面资源目录名。
fn platform_directory_for(os: &str, arch: &str) -> String {
    let platform = match os {
        "windows" => "win32",
        "macos" => "darwin",
        "linux" => "linux",
        value => value,
    };
    let arch = match arch {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        value => value,
    };
    format!("{platform}-{arch}")
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::{platform_directory_for, runtime_roots_for};

    #[test]
    fn maps_supported_desktop_resource_directories() {
        assert_eq!(platform_directory_for("windows", "x86_64"), "win32-x64");
        assert_eq!(platform_directory_for("macos", "x86_64"), "darwin-x64");
        assert_eq!(platform_directory_for("macos", "aarch64"), "darwin-arm64");
        assert_eq!(platform_directory_for("linux", "x86_64"), "linux-x64");
    }

    #[test]
    fn resolves_runtime_next_to_custom_cargo_target_executable() {
        let roots = runtime_roots_for(
            "darwin-x64",
            Some(PathBuf::from("/override/vlc")),
            Some(PathBuf::from("/repo/out/cargo-target/debug")),
            Some(PathBuf::from("/bundle/Contents/Resources")),
            PathBuf::from("/repo/src-tauri"),
        );

        assert_eq!(
            roots,
            vec![
                PathBuf::from("/override/vlc"),
                PathBuf::from("/bundle/Contents/Resources/libvlc/darwin-x64"),
                PathBuf::from("/repo/out/cargo-target/debug/libvlc/darwin-x64"),
                PathBuf::from("/repo/src-tauri/out/libvlc/darwin-x64"),
                PathBuf::from("/repo/src-tauri/resources/libvlc/darwin-x64"),
            ]
        );
    }
}
