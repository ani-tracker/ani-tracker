import { join, normalize } from "node:path";
import type { ReportPlaybackProgressInput } from "@shared/contracts";
import type { DownloadTask, Episode, MediaFile } from "@shared/domain";
import type { AppRepository } from "../repositories/app-repository";
import type { PlaybackProgressEvent } from "../platform/playback-monitor";
import { logger } from "../logger";

type PlaybackStatusRepository = Pick<AppRepository, "listDownloads" | "listEpisodes" | "listMediaFiles" | "upsertEpisode">;

/** 将播放器进度转换为关联单集的已看状态。 */
export class PlaybackStatusService {
  private readonly processedPlaybackKeys = new Set<string>();

  constructor(
    private readonly repository: PlaybackStatusRepository,
    private readonly watchedThreshold = 90
  ) {}

  /** 达到观看阈值时查找关联单集并持久化 watched 状态。 */
  async handleProgress(event: PlaybackProgressEvent): Promise<boolean> {
    const fileKey = normalizePlaybackPath(event.filePath);
    if (!this.shouldProcess(fileKey, event.percent)) {
      return false;
    }

    const [mediaFiles, downloads] = await Promise.all([
      this.repository.listMediaFiles(),
      this.repository.listDownloads()
    ]);
    const association = resolvePlaybackAssociation(event.filePath, mediaFiles, downloads);
    return this.markAssociatedEpisodeWatched(fileKey, event.percent, association, {
      filePath: event.filePath
    });
  }

  /** 按下载任务和文件索引处理远程播放器上报。 */
  async handleTaskProgress(input: ReportPlaybackProgressInput): Promise<boolean> {
    const playbackKey = `task:${input.taskId}:${input.fileIndex ?? "default"}`;
    if (!this.shouldProcess(playbackKey, input.percent)) {
      return false;
    }

    const [mediaFiles, downloads] = await Promise.all([
      this.repository.listMediaFiles(),
      this.repository.listDownloads()
    ]);
    const task = downloads.find((item) => item.id === input.taskId);
    if (!task) {
      logger.warn("Playback progress task not found", { taskId: input.taskId, fileIndex: input.fileIndex });
      return false;
    }

    const association = resolveTaskPlaybackAssociation(task, input.fileIndex, mediaFiles);
    return this.markAssociatedEpisodeWatched(playbackKey, input.percent, association, {
      taskId: input.taskId,
      fileIndex: input.fileIndex
    });
  }

  /** 判断播放进度是否达到阈值且尚未处理。 */
  private shouldProcess(playbackKey: string, percent: number): boolean {
    return Number.isFinite(percent) && percent >= this.watchedThreshold &&
      !this.processedPlaybackKeys.has(playbackKey);
  }

  /** 将已解析的播放关联幂等写入单集状态。 */
  private async markAssociatedEpisodeWatched(
    playbackKey: string,
    percent: number,
    association: PlaybackAssociation,
    context: Record<string, unknown>
  ): Promise<boolean> {
    if (!association.animeId) {
      logger.warn("Playback progress has no anime association", { ...context, percent });
      return false;
    }

    const episodes = await this.repository.listEpisodes(association.animeId);
    const episode = resolvePlaybackEpisode(episodes, association.episodeId, association.episodeNo);
    if (!episode) {
      logger.warn("Playback progress has no episode association", {
        animeId: association.animeId,
        ...context,
        percent
      });
      return false;
    }

    if (episode.status !== "watched") {
      await this.repository.upsertEpisode({ ...episode, status: "watched" });
      logger.info("Episode marked watched from playback progress", {
        animeId: episode.animeId,
        episodeId: episode.id,
        episodeNo: episode.episodeNo,
        percent,
        ...context
      });
    }
    this.processedPlaybackKeys.add(playbackKey);
    return true;
  }
}

interface PlaybackAssociation {
  animeId?: string;
  episodeId?: string;
  episodeNo?: number;
}

/** 优先使用媒体扫描关联，缺失时回退到下载任务文件路径。 */
function resolvePlaybackAssociation(
  filePath: string,
  mediaFiles: MediaFile[],
  downloads: DownloadTask[]
): PlaybackAssociation {
  const targetPath = normalizePlaybackPath(filePath);
  const mediaFile = mediaFiles.find((item) => normalizePlaybackPath(item.filePath) === targetPath);
  if (mediaFile) {
    return { animeId: mediaFile.animeId, episodeId: mediaFile.episodeId };
  }

  const task = downloads.find((item) =>
    item.files.some((file) => normalizePlaybackPath(join(item.savePath, file.name)) === targetPath)
  );
  return {
    animeId: task?.animeId,
    episodeId: task?.episodeId,
    episodeNo: task?.episodeNo
  };
}

/** 使用任务关联信息定位远程播放文件对应的单集。 */
function resolveTaskPlaybackAssociation(
  task: DownloadTask,
  fileIndex: number | undefined,
  mediaFiles: MediaFile[]
): PlaybackAssociation {
  const taskFile = fileIndex === undefined
    ? undefined
    : task.files.find((file) => file.index === fileIndex);
  const mediaFile = mediaFiles.find((item) =>
    item.downloadTaskId === task.id &&
    (!taskFile || item.fileName === taskFile.name ||
      normalizePlaybackPath(item.filePath).endsWith(normalizePlaybackPath(taskFile.name)))
  );
  return {
    animeId: mediaFile?.animeId ?? task.animeId,
    episodeId: mediaFile?.episodeId ?? task.episodeId,
    episodeNo: task.episodeNo
  };
}

/** 按稳定单集 ID 或集数定位播放文件对应的单集。 */
function resolvePlaybackEpisode(episodes: Episode[], episodeId?: string, episodeNo?: number): Episode | undefined {
  return (
    (episodeId ? episodes.find((episode) => episode.id === episodeId) : undefined) ??
    (episodeNo !== undefined ? episodes.find((episode) => episode.episodeNo === episodeNo) : undefined)
  );
}

/** 统一路径格式，Windows 下忽略路径大小写差异。 */
function normalizePlaybackPath(filePath: string): string {
  const normalized = normalize(filePath);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
