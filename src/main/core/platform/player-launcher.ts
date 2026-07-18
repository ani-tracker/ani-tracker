import { stat } from "node:fs/promises";
import { shell } from "electron";
import type { PlayerService } from "@shared/contracts";
import type { AppSettings } from "@shared/domain";
import { logger } from "../logger";
import { PlayerAdapterFactory } from "./player-adapter";
import { PlayerDetectionService } from "./player-detection-service";
import type { PlaybackProgressListener } from "./playback-monitor";

export interface PlayerLauncherOptions {
  adapterFactory?: PlayerAdapterFactory;
  detectionService?: Pick<PlayerDetectionService, "resolve">;
  onPlaybackProgress?: PlaybackProgressListener;
}

export class PlayerLauncherService implements PlayerService {
  private readonly adapterFactory: PlayerAdapterFactory;
  private readonly detectionService: Pick<PlayerDetectionService, "resolve">;
  private readonly onPlaybackProgress?: PlaybackProgressListener;

  constructor(
    private readonly settings: AppSettings,
    options: PlayerLauncherOptions = {}
  ) {
    this.adapterFactory = options.adapterFactory ?? new PlayerAdapterFactory();
    this.detectionService = options.detectionService ?? new PlayerDetectionService();
    this.onPlaybackProgress = options.onPlaybackProgress;
  }

  /** 校验媒体文件并通过配置的播放器启动播放。 */
  async play(filePath: string, profileId?: string): Promise<void> {
    const fileStats = await stat(filePath).catch(() => undefined);
    if (!fileStats?.isFile()) {
      throw new Error(`媒体文件不存在：${filePath}`);
    }

    if (this.settings.players.length === 0) {
      const errorMessage = await shell.openPath(filePath);
      if (errorMessage) {
        throw new Error(errorMessage);
      }
      return;
    }

    const profile = this.detectionService.resolve(this.settings, profileId);
    try {
      await this.adapterFactory.resolve(profile).play(profile, filePath, this.onPlaybackProgress);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("Media player launch failed", { profileId: profile.id, executablePath: profile.executablePath, message });
      throw new Error(`启动 ${profile.name} 失败：${message}。请前往“设置 > 播放器配置”检查可执行文件路径。`);
    }
  }

  /** 在系统文件管理器中定位媒体文件。 */
  async reveal(filePath: string): Promise<void> {
    const fileStats = await stat(filePath).catch(() => undefined);
    if (!fileStats?.isFile()) {
      throw new Error(`媒体文件不存在：${filePath}`);
    }
    shell.showItemInFolder(filePath);
  }
}
