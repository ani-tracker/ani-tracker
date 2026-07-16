import { basename } from "node:path";
import type { DownloadTask } from "@shared/domain";
import { parseReleaseTitle } from "../releases/release-title-parser";

const VIDEO_FILE_PATTERN = /\.(?:mkv|mp4|avi|m4v|mov|webm|ts)$/i;

/** 从下载任务的单集文件中解析唯一集数，批量种子存在多个集数时不做推断。 */
export function inferDownloadTaskEpisodeNo(task: Pick<DownloadTask, "files" | "name">): number | undefined {
  const videoFiles = task.files.filter((file) => VIDEO_FILE_PATTERN.test(file.name));
  const selectedFiles = videoFiles.filter((file) => file.selected);
  const candidateFiles = selectedFiles.length > 0 ? selectedFiles : videoFiles;
  const episodeNumbers = new Set<number>();

  for (const file of candidateFiles) {
    const episodeNo = parseReleaseTitle(basename(file.name)).episodeNo;
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
