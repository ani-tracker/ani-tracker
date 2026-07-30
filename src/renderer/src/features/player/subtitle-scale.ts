import {
  PLAYER_SUBTITLE_SCALES,
  type PlayerSubtitleScale
} from "@shared/player-contract";

const SUBTITLE_SCALE_STORAGE_KEY = "ani.player.subtitleScale";

/** 将未知值收敛到播放器支持的离散字幕缩放比例。 */
export function normalizeSubtitleScale(value: unknown): PlayerSubtitleScale {
  const numeric = typeof value === "number" ? value : Number(value);
  return PLAYER_SUBTITLE_SCALES.includes(numeric as PlayerSubtitleScale)
    ? numeric as PlayerSubtitleScale
    : 100;
}

/** 从浏览器持久化中读取字幕缩放，异常时使用默认大小。 */
export function readStoredSubtitleScale(): PlayerSubtitleScale {
  try {
    return normalizeSubtitleScale(window.localStorage.getItem(SUBTITLE_SCALE_STORAGE_KEY));
  } catch (error) {
    console.warn("[player] 字幕大小读取失败", { error });
    return 100;
  }
}

/** 持久化桌面与远程 PWA 共用的字幕缩放比例。 */
export function storeSubtitleScale(value: PlayerSubtitleScale): void {
  try {
    window.localStorage.setItem(SUBTITLE_SCALE_STORAGE_KEY, String(value));
  } catch (error) {
    console.warn("[player] 字幕大小保存失败", { value, error });
  }
}
