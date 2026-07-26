import {
  isActiveDownloadTask,
  isCompletedDownloadTask,
} from "./download-status";
import type { DownloadTask, Episode, TorrentFile } from "./domain";

export interface EpisodeDownloadLink {
  task: DownloadTask;
  file?: TorrentFile;
  progress: number;
  completed: boolean;
  active: boolean;
}

export interface AnimeDownloadSummary {
  linked: number;
  completed: number;
  active: number;
}

/** 查找任务级或合集文件级单集关联，并返回该文件的真实进度。 */
export function findEpisodeDownloadLink(
  downloadTasks: DownloadTask[],
  episode: Episode,
): EpisodeDownloadLink | undefined {
  for (const task of downloadTasks) {
    const file = task.files.find(
      (item) => item.selected && matchesEpisode(item, episode),
    );
    if (file) return buildLink(task, file);
  }

  const task = downloadTasks.find(
    (item) =>
      item.episodeId === episode.id || item.episodeNo === episode.episodeNo,
  );
  return task ? buildLink(task) : undefined;
}

/** 汇总番剧任务和合集文件关联的唯一集数。 */
export function summarizeAnimeDownloads(
  downloadTasks: DownloadTask[],
  animeId: string,
): AnimeDownloadSummary {
  const linked = new Set<number>();
  const completed = new Set<number>();
  const active = new Set<number>();

  for (const task of downloadTasks) {
    if (task.animeId !== animeId) continue;
    const linkedFiles = task.files.filter(
      (file): file is TorrentFile & { episodeNo: number } =>
        file.selected && file.episodeNo !== undefined,
    );
    for (const file of linkedFiles) {
      addEpisodeState(
        linked,
        completed,
        active,
        file.episodeNo,
        buildLink(task, file),
      );
    }
    if (task.episodeNo !== undefined) {
      addEpisodeState(
        linked,
        completed,
        active,
        task.episodeNo,
        buildLink(task),
      );
    }
  }

  for (const episodeNo of completed) active.delete(episodeNo);
  return {
    linked: linked.size,
    completed: completed.size,
    active: active.size,
  };
}

function matchesEpisode(file: TorrentFile, episode: Episode): boolean {
  return file.episodeId === episode.id || file.episodeNo === episode.episodeNo;
}

function buildLink(
  task: DownloadTask,
  file?: TorrentFile,
): EpisodeDownloadLink {
  const progress = file?.progress ?? task.progress;
  const completed = isCompletedDownloadTask(task) || progress >= 1;
  return {
    task,
    file,
    progress,
    completed,
    active: isActiveDownloadTask(task) && !completed,
  };
}

function addEpisodeState(
  linked: Set<number>,
  completed: Set<number>,
  active: Set<number>,
  episodeNo: number,
  link: EpisodeDownloadLink,
) {
  linked.add(episodeNo);
  if (link.completed) completed.add(episodeNo);
  else if (link.active) active.add(episodeNo);
}
