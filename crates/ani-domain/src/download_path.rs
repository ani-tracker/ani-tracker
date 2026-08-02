use std::path::PathBuf;

use serde_json::Value;

use crate::MyAnime;

const DEFAULT_ANIME_FOLDER_PATTERN: &str = "{title}";

/// 根据全局目录模板和单番覆盖配置生成最终保存目录。
pub fn resolve_anime_download_path(settings: &Value, anime: Option<&MyAnime>) -> String {
    if let Some(override_path) = anime
        .and_then(|item| item.download_dir.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return override_path.to_owned();
    }

    let root = settings
        .pointer("/download/defaultDownloadDir")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default();
    let Some(anime) = anime else {
        return root.to_owned();
    };
    let create_folder = settings
        .pointer("/download/createAnimeFolder")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    if !create_folder {
        return root.to_owned();
    }

    let template = settings
        .pointer("/download/animeFolderPattern")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(DEFAULT_ANIME_FOLDER_PATTERN);
    let segments = template
        .split(['/', '\\'])
        .filter_map(|segment| render_path_segment(segment, anime))
        .collect::<Vec<_>>();
    let mut path = PathBuf::from(root);
    if segments.is_empty() {
        path.push(sanitize_path_segment(&anime.anime.title));
    } else {
        path.extend(segments);
    }
    path.to_string_lossy().into_owned()
}

/// 渲染单级目录模板，并丢弃可能越过下载根目录的层级。
fn render_path_segment(segment: &str, anime: &MyAnime) -> Option<String> {
    if matches!(segment, "." | "..") {
        return None;
    }
    let original_title = anime
        .anime
        .original_title
        .as_deref()
        .unwrap_or(&anime.anime.title);
    let rendered = segment
        .replace("{title}", &anime.anime.title)
        .replace("{originalTitle}", original_title)
        .replace("{year}", &anime.anime.premiere_year.to_string())
        .replace("{month}", &format!("{:02}", anime.anime.premiere_month));
    Some(sanitize_path_segment(&rendered))
}

/// 清理跨平台文件名非法字符，并为清理后的空目录提供稳定名称。
fn sanitize_path_segment(value: &str) -> String {
    let sanitized = value
        .chars()
        .map(|character| {
            if character.is_control() || "<>:\"/\\|?*".contains(character) {
                '_'
            } else {
                character
            }
        })
        .collect::<String>();
    let sanitized = sanitized.trim().trim_end_matches(['.', ' ']);
    if sanitized.is_empty() {
        "未命名番剧".to_owned()
    } else {
        sanitized.to_owned()
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    /// 构造目录规则测试使用的追番记录。
    fn anime() -> MyAnime {
        serde_json::from_value(json!({
            "id": "my-anime-1",
            "anime": {
                "id": "anime-1",
                "title": "Test: Anime",
                "aliases": [],
                "premiereYear": 2026,
                "premiereMonth": 7,
                "externalIds": {}
            },
            "status": "watching",
            "autoDownload": true,
            "rssSubscriptions": [],
            "preferredSubtitleLanguages": [],
            "addedAt": "2026-07-01T00:00:00Z",
            "updatedAt": "2026-07-01T00:00:00Z"
        }))
        .expect("decode anime")
    }

    /// 验证开启规则后按模板生成多级番剧目录。
    #[test]
    fn applies_configured_anime_folder_pattern() {
        let settings = json!({
            "download": {
                "defaultDownloadDir": "/downloads/Ani Tracker",
                "createAnimeFolder": true,
                "animeFolderPattern": "{year}-{month}/{title}"
            }
        });

        assert_eq!(
            resolve_anime_download_path(&settings, Some(&anime())),
            PathBuf::from("/downloads/Ani Tracker")
                .join("2026-07")
                .join("Test_ Anime")
                .to_string_lossy()
        );
    }

    /// 验证单番目录覆盖配置拥有最高优先级。
    #[test]
    fn prefers_per_anime_directory_override() {
        let mut anime = anime();
        anime.download_dir = Some("/media/anime/custom".to_owned());
        let settings = json!({
            "download": {
                "defaultDownloadDir": "/downloads",
                "createAnimeFolder": true,
                "animeFolderPattern": "{title}"
            }
        });

        assert_eq!(
            resolve_anime_download_path(&settings, Some(&anime)),
            "/media/anime/custom"
        );
    }

    /// 验证关闭规则时直接使用全局下载目录。
    #[test]
    fn uses_root_when_anime_folder_is_disabled() {
        let settings = json!({
            "download": {
                "defaultDownloadDir": "/downloads",
                "createAnimeFolder": false,
                "animeFolderPattern": "{title}"
            }
        });

        assert_eq!(
            resolve_anime_download_path(&settings, Some(&anime())),
            "/downloads"
        );
    }

    /// 验证模板中的父级跳转不会逃逸默认下载目录。
    #[test]
    fn ignores_parent_segments_in_pattern() {
        let settings = json!({
            "download": {
                "defaultDownloadDir": "/downloads",
                "createAnimeFolder": true,
                "animeFolderPattern": "../../{title}"
            }
        });

        assert_eq!(
            resolve_anime_download_path(&settings, Some(&anime())),
            PathBuf::from("/downloads")
                .join("Test_ Anime")
                .to_string_lossy()
        );
    }
}
