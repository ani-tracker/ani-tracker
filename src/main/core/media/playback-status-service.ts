import { join, normalize } from "node:path";
import type { DownloadTask, Episode, MediaFile } from "@shared/domain";
import type { AppRepository } from "../repositories/app-repository";
import type { PlaybackProgressEvent } from "../platform/playback-monitor";
import { logger } from "../logger";

type PlaybackStatusRepository = Pick<AppRepository, "listDownloads" | "listEpisodes" | "listMediaFiles" | "upsertEpisode">;

/** 将播放器进度转换为关联单集的已看状态。 */
export class PlaybackStatusService {
  private readonly processedFiles = new Set<string>();

  constructor(
    private readonly repository: PlaybackStatusRepository,
    private readonly watchedThreshold = 90
  ) {}

  /** 达到观看阈值时查找关联单集并持久化 watched 状态。 */
  async handleProgress(event: PlaybackProgressEvent): Promise<void> {
    const fileKey = normalizePlaybackPath(event.filePath);
    if (event.percent < this.watchedThreshold || this.processedFiles.has(fileKey)) {
      return;
    }

    const [mediaFiles, downloads] = await Promise.all([
      this.repository.listMediaFiles(),
      this.repository.listDownloads()
    ]);
    const association = resolvePlaybackAssociation(event.filePath, mediaFiles, downloads);
    if (!association.animeId) {
      logger.warn("Playback progress has no anime association", { filePath: event.filePath, percent: event.percent });
      return;
    }

    const episodes = await this.repository.listEpisodes(association.animeId);
    const episode = resolvePlaybackEpisode(episodes, association.episodeId, association.episodeNo);
    if (!episode) {
      logger.warn("Playback progress has no episode association", {
        animeId: association.animeId,
        filePath: event.filePath,
        percent: event.percent
      });
      return;
    }

    if (episode.status !== "watched") {
      await this.repository.upsertEpisode({ ...episode, status: "watched" });
      logger.info("Episode marked watched from playback progress", {
        animeId: episode.animeId,
        episodeId: episode.id,
        episodeNo: episode.episodeNo,
        percent: event.percent
      });
    }
    this.processedFiles.add(fileKey);
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
