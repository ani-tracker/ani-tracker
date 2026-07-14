import { join } from "node:path";
import type { AppSettings, MyAnime } from "@shared/domain";

const TEMPLATE_TOKEN_PATTERN = /\{(title|originalTitle|year|month)\}/g;
const PATH_SEPARATOR_PATTERN = /[\\/]+/;

/** 根据全局目录模板和单番覆盖配置生成最终保存目录。 */
export function resolveAnimeDownloadPath(settings: AppSettings, anime?: MyAnime): string {
  const override = anime?.downloadDir?.trim();
  if (override) {
    return override;
  }

  const root = settings.download.defaultDownloadDir;
  if (!anime || !settings.download.createAnimeFolder) {
    return root;
  }

  const template = settings.download.animeFolderPattern.trim() || "{title}";
  const segments = template
    .split(PATH_SEPARATOR_PATTERN)
    .map((segment) => renderSegment(segment, anime))
    .filter(Boolean);

  return segments.length > 0 ? join(root, ...segments) : join(root, sanitizePathSegment(anime.anime.title));
}

function renderSegment(segment: string, anime: MyAnime): string {
  if (segment === "." || segment === "..") {
    return "";
  }

  const rendered = segment.replace(TEMPLATE_TOKEN_PATTERN, (_match, token: string) => {
    switch (token) {
      case "title":
        return anime.anime.title;
      case "originalTitle":
        return anime.anime.originalTitle ?? anime.anime.title;
      case "year":
        return String(anime.anime.premiereYear);
      case "month":
        return String(anime.anime.premiereMonth).padStart(2, "0");
      default:
        return "";
    }
  });

  return sanitizePathSegment(rendered);
}

function sanitizePathSegment(value: string): string {
  const sanitized = value
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/[. ]+$/g, "")
    .trim();
  return sanitized || "未命名番剧";
}
