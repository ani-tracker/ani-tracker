use std::io;
use std::path::{Path, PathBuf};

/// 规范化真实路径，并在 Windows 上移除外部程序不兼容的 verbatim 前缀。
pub(crate) fn canonicalize(path: impl AsRef<Path>) -> io::Result<PathBuf> {
    dunce::canonicalize(path)
}

/// 不访问磁盘地转换 Windows verbatim 路径，供进程和 FFI 边界使用。
pub(crate) fn simplify(path: impl AsRef<Path>) -> PathBuf {
    dunce::simplified(path.as_ref()).to_path_buf()
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::*;

    #[test]
    fn removes_windows_verbatim_prefix_for_external_consumers() {
        assert_eq!(
            simplify(Path::new(r"\\?\C:\Anime\Episode 01.mkv")),
            PathBuf::from(r"C:\Anime\Episode 01.mkv")
        );
    }
}
