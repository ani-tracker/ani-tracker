import type { DownloadStatus, DownloadTask } from "./domain";

type DownloadProgressState = Pick<DownloadTask, "status" | "progress">;

const completedStatuses = new Set<DownloadStatus>(["completed", "seeding"]);
const activeStatuses = new Set<DownloadStatus>([
  "queued",
  "fetching_metadata",
  "downloading",
  "stalled",
  "paused",
  "checking",
  "moving"
]);

/** 判断下载引擎状态是否已经完成数据下载，做种属于完成态。 */
export function isCompletedDownloadStatus(status: DownloadStatus): boolean {
  return completedStatuses.has(status);
}

/** 判断下载引擎状态是否仍属于活动下载生命周期。 */
export function isActiveDownloadStatus(status: DownloadStatus): boolean {
  return activeStatuses.has(status);
}

/** 判断任务是否已完成数据下载，同时兼容进度已满但状态尚未切换的引擎。 */
export function isCompletedDownloadTask(task: DownloadProgressState): boolean {
  if (isCompletedDownloadStatus(task.status)) return true;
  if (task.status === "error" || task.status === "missing_files") return false;
  return task.progress >= 1;
}

/** 判断任务是否应计入下载中，进度已满的做种或状态延迟任务会被排除。 */
export function isActiveDownloadTask(task: DownloadProgressState): boolean {
  return isActiveDownloadStatus(task.status) && !isCompletedDownloadTask(task);
}
