use ani_contracts::AppCommandError;
use url::Url;

/// 解析并校验允许交给系统处理的外部链接。
fn validate_external_url(url: &str) -> Result<Url, AppCommandError> {
    let parsed = Url::parse(url).map_err(|error| AppCommandError {
        code: "invalid_external_url".to_string(),
        message: format!("外部链接格式无效: {error}"),
    })?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(AppCommandError {
            code: "unsupported_external_url_scheme".to_string(),
            message: "仅允许打开 HTTP 或 HTTPS 外部链接".to_string(),
        });
    }
    Ok(parsed)
}

/// 使用系统默认程序打开经过协议白名单校验的外部链接。
#[tauri::command]
pub(crate) fn open_external(url: String) -> Result<(), AppCommandError> {
    let parsed = validate_external_url(&url)?;

    log::info!(
        "准备打开外部链接 scheme={} host={}",
        parsed.scheme(),
        parsed.host_str().unwrap_or("unknown")
    );

    #[cfg(desktop)]
    {
        open::that_detached(parsed.as_str()).map_err(|error| AppCommandError {
            code: "open_external_failed".to_string(),
            message: format!("系统无法打开外部链接: {error}"),
        })?;
        Ok(())
    }

    #[cfg(not(desktop))]
    {
        Err(AppCommandError {
            code: "open_external_unavailable".to_string(),
            message: "当前移动宿主尚未接入系统外链能力".to_string(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::validate_external_url;

    /// 验证外链命令只接受 HTTP 与 HTTPS 协议。
    #[test]
    fn validates_external_url_scheme() {
        assert!(validate_external_url("https://example.com/anime/1").is_ok());
        assert!(validate_external_url("file:///C:/sensitive.txt").is_err());
        assert!(validate_external_url("javascript:alert(1)").is_err());
    }
}
