import { stat } from "node:fs/promises";
import { shell } from "electron";
import type { PlayerService } from "@shared/contracts";
import type { AppSettings, PlayerProfile } from "@shared/domain";
import { PlayerAdapterFactory } from "./player-adapter";

export class PlayerLauncherService implements PlayerService {
  constructor(
    private readonly settings: AppSettings,
    private readonly adapterFactory = new PlayerAdapterFactory()
  ) {}

  /** 校验媒体文件并通过配置的播放器启动播放。 */
  async play(filePath: string, profileId?: string): Promise<void> {
    const fileStats = await stat(filePath).catch(() => undefined);
    if (!fileStats?.isFile()) {
      throw new Error(`媒体文件不存在：${filePath}`);
    }

    const profile = this.resolveProfile(profileId);

    if (!profile) {
      const errorMessage = await shell.openPath(filePath);
      if (errorMessage) {
        throw new Error(errorMessage);
      }
      return;
    }

    await this.adapterFactory.resolve(profile).play(profile, filePath);
  }

  /** 在系统文件管理器中定位媒体文件。 */
  async reveal(filePath: string): Promise<void> {
    const fileStats = await stat(filePath).catch(() => undefined);
    if (!fileStats?.isFile()) {
      throw new Error(`媒体文件不存在：${filePath}`);
    }
    shell.showItemInFolder(filePath);
  }

  private resolveProfile(profileId?: string): PlayerProfile | undefined {
    const targetId = profileId ?? this.settings.defaultPlayerProfileId;
    return this.settings.players.find((profile) => profile.id === targetId) ?? this.settings.players[0];
  }
}
