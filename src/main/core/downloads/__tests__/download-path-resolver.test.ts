import { strict as assert } from "node:assert";
import { test } from "node:test";
import { join } from "node:path";
import type { AppSettings, MyAnime } from "@shared/domain";
import { resolveAnimeDownloadPath } from "../download-path-resolver";

test("resolveAnimeDownloadPath applies the configured anime folder template", () => {
  assert.equal(
    resolveAnimeDownloadPath(createSettings(), createAnime()),
    join("/downloads/Ani Tracker", "2026-07", "Test_ Anime")
  );
});

test("resolveAnimeDownloadPath prefers the per-anime directory override", () => {
  const anime = { ...createAnime(), downloadDir: "/media/anime/custom" };
  assert.equal(resolveAnimeDownloadPath(createSettings(), anime), "/media/anime/custom");
});

test("resolveAnimeDownloadPath ignores traversal segments in templates", () => {
  const settings = createSettings();
  settings.download.animeFolderPattern = "../../{title}";
  assert.equal(resolveAnimeDownloadPath(settings, createAnime()), join("/downloads/Ani Tracker", "Test_ Anime"));
});

function createSettings(): AppSettings {
  return {
    download: {
      defaultDownloadDir: "/downloads/Ani Tracker",
      createAnimeFolder: true,
      animeFolderPattern: "{year}-{month}/{title}",
      defaultTorrentEngine: "embedded",
      embedded: { enabled: true },
      qbittorrent: {
        baseUrl: "http://127.0.0.1:18080",
        username: "admin",
        autoConnect: false,
        downloadLimitKiBps: 0,
        uploadLimitKiBps: 0,
        seedingLimits: {
          enabled: false,
          ratioEnabled: false,
          ratioLimit: 1,
          timeEnabled: false,
          timeLimitMinutes: 120
        },
        managed: { enabled: false, startupTimeoutMs: 15_000 }
      }
    },
    storage: { userDataDir: "/data", databasePath: "/data/app.db", cacheDir: "/cache", logDir: "/logs" },
    players: [],
    automation: {
      scheduledCheckEnabled: false,
      checkIntervalMinutes: 30,
      notifyOnNewEpisode: false,
      autoDownloadEnabledGlobally: false,
      fallbackWhenDefaultFansubMissing: "wait"
    },
    media: { ffprobePath: "ffprobe", ffprobeTimeoutSeconds: 20, videoExtensions: [".mkv"] },
    desktop: { minimizeToTray: false, launchAtLogin: false },
    network: {
      metadataProxy: { mode: "off", timeoutMs: 15_000 },
      remoteAccess: { lanEnabled: false, port: 18_083 }
    }
  };
}

function createAnime(): MyAnime {
  const now = new Date().toISOString();
  return {
    id: "my-anime-1",
    anime: {
      id: "anime-1",
      title: "Test: Anime",
      aliases: [],
      premiereYear: 2026,
      premiereMonth: 7,
      externalIds: {}
    },
    status: "watching",
    autoDownload: true,
    addedAt: now,
    updatedAt: now
  };
}
