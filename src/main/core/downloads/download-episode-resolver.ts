import { basename } from "node:path";
import type { DownloadTask, TorrentFile } from "@shared/domain";
import { parseReleaseTitle } from "../releases/release-title-parser";

const VIDEO_FILE_PATTERN = /\.(?:mkv|mp4|avi|m4v|mov|webm|ts)$/i;

/** 从视频文件名解析集数，并限制在资源标题声明的范围内。 */
export function inferTorrentFileEpisodeNo(
  task: Pick<DownloadTask, "name">,
  file: Pick<TorrentFile, "name">
): number | undefined {
  if (!VIDEO_FILE_PATTERN.test(file.name)) {
    return undefined;
  }

  const episodeNo = parseReleaseTitle(basename(file.name)).episodeNo;
  const range = parseReleaseTitle(task.name).episodeRange;
  if (episodeNo === undefined || (range && (episodeNo < range.start || episodeNo > range.end))) {
    return undefined;
  }
  return episodeNo;
}

/** 判断任务标题或视频文件是否表明它包含多集内容。 */
export function isMultiEpisodeDownloadTask(task: Pick<DownloadTask, "files" | "name">): boolean {
  const parsed = parseReleaseTitle(task.name);
  if (parsed.episodeRange || parsed.contentKind === "batch") {
    return true;
  }

  const episodeNumbers = new Set(
    task.files
      .map((file) => inferTorrentFileEpisodeNo(task, file))
      .filter((episodeNo): episodeNo is number => episodeNo !== undefined)
  );
  return episodeNumbers.size > 1;
}

/** 从下载任务的单集文件中解析唯一集数，批量种子存在多个集数时不做推断。 */
export function inferDownloadTaskEpisodeNo(task: Pick<DownloadTask, "files" | "name">): number | undefined {
  if (isMultiEpisodeDownloadTask(task)) {
    return undefined;
  }

  const videoFiles = task.files.filter((file) => VIDEO_FILE_PATTERN.test(file.name));
  const selectedFiles = videoFiles.filter((file) => file.selected);
  const candidateFiles = selectedFiles.length > 0 ? selectedFiles : videoFiles;
  const episodeNumbers = new Set<number>();

  for (const file of candidateFiles) {
    const episodeNo = inferTorrentFileEpisodeNo(task, file);
    if (episodeNo !== undefined) {
      episodeNumbers.add(episodeNo);
    }
  }

  if (episodeNumbers.size === 1) {
    return [...episodeNumbers][0];
  }
  if (episodeNumbers.size > 1) {
    return undefined;
  }

  return parseReleaseTitle(task.name).episodeNo;
}
