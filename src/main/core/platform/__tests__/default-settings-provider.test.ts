import { strict as assert } from "node:assert";
import { join } from "node:path";
import { test } from "node:test";
import type { AppSettings } from "@shared/domain";
import {
  GenericDefaultSettingsProvider,
  MacDefaultSettingsProvider,
  WindowsDefaultSettingsProvider,
  createDefaultSettingsProvider,
  type DefaultSettingsPaths
} from "../default-settings-provider";

const paths: DefaultSettingsPaths = {
  downloads: "/test/Downloads",
  userData: "/test/UserData",
  cache: "/test/Cache",
  logs: "/test/Logs"
};

test("MacDefaultSettingsProvider 生成 macOS 默认目录和 IINA 播放器模板", () => {
  const settings = new MacDefaultSettingsProvider(paths).getSettings();

  assertSharedDefaults(settings);
  assert.equal(settings.defaultPlayerProfileId, "iina");
  assert.deepEqual(
    settings.players.map((player) => player.id),
    ["iina", "mpv"]
  );
  assert.deepEqual(settings.players[0], {
    id: "iina",
    name: "IINA",
    executablePath: "/Applications/IINA.app/Contents/MacOS/iina-cli",
    argumentTemplate: "\"{file}\"",
    supportsMadVr: false,
    platform: "macos"
  });
});

test("WindowsDefaultSettingsProvider 生成 Windows 默认目录和 PotPlayer 播放器模板", () => {
  const settings = new WindowsDefaultSettingsProvider(paths).getSettings();

  assertSharedDefaults(settings);
  assert.equal(settings.defaultPlayerProfileId, "potplayer");
  assert.deepEqual(
    settings.players.map((player) => player.id),
    ["potplayer", "mpv"]
  );
  assert.deepEqual(settings.players[0], {
    id: "potplayer",
    name: "PotPlayer",
    executablePath: "C:\\Program Files\\DAUM\\PotPlayer\\PotPlayerMini64.exe",
    argumentTemplate: "\"{file}\"",
    supportsMadVr: true,
    platform: "windows"
  });
});

test("GenericDefaultSettingsProvider 只提供跨平台 mpv 模板", () => {
  const settings = new GenericDefaultSettingsProvider(paths).getSettings();

  assertSharedDefaults(settings);
  assert.equal(settings.defaultPlayerProfileId, "mpv");
  assert.deepEqual(settings.players, [
    {
      id: "mpv",
      name: "mpv",
      executablePath: "mpv",
      argumentTemplate: "--force-window=yes \"{file}\"",
      supportsMadVr: false,
      platform: "any"
    }
  ]);
});

test("createDefaultSettingsProvider 根据 process.platform 兼容值选择子类", () => {
  assert.ok(createDefaultSettingsProvider("darwin", paths) instanceof MacDefaultSettingsProvider);
  assert.ok(createDefaultSettingsProvider("win32", paths) instanceof WindowsDefaultSettingsProvider);
  assert.ok(createDefaultSettingsProvider("linux", paths) instanceof GenericDefaultSettingsProvider);
});

function assertSharedDefaults(settings: AppSettings): void {
  assert.equal(settings.download.defaultDownloadDir, join(paths.downloads, "Ani Tracker"));
  assert.equal(settings.download.temporaryDownloadDir, join(paths.userData, "incomplete"));
  assert.equal(settings.download.defaultTorrentEngine, "qbittorrent");
  assert.deepEqual(settings.download.embedded, {
    enabled: false,
    listenPort: 51413,
    maxActiveDownloads: 3
  });
  assert.deepEqual(settings.download.qbittorrent, {
    baseUrl: "http://127.0.0.1:18080",
    username: "admin",
    password: "ani-tracker",
    autoConnect: true,
    managed: {
      enabled: true,
      profileDir: join(paths.userData, "qbittorrent"),
      startupTimeoutMs: 15_000
    }
  });

  assert.equal(settings.storage.userDataDir, paths.userData);
  assert.equal(settings.storage.databasePath, join(paths.userData, "ani-tracker.sqlite"));
  assert.equal(settings.storage.cacheDir, paths.cache);
  assert.equal(settings.storage.logDir, paths.logs);
  assert.equal(settings.storage.backupDir, join(paths.userData, "backups"));

  assert.deepEqual(settings.automation, {
    scheduledCheckEnabled: true,
    checkIntervalMinutes: 30,
    notifyOnNewEpisode: true,
    autoDownloadEnabledGlobally: true,
    fallbackWhenDefaultFansubMissing: "wait"
  });
  assert.deepEqual(settings.media, {
    ffprobePath: "ffprobe",
    ffprobeTimeoutSeconds: 20,
    videoExtensions: [".mkv", ".mp4", ".avi"]
  });
  assert.deepEqual(settings.desktop, {
    minimizeToTray: true,
    launchAtLogin: false
  });
  assert.deepEqual(settings.network, {
    metadataProxy: {
      mode: "off",
      timeoutMs: 15_000
    }
  });
}
