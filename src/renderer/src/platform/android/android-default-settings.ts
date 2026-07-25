import type { AppSettings } from "@shared/domain";
import type { AppDirectories } from "@shared/platform/ports";
import { createDefaultAppearanceSettings } from "@shared/theme";

const disabledSeedingLimits = {
  enabled: false,
  ratioEnabled: false,
  ratioLimit: 1,
  timeEnabled: false,
  timeLimitMinutes: 120
};

/** 根据原生目录创建不含桌面可执行文件和远程服务的 Android 默认设置。 */
export function createAndroidDefaultSettings(directories: AppDirectories): AppSettings {
  return {
    appearance: createDefaultAppearanceSettings(),
    download: {
      defaultDownloadDir: directories.downloadDir,
      createAnimeFolder: true,
      animeFolderPattern: "{year}-{month}/{title}",
      temporaryDownloadDir: `${directories.filesDir}/incomplete`,
      defaultTorrentEngine: "embedded",
      embedded: {
        enabled: true,
        listenPort: 51_413,
        dhtEnabled: true,
        upnpEnabled: false,
        maxActiveDownloads: 1,
        maxDownloadSpeed: 0,
        maxUploadSpeed: 0,
        seedingLimits: disabledSeedingLimits
      },
      qbittorrent: {
        baseUrl: "http://127.0.0.1:8080",
        username: "",
        autoConnect: false,
        downloadLimitKiBps: 0,
        uploadLimitKiBps: 0,
        seedingLimits: disabledSeedingLimits,
        managed: {
          enabled: false,
          startupTimeoutMs: 15_000
        }
      }
    },
    storage: {
      userDataDir: directories.userDataDir,
      databasePath: directories.databasePath,
      cacheDir: directories.cacheDir,
      logDir: directories.logDir,
      backupDir: directories.backupDir
    },
    players: [],
    defaultPlayerProfileId: "auto",
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
      ffprobePath: "",
      ffprobeTimeoutSeconds: 20,
      videoExtensions: [".mkv", ".mp4", ".avi"]
    },
    desktop: {
      minimizeToTray: false,
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
