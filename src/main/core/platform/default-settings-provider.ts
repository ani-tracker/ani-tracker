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
        defaultTorrentEngine: "embedded",
        embedded: {
          enabled: true,
          listenPort: 51413,
          dhtEnabled: true,
          upnpEnabled: this.isEmbeddedUpnpEnabled(),
          maxActiveDownloads: this.getEmbeddedMaxActiveDownloads(),
          maxDownloadSpeed: 0,
          maxUploadSpeed: 0,
          seedingLimits: {
            enabled: false,
            ratioEnabled: false,
            ratioLimit: 1,
            timeEnabled: false,
            timeLimitMinutes: 120
          }
        },
        qbittorrent: {
          baseUrl: "http://127.0.0.1:18080",
          username: "admin",
          password: "ani-tracker",
          autoConnect: this.isManagedQbittorrentEnabled(),
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
            enabled: this.isManagedQbittorrentEnabled(),
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
        minimizeToTray: this.shouldMinimizeToTray(),
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

  /** 返回平台建议的并行下载数量。 */
  protected getEmbeddedMaxActiveDownloads(): number {
    return 3;
  }

  /** 返回平台是否默认启用 UPnP/NAT-PMP。 */
  protected isEmbeddedUpnpEnabled(): boolean {
    return true;
  }

  /** 返回平台是否支持应用托管 qBittorrent。 */
  protected isManagedQbittorrentEnabled(): boolean {
    return true;
  }

  /** 返回平台是否默认启用最小化到托盘。 */
  protected shouldMinimizeToTray(): boolean {
    return true;
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

export class LinuxDefaultSettingsProvider extends DefaultSettingsProvider {
  /** Linux 优先提供发行版常见的 mpv 与 VLC 命令路径。 */
  protected getPlayerProfiles(): PlayerProfile[] {
    return [
      {
        id: "mpv",
        name: "mpv",
        executablePath: "/usr/bin/mpv",
        argumentTemplate: "--force-window=yes \"{file}\"",
        supportsMadVr: false,
        platform: "linux"
      },
      {
        id: "vlc",
        name: "VLC",
        executablePath: "/usr/bin/vlc",
        argumentTemplate: "--play-and-exit \"{file}\"",
        supportsMadVr: false,
        platform: "linux"
      }
    ];
  }

  protected getDefaultPlayerProfileId(): string {
    return "auto";
  }
}

export class AndroidDefaultSettingsProvider extends DefaultSettingsProvider {
  /** Android 播放由移动宿主处理，不声明桌面可执行文件。 */
  protected getPlayerProfiles(): PlayerProfile[] {
    return [];
  }

  protected getDefaultPlayerProfileId(): string {
    return "auto";
  }

  protected getEmbeddedMaxActiveDownloads(): number {
    return 1;
  }

  protected isEmbeddedUpnpEnabled(): boolean {
    return false;
  }

  protected isManagedQbittorrentEnabled(): boolean {
    return false;
  }

  protected shouldMinimizeToTray(): boolean {
    return false;
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

  if (platform === "linux") {
    logger.info("Default settings provider selected", { platform, provider: "linux" });
    return new LinuxDefaultSettingsProvider(paths);
  }

  if (platform === "android") {
    logger.info("Default settings provider selected", { platform, provider: "android" });
    return new AndroidDefaultSettingsProvider(paths);
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

  if (process.platform === "linux") {
    return join(process.env.XDG_CACHE_HOME ?? join(app.getPath("home"), ".cache"), appName);
  }

  return join(userData, "cache");
}
