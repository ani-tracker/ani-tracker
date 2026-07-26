import type { DownloadTask } from "@shared/domain";

const VIDEO_EXTENSIONS = new Set([
  ".avi", ".flv", ".m2ts", ".m4v", ".mkv", ".mov", ".mp4", ".mpeg",
  ".mpg", ".mts", ".ogv", ".ts", ".vob", ".webm", ".wmv"
]);
const fileNameCollator = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" });

export interface RemotePlaylistItem {
  id: string;
  task: DownloadTask;
  fileIndex?: number;
  fileName: string;
  size?: number;
}

/** 将同一番剧的已完成下载文件整理为稳定的播放顺序。 */
export function buildRemotePlaylist(tasks: DownloadTask[], currentTask: DownloadTask): RemotePlaylistItem[] {
  const animeTasks = currentTask.animeId
    ? tasks.filter((task) => task.animeId === currentTask.animeId)
    : tasks.filter((task) => task.id === currentTask.id);
  const items = animeTasks.flatMap((task) => {
    const playableFiles = task.files
      .filter((file) => file.selected && file.progress >= 1 && isVideoFileName(file.name))
      .map((file) => ({
        id: `${task.id}:file:${file.index}`,
        task,
        fileIndex: file.index,
        fileName: displayFileName(file.name),
        size: file.size
      }));
    if (playableFiles.length > 0) return playableFiles;
    return task.files.length === 0 && isCompletedTask(task)
      ? [{ id: `${task.id}:auto`, task, fileName: displayFileName(task.name) }]
      : [];
  });

  return items.sort((left, right) => {
    const episodeDifference = (left.task.episodeNo ?? Number.MAX_SAFE_INTEGER)
      - (right.task.episodeNo ?? Number.MAX_SAFE_INTEGER);
    return episodeDifference || fileNameCollator.compare(left.fileName, right.fileName);
  });
}

/** 定位路由任务及可选文件索引对应的初始播放项。 */
export function resolveInitialPlaylistItem(
  items: RemotePlaylistItem[],
  taskId: string,
  fileIndex?: number
): RemotePlaylistItem | undefined {
  return items.find((item) => item.task.id === taskId && item.fileIndex === fileIndex)
    ?? items.find((item) => item.task.id === taskId);
}

/** 返回播放器 URL 中合法的文件索引。 */
export function readPlaylistFileIndex(search: string): number | undefined {
  const value = new URLSearchParams(search).get("file");
  if (value === null || !/^\d+$/.test(value)) return undefined;
  const fileIndex = Number(value);
  return Number.isSafeInteger(fileIndex) ? fileIndex : undefined;
}

/** 判断下载任务是否具备媒体扫描兜底播放条件。 */
function isCompletedTask(task: DownloadTask): boolean {
  return task.progress >= 1 || task.status === "completed" || task.status === "seeding";
}

/** 判断文件名是否属于常见视频容器。 */
function isVideoFileName(fileName: string): boolean {
  const normalized = fileName.toLowerCase();
  const dotIndex = normalized.lastIndexOf(".");
  return dotIndex >= 0 && VIDEO_EXTENSIONS.has(normalized.slice(dotIndex));
}

/** 隐藏播放列表中的本地相对目录，仅显示文件名。 */
function displayFileName(fileName: string): string {
  return fileName.split(/[\\/]/).filter(Boolean).at(-1) ?? fileName;
}
