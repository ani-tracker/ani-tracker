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
import { mergeSettings } from "../../repositories/app-repository";

const paths: DefaultSettingsPaths = {
  downloads: "/test/Downloads",
  userData: "/test/UserData",
  cache: "/test/Cache",
  logs: "/test/Logs"
};

test("MacDefaultSettingsProvider 生成 macOS 默认目录和 IINA 播放器模板", () => {
  const settings = new MacDefaultSettingsProvider(paths).getSettings();

  assertSharedDefaults(settings);
  assert.equal(settings.defaultPlayerProfileId, "auto");
  assert.deepEqual(
    settings.players.map((player) => player.id),
    ["iina", "mpv"]
  );
  assert.deepEqual(settings.players[0], {
    id: "iina",
    name: "IINA",
    executablePath: "/Applications/IINA.app/Contents/MacOS/iina-cli",
    argumentTemplate: "--no-stdin \"{file}\"",
    supportsMadVr: false,
    platform: "macos"
  });
});

test("WindowsDefaultSettingsProvider 生成 Windows 四种播放器选择模板", () => {
  const settings = new WindowsDefaultSettingsProvider(paths).getSettings();

  assertSharedDefaults(settings);
  assert.equal(settings.defaultPlayerProfileId, "auto");
  assert.deepEqual(
    settings.players.map((player) => player.id),
    ["pure-codec-potplayer", "potplayer", "mpv"]
  );
  assert.deepEqual(settings.players[0], {
    id: "pure-codec-potplayer",
    name: "完美解码版 PotPlayer",
    executablePath: "C:\\Program Files\\Pure Codec\\x64\\PotPlayerMini64.exe",
    argumentTemplate: "\"{file}\"",
    supportsMadVr: true,
    platform: "windows"
  });
  assert.deepEqual(settings.players[1], {
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
  assert.equal(settings.defaultPlayerProfileId, "auto");
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

test("mergeSettings 拒绝非法远程端口并接受有效端口", () => {
  const current = new WindowsDefaultSettingsProvider(paths).getSettings();
  const invalid = mergeSettings(current, { network: { remoteAccess: { lanEnabled: true, port: 80 } } } as Partial<AppSettings>);
  const valid = mergeSettings(current, { network: { remoteAccess: { lanEnabled: true, port: 18_183 } } } as Partial<AppSettings>);

  assert.equal(invalid.network.remoteAccess.port, 18_083);
  assert.equal(valid.network.remoteAccess.port, 18_183);
});

test("mergeSettings 保留旧播放器自定义路径并补入新平台选项", () => {
  const current = new WindowsDefaultSettingsProvider(paths).getSettings();
  const storedPlayers = current.players
    .filter((player) => player.id !== "pure-codec-potplayer")
    .map((player) => player.id === "potplayer"
      ? { ...player, executablePath: "D:\\Players\\PotPlayerMini64.exe" }
      : player);
  const merged = mergeSettings(current, { players: storedPlayers });

  assert.deepEqual(merged.players.map((player) => player.id), ["pure-codec-potplayer", "potplayer", "mpv"]);
  assert.equal(merged.players.find((player) => player.id === "potplayer")?.executablePath, "D:\\Players\\PotPlayerMini64.exe");
});

function assertSharedDefaults(settings: AppSettings): void {
  assert.deepEqual(settings.appearance, {
    themeMode: "system",
    themePackId: "default",
    customThemePacks: []
  });
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
    },
    remoteAccess: {
      lanEnabled: false,
      port: 18_083
    }
  });
}
