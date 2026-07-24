import type { DownloadStatus, DownloadTask } from "./domain";

type DownloadProgressState = Pick<DownloadTask, "status" | "progress"> & {
  files?: Array<Pick<DownloadTask["files"][number], "progress" | "selected">>;
};

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

/** 判断任务是否已完成数据下载，并兼容暂停做种与引擎状态延迟。 */
export function isCompletedDownloadTask(task: DownloadProgressState): boolean {
  if (task.status === "error" || task.status === "missing_files") return false;
  if (isCompletedDownloadStatus(task.status)) return true;

  const selectedFiles = task.files?.filter((file) => file.selected) ?? [];
  if (selectedFiles.length > 0) {
    return selectedFiles.every((file) => file.progress >= 1);
  }

  return task.progress >= 1;
}

/** 判断任务是否应计入下载中，进度已满的做种或状态延迟任务会被排除。 */
export function isActiveDownloadTask(task: DownloadProgressState): boolean {
  return isActiveDownloadStatus(task.status) && !isCompletedDownloadTask(task);
}
