import { app } from "electron";
import { join } from "node:path";
import type { AppSettings, PlayerProfile } from "@shared/domain";
import { createDefaultAppearanceSettings } from "@shared/theme";
import { logger } from "../logger";

export interface DefaultSettingsPaths {
  downloads: string;
  userData: string;
  cache: string;
  logs: string;
}

export abstract class DefaultSettingsProvider {
  constructor(protected readonly paths: DefaultSettingsPaths) {}

  getSettings(): AppSettings {
    const userDataDir = this.paths.userData;

    return {
      appearance: createDefaultAppearanceSettings(),
      download: {
        defaultDownloadDir: this.getDefaultDownloadDir(),
        createAnimeFolder: true,
        animeFolderPattern: "{year}-{month}/{title}",
        temporaryDownloadDir: join(userDataDir, "incomplete"),
        defaultTorrentEngine: "qbittorrent",
        embedded: {
          enabled: false,
          listenPort: 51413,
          maxActiveDownloads: 3
        },
        qbittorrent: {
          baseUrl: "http://127.0.0.1:18080",
          username: "admin",
          password: "ani-tracker",
          autoConnect: true,
          downloadLimitKiBps: 0,
          uploadLimitKiBps: 0,
          seedingLimits: {
            enabled: false,
            ratioEnabled: false,
            ratioLimit: 1,
            timeEnabled: false,
            timeLimitMinutes: 120
          },
          managed: {
            enabled: true,
            profileDir: join(userDataDir, "qbittorrent"),
            startupTimeoutMs: 15_000
          }
        }
      },
      storage: {
        userDataDir,
        databasePath: join(userDataDir, "ani-tracker.sqlite"),
        cacheDir: this.paths.cache,
        logDir: this.paths.logs,
        backupDir: join(userDataDir, "backups")
      },
      players: this.getPlayerProfiles(),
      defaultPlayerProfileId: this.getDefaultPlayerProfileId(),
      automation: {
        scheduledCheckEnabled: true,
        checkIntervalMinutes: 30,
        notifyOnNewEpisode: true,
        autoDownloadEnabledGlobally: true,
        fallbackWhenDefaultFansubMissing: "wait",
        candidateFansubNames: []
      },
      sourceSync: {
        enabled: true,
        dailyTime: "09:00"
      },
      media: {
        ffprobePath: "ffprobe",
        ffprobeTimeoutSeconds: 20,
        videoExtensions: [".mkv", ".mp4", ".avi"]
      },
      desktop: {
        minimizeToTray: true,
        launchAtLogin: false
      },
      network: {
        metadataProxy: {
          mode: "system",
          timeoutMs: 15_000
        },
        remoteAccess: {
          lanEnabled: false,
          port: 18_083
        }
      }
    };
  }

  protected getDefaultDownloadDir(): string {
    return join(this.paths.downloads, "Ani Tracker");
  }

  protected abstract getPlayerProfiles(): PlayerProfile[];

  protected abstract getDefaultPlayerProfileId(): string;
}

export class MacDefaultSettingsProvider extends DefaultSettingsProvider {
  protected getPlayerProfiles(): PlayerProfile[] {
    return [
      {
        id: "iina",
        name: "IINA",
        executablePath: "/Applications/IINA.app/Contents/MacOS/iina-cli",
        argumentTemplate: "--no-stdin \"{file}\"",
        supportsMadVr: false,
        platform: "macos"
      },
      createMpvProfile()
    ];
  }

  protected getDefaultPlayerProfileId(): string {
    return "auto";
  }
}

export class WindowsDefaultSettingsProvider extends DefaultSettingsProvider {
  protected getPlayerProfiles(): PlayerProfile[] {
    return [
      {
        id: "pure-codec-potplayer",
        name: "完美解码版 PotPlayer",
        executablePath: "C:\\Program Files\\Pure Codec\\x64\\PotPlayerMini64.exe",
        argumentTemplate: "\"{file}\"",
        supportsMadVr: true,
        platform: "windows"
      },
      {
        id: "potplayer",
        name: "PotPlayer",
        executablePath: "C:\\Program Files\\DAUM\\PotPlayer\\PotPlayerMini64.exe",
        argumentTemplate: "\"{file}\"",
        supportsMadVr: true,
        platform: "windows"
      },
      createMpvProfile()
    ];
  }

  protected getDefaultPlayerProfileId(): string {
    return "auto";
  }
}

export class GenericDefaultSettingsProvider extends DefaultSettingsProvider {
  protected getPlayerProfiles(): PlayerProfile[] {
    return [createMpvProfile()];
  }

  protected getDefaultPlayerProfileId(): string {
    return "auto";
  }
}

export function createDefaultSettingsProvider(
  platform = process.platform,
  paths: DefaultSettingsPaths = getElectronDefaultSettingsPaths()
): DefaultSettingsProvider {
  if (platform === "darwin") {
    logger.info("Default settings provider selected", { platform, provider: "macos" });
    return new MacDefaultSettingsProvider(paths);
  }

  if (platform === "win32") {
    logger.info("Default settings provider selected", { platform, provider: "windows" });
    return new WindowsDefaultSettingsProvider(paths);
  }

  logger.info("Default settings provider selected", { platform, provider: "generic" });
  return new GenericDefaultSettingsProvider(paths);
}

function createMpvProfile(): PlayerProfile {
  return {
    id: "mpv",
    name: "mpv",
    executablePath: "mpv",
    argumentTemplate: "--force-window=yes \"{file}\"",
    supportsMadVr: false,
    platform: "any"
  };
}

function getElectronDefaultSettingsPaths(): DefaultSettingsPaths {
  const userData = app.getPath("userData");

  return {
    downloads: app.getPath("downloads"),
    userData,
    cache: getDefaultCacheDir(userData),
    logs: app.getPath("logs")
  };
}

function getDefaultCacheDir(userData: string): string {
  const appName = app.getName();

  if (process.platform === "darwin") {
    return join(app.getPath("home"), "Library", "Caches", appName);
  }

  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    return join(process.env.LOCALAPPDATA, appName, "Cache");
  }

  return join(userData, "cache");
}
