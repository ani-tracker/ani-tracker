import type { AppSettings, DownloadTask } from "./domain";

export const BUILTIN_PLAYER_PROFILE_ID = "builtin";

export interface MediaPlaybackTarget {
  filePath: string;
  taskId?: string;
  fileIndex?: number;
}

/** 判断当前默认播放目标是否为应用内播放器。 */
export function usesBuiltinPlayer(
  settings: Pick<AppSettings, "defaultPlayerProfileId">
): boolean {
  return settings.defaultPlayerProfileId === BUILTIN_PLAYER_PROFILE_ID;
}

/** 按下载目录和相对文件名解析媒体对应的 torrent 文件索引。 */
export function resolvePlaybackFileIndex(
  target: Pick<MediaPlaybackTarget, "filePath" | "fileIndex">,
  task: {
    savePath: DownloadTask["savePath"];
    files: Array<Pick<DownloadTask["files"][number], "name" | "index">>;
  }
): number | undefined {
  if (target.fileIndex !== undefined) {
    return target.fileIndex;
  }

  const targetPath = normalizePlaybackPath(target.filePath);
  const exactMatch = task.files.find((file) =>
    normalizePlaybackPath(`${task.savePath}/${file.name}`) === targetPath
  );
  if (exactMatch) {
    return exactMatch.index;
  }

  const foldedTargetPath = targetPath.toLowerCase();
  return task.files.find((file) =>
    normalizePlaybackPath(`${task.savePath}/${file.name}`).toLowerCase() === foldedTargetPath
  )?.index;
}

/** 统一主流桌面平台的路径分隔符和重复斜杠。 */
function normalizePlaybackPath(value: string): string {
  return value.replaceAll("\\", "/").replace(/\/{2,}/g, "/").replace(/\/$/, "");
}
