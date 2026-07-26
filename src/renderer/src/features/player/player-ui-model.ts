import { formatBytes } from "@/lib/format";
import type { DownloadTask, Episode } from "@shared/domain";
import type { RemotePlaybackSession } from "@shared/contracts";
import type { RemotePlaylistItem } from "@/features/player/playback-list-model";

export type PlayerEpisodeUiStatus = "playing" | "watched" | "ready" | "downloading" | "unavailable";

export interface PlayerEpisodeUiItem {
  id: string;
  episodeNo?: number;
  numberLabel: string;
  title: string;
  meta: string;
  status: PlayerEpisodeUiStatus;
  statusLabel: string;
  progress: number;
  playlistItem?: RemotePlaylistItem;
}

interface BuildPlayerEpisodeItemsInput {
  activeItem: RemotePlaylistItem | null;
  currentTimeSeconds: number;
  downloadTasks: DownloadTask[];
  durationSeconds: number;
  episodes: Episode[];
  playlist: RemotePlaylistItem[];
  session: RemotePlaybackSession | null;
}

/** 合并番剧集数、下载任务与可播放文件，生成完整播放器列表。 */
export function buildPlayerEpisodeItems(input: BuildPlayerEpisodeItemsInput): PlayerEpisodeUiItem[] {
  const episodeNumbers = new Set<number>();
  input.episodes.forEach((episode) => episodeNumbers.add(episode.episodeNo));
  input.downloadTasks.forEach((task) => {
    if (task.episodeNo !== undefined) episodeNumbers.add(task.episodeNo);
  });
  input.playlist.forEach((item) => {
    if (item.task.episodeNo !== undefined) episodeNumbers.add(item.task.episodeNo);
  });

  if (episodeNumbers.size === 0) {
    return input.playlist.map((item, index) => buildPlaylistOnlyItem(item, index, input));
  }

  return [...episodeNumbers]
    .sort((left, right) => left - right)
    .map((episodeNo) => buildEpisodeItem(episodeNo, input));
}

/** 为有明确集数的条目生成状态、规格与观看进度。 */
function buildEpisodeItem(
  episodeNo: number,
  input: BuildPlayerEpisodeItemsInput
): PlayerEpisodeUiItem {
  const episode = input.episodes.find((item) => item.episodeNo === episodeNo);
  const task = input.downloadTasks.find((item) => item.episodeNo === episodeNo);
  const playlistItem = input.playlist.find((item) => item.task.episodeNo === episodeNo);
  const active = playlistItem?.id === input.activeItem?.id;
  const state = resolveEpisodeState(active, episode, task, playlistItem);
  const currentProgress = active && input.durationSeconds > 0
    ? clamp(input.currentTimeSeconds / input.durationSeconds)
    : state.status === "watched" ? 1 : task?.progress ?? 0;

  return {
    id: episode?.id ?? playlistItem?.id ?? task?.id ?? `episode-${episodeNo}`,
    episodeNo,
    numberLabel: String(episodeNo).padStart(2, "0"),
    title: episode?.title?.trim() || playlistItem?.fileName || task?.name || `第 ${episodeNo} 集`,
    meta: formatEpisodeMeta(active ? input.session : null, playlistItem, task),
    status: state.status,
    statusLabel: state.label,
    progress: currentProgress,
    playlistItem
  };
}

/** 为无法关联集数的媒体文件生成稳定列表项。 */
function buildPlaylistOnlyItem(
  item: RemotePlaylistItem,
  index: number,
  input: BuildPlayerEpisodeItemsInput
): PlayerEpisodeUiItem {
  const active = item.id === input.activeItem?.id;
  return {
    id: item.id,
    episodeNo: item.task.episodeNo,
    numberLabel: String(item.task.episodeNo ?? index + 1).padStart(2, "0"),
    title: item.fileName,
    meta: formatEpisodeMeta(active ? input.session : null, item, item.task),
    status: active ? "playing" : "ready",
    statusLabel: active ? "正在播放" : "已下载",
    progress: active && input.durationSeconds > 0
      ? clamp(input.currentTimeSeconds / input.durationSeconds)
      : 0,
    playlistItem: item
  };
}

/** 按播放、观看和下载优先级解析单集状态。 */
function resolveEpisodeState(
  active: boolean,
  episode: Episode | undefined,
  task: DownloadTask | undefined,
  playlistItem: RemotePlaylistItem | undefined
): { status: PlayerEpisodeUiStatus; label: string } {
  if (active) return { status: "playing", label: "正在播放" };
  if (episode?.status === "watched") return { status: "watched", label: "已看" };
  if (playlistItem) return { status: "ready", label: "已下载" };
  if (task && task.progress < 1) {
    return { status: "downloading", label: `下载中 ${Math.round(task.progress * 100)}%` };
  }
  return { status: "unavailable", label: "未下载" };
}

/** 组合播放器列表中需要快速扫描的媒体规格。 */
function formatEpisodeMeta(
  session: RemotePlaybackSession | null,
  item: RemotePlaylistItem | undefined,
  task: DownloadTask | undefined
): string {
  return [
    session?.durationSeconds ? formatPlaybackTime(session.durationSeconds) : undefined,
    task?.resolution?.toUpperCase(),
    task?.normalizedVideoCodec?.replace("H.265/", "").replace("H.264/", ""),
    item?.size !== undefined ? formatBytes(item.size) : undefined
  ].filter(Boolean).join(" · ") || "视频信息待扫描";
}

/** 将媒体秒数格式化为播放器时间。 */
export function formatPlaybackTime(seconds: number): string {
  const totalSeconds = Math.max(0, Math.round(Number.isFinite(seconds) ? seconds : 0));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const remainder = totalSeconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${minutes}:${String(remainder).padStart(2, "0")}`;
}

/** 把任意观看进度限制在 0 至 1。 */
function clamp(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}
