import { isAbsolute, join } from "node:path";
import type { MediaProbeService, MediaScanResult } from "@shared/contracts";
import type { AppSettings, DownloadTask, TorrentFile } from "@shared/domain";

const DEFAULT_VIDEO_EXTENSIONS = [".mkv", ".mp4", ".avi"];

export class DownloadMediaScanner {
  private readonly videoExtensions: Set<string>;

  constructor(
    private readonly probeService: MediaProbeService,
    settings: AppSettings
  ) {
    this.videoExtensions = new Set(
      (settings.media.videoExtensions.length ? settings.media.videoExtensions : DEFAULT_VIDEO_EXTENSIONS).map(
        normalizeExtension
      )
    );
  }

  async scanTask(task: DownloadTask): Promise<MediaScanResult> {
    const result: MediaScanResult = {
      taskId: task.id,
      mediaFiles: [],
      skippedFiles: [],
      errors: []
    };

    for (const file of task.files) {
      const skipReason = this.getSkipReason(task, file);
      if (skipReason) {
        result.skippedFiles.push({
          name: file.name,
          reason: skipReason
        });
        continue;
      }

      const filePath = resolveTorrentFilePath(task, file);
      try {
        const mediaFile = await this.probeService.probe(filePath, {
          animeId: task.animeId,
          episodeId: file.episodeId ?? task.episodeId,
          downloadTaskId: task.id,
          size: file.size,
          downloadedAt: task.completedAt ?? new Date().toISOString()
        });
        result.mediaFiles.push(mediaFile);
      } catch (error) {
        result.errors.push({
          filePath,
          message: error instanceof Error ? error.message : "媒体文件探测失败"
        });
      }
    }

    return result;
  }

  private getSkipReason(task: DownloadTask, file: TorrentFile): string | null {
    if (!file.selected) {
      return "未选择下载";
    }

    if (!isVideoFile(file.name, this.videoExtensions)) {
      return "非视频文件";
    }

    if (!isCompleted(task, file)) {
      return "文件尚未下载完成";
    }

    return null;
  }
}

function resolveTorrentFilePath(task: DownloadTask, file: TorrentFile): string {
  if (isAbsolute(file.name)) {
    return file.name;
  }

  return join(task.savePath, file.name);
}

function isVideoFile(fileName: string, extensions: Set<string>): boolean {
  const normalized = fileName.toLowerCase();
  return [...extensions].some((extension) => normalized.endsWith(extension));
}

function isCompleted(task: DownloadTask, file: TorrentFile): boolean {
  return task.status === "completed" || task.status === "seeding" || file.progress >= 1;
}

function normalizeExtension(value: string): string {
  const trimmed = value.trim().toLowerCase();
  return trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
}
