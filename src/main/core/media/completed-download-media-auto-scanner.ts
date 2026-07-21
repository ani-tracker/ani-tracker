import type { DownloadTask } from "@shared/domain";
import { logger } from "../logger";
import type { AppRepository } from "../repositories/app-repository";
import { DownloadMediaScanner } from "./download-media-scanner";
import { resolveFfprobeCommands } from "./ffmpeg-binary-resolver";
import { FfprobeMediaProbeService } from "./ffprobe-media-probe-service";

export class CompletedDownloadMediaAutoScanner {
  private readonly inFlightTaskIds = new Set<string>();

  constructor(private readonly repository: AppRepository) {}

  async scanCompletedTasks(tasks: DownloadTask[]): Promise<void> {
    try {
      const completedTasks = tasks.filter((task) => task.status === "completed" || task.status === "seeding");
      if (!completedTasks.length) {
        return;
      }

      const [settings, mediaFiles] = await Promise.all([
        this.repository.getSettings(),
        this.repository.listMediaFiles()
      ]);
      const scannedTaskIds = new Set(mediaFiles.map((file) => file.downloadTaskId).filter(Boolean) as string[]);
      const [ffprobePath, ...fallbackFfprobePaths] = resolveFfprobeCommands({
        configuredPath: settings.media.ffprobePath
      });
      const probeService = new FfprobeMediaProbeService({
        ffprobePath,
        fallbackFfprobePaths,
        timeoutMs: settings.media.ffprobeTimeoutSeconds * 1000
      });
      const scanner = new DownloadMediaScanner(probeService, settings);

      for (const task of completedTasks) {
        if (scannedTaskIds.has(task.id) || this.inFlightTaskIds.has(task.id) || !task.files.length) {
          continue;
        }

        this.inFlightTaskIds.add(task.id);
        try {
          const result = await scanner.scanTask(task);
          if (result.mediaFiles.length) {
            await this.repository.upsertMediaFiles(result.mediaFiles);
          }
          logger.info("Completed download media scan finished", {
            taskId: task.id,
            mediaFiles: result.mediaFiles.length,
            skippedFiles: result.skippedFiles.length,
            errors: result.errors.length
          });
        } catch (error) {
          logger.warn("Completed download media scan failed", {
            taskId: task.id,
            message: error instanceof Error ? error.message : "unknown error"
          });
        } finally {
          this.inFlightTaskIds.delete(task.id);
        }
      }
    } catch (error) {
      logger.warn("Completed download media auto scan skipped", {
        message: error instanceof Error ? error.message : "unknown error"
      });
    }
  }
}
