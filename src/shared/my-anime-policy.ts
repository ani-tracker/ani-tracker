import type { AnimeStatus, MyAnime } from "./domain";

type DefaultMyAnimePreferences = Pick<
  MyAnime,
  | "autoDownload"
  | "preferredResolution"
  | "preferredCodec"
  | "preferredBitDepth"
  | "preferredSubtitleLanguages"
>;

const AUTO_DOWNLOAD_DISABLED_STATUSES = new Set<AnimeStatus>(["completed", "dropped"]);

/** 创建新增追番统一使用的下载偏好，避免各入口默认值漂移。 */
export function createDefaultMyAnimePreferences(): DefaultMyAnimePreferences {
  return {
    autoDownload: true,
    preferredResolution: "1080p",
    preferredCodec: "H.265/HEVC",
    preferredBitDepth: 10,
    preferredSubtitleLanguages: ["chs"]
  };
}

/** 判断追番状态是否允许执行自动下载。 */
export function canAnimeStatusAutoDownload(status: AnimeStatus): boolean {
  return !AUTO_DOWNLOAD_DISABLED_STATUSES.has(status);
}

/** 在持久化前关闭终止状态追番的自动下载，防止旧值绕过业务规则。 */
export function normalizeMyAnimeAutoDownload(item: MyAnime): MyAnime {
  if (canAnimeStatusAutoDownload(item.status) || !item.autoDownload) {
    return item;
  }

  return { ...item, autoDownload: false };
}
