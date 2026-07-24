import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { DashboardData, DownloadTask, MyAnime, NotificationRecord } from "@shared/domain";
import { RemoteRpcDispatcher, RemoteRpcError } from "../remote-rpc-dispatcher";
import {
  REMOTE_RPC_METHOD_NAMES,
  createRemoteMethodRegistry,
  type RemoteRpcHandlers,
  type RemoteRpcScope
} from "../remote-method-registry";

const task: DownloadTask = {
  id: "task-1",
  engine: "qbittorrent",
  torrentHash: "secret-hash",
  correlationTag: "secret-correlation",
  name: "测试任务",
  status: "downloading",
  progress: 0.5,
  downloadSpeed: 100,
  uploadSpeed: 20,
  savePath: "/Users/test/Anime/secret",
  files: [],
  createdAt: "2026-07-17T00:00:00.000Z"
};

const myAnime: MyAnime = {
  id: "my-1",
  anime: {
    id: "anime-1",
    title: "测试番剧",
    aliases: [],
    premiereYear: 2026,
    premiereMonth: 7,
    externalIds: {}
  },
  status: "watching",
  autoDownload: true,
  downloadDir: "/Users/test/Anime/secret",
  rssSubscriptions: [
    {
      id: "rss-1",
      myAnimeId: "my-1",
      name: "私有订阅",
      url: "https://example.test/rss?token=secret",
      enabled: true,
      createdAt: "2026-07-17T00:00:00.000Z",
      updatedAt: "2026-07-17T00:00:00.000Z"
    }
  ],
  addedAt: "2026-07-17T00:00:00.000Z",
  updatedAt: "2026-07-17T00:00:00.000Z"
};

const notification: NotificationRecord = {
  id: "notification-1",
  kind: "system",
  title: "连接 https://private.example.test/api 失败",
  body: "文件位于 /Users/test/Anime/secret/video.mkv",
  severity: "error",
  createdAt: "2026-07-17T00:00:00.000Z"
};

const dashboard: DashboardData = {
  dailyReminder: {
    date: "2026-07-17",
    total: 0,
    upcoming: 0,
    aired: 0,
    downloading: 0,
    downloaded: 0,
    items: []
  },
  todayEpisodes: [],
  pendingActions: [],
  activeDownloads: [task],
  recentCompleted: [
    {
      id: "media-1",
      animeId: "anime-1",
      filePath: "/Users/test/Anime/secret/video.mkv",
      fileName: "video.mkv",
      size: 1024,
      normalizedVideoCodec: "H.265/HEVC",
      audioCodecs: [],
      subtitleTracks: []
    }
  ],
  weeklySchedule: [],
  sourceHealth: []
};

test("远程注册表只包含审核过的显式方法", () => {
  const registry = createRemoteMethodRegistry(createHandlers());
  assert.deepEqual(registry.list().map((item) => item.name), REMOTE_RPC_METHOD_NAMES);
  for (const dangerousMethod of [
    "getSettings",
    "listSources",
    "openExternal",
    "removeDownload",
    "addDownloadUrl",
    "playMedia",
    "revealMedia"
  ]) {
    assert.equal(registry.get(dangerousMethod), undefined);
  }
});

test("调度器在调用 handler 前拒绝未知方法和不足的 scope", async () => {
  let calls = 0;
  const handlers = createHandlers({
    listDownloads: () => {
      calls += 1;
      return [task];
    }
  });
  const dispatcher = createDispatcher(handlers);

  await assert.rejects(
    dispatcher.dispatch({ method: "getSettings", args: [] }, context("downloads.read")),
    (error) => isRemoteError(error, "METHOD_NOT_FOUND", 404)
  );
  await assert.rejects(
    dispatcher.dispatch({ method: "listDownloads", args: [] }, context("library.read")),
    (error) => isRemoteError(error, "FORBIDDEN", 403)
  );
  assert.equal(calls, 0);
});

test("调度器严格校验请求和方法参数", async () => {
  const dispatcher = createDispatcher(createHandlers());

  await assert.rejects(
    dispatcher.dispatch({ method: "listDownloads", args: [], extra: true }, context("downloads.read")),
    (error) => isRemoteError(error, "INVALID_REQUEST", 400)
  );
  await assert.rejects(
    dispatcher.dispatch({ method: "pauseDownload", args: ["../../secret"] }, context("downloads.control")),
    (error) => isRemoteError(error, "INVALID_ARGUMENTS", 400)
  );
  await assert.rejects(
    dispatcher.dispatch({ method: "listAnimeCatalog", args: [2026, 13] }, context("catalog.read")),
    (error) => isRemoteError(error, "INVALID_ARGUMENTS", 400)
  );
  await assert.rejects(
    dispatcher.dispatch({ method: "searchAnimeCatalog", args: ["\u0000secret"] }, context("catalog.read")),
    (error) => isRemoteError(error, "INVALID_ARGUMENTS", 400)
  );
});

test("远程观看进度写入需要 library.write 并校验整数范围", async () => {
  const dispatcher = createDispatcher(createHandlers());

  await assert.rejects(
    dispatcher.dispatch(
      { method: "setAnimeWatchProgress", args: [{ animeId: "anime-1", watchedEpisodeCount: 3 }] },
      context("library.read")
    ),
    (error) => isRemoteError(error, "FORBIDDEN", 403)
  );
  await assert.rejects(
    dispatcher.dispatch(
      { method: "setAnimeWatchProgress", args: [{ animeId: "anime-1", watchedEpisodeCount: 3.5 }] },
      context("library.write")
    ),
    (error) => isRemoteError(error, "INVALID_ARGUMENTS", 400)
  );
  assert.deepEqual(
    await dispatcher.dispatch(
      { method: "setAnimeWatchProgress", args: [{ animeId: "anime-1", watchedEpisodeCount: 3 }] },
      context("library.write")
    ),
    { animeId: "anime-1", watchedEpisodeCount: 3, totalEpisodeCount: 12 }
  );
});

test("远程播放器进度仅接受任务关联和有效百分比", async () => {
  const dispatcher = createDispatcher(createHandlers());

  await assert.rejects(
    dispatcher.dispatch(
      { method: "reportPlaybackProgress", args: [{ taskId: "task-1", fileIndex: 0, percent: 90 }] },
      context("library.read")
    ),
    (error) => isRemoteError(error, "FORBIDDEN", 403)
  );
  await assert.rejects(
    dispatcher.dispatch(
      { method: "reportPlaybackProgress", args: [{ taskId: "task-1", percent: 90, animeId: "anime-2" }] },
      context("library.write")
    ),
    (error) => isRemoteError(error, "INVALID_ARGUMENTS", 400)
  );
  assert.equal(
    await dispatcher.dispatch(
      { method: "reportPlaybackProgress", args: [{ taskId: "task-1", fileIndex: 0, percent: 90 }] },
      context("library.write")
    ),
    true
  );
});

test("远程续播写入需要 library.write 并拒绝未知字段", async () => {
  const dispatcher = createDispatcher(createHandlers());
  const input = {
    taskId: "task-1",
    fileIndex: 0,
    positionSeconds: 120,
    durationSeconds: 1_400,
    completed: false
  };

  await assert.rejects(
    dispatcher.dispatch({ method: "savePlaybackCheckpoint", args: [input] }, context("library.read")),
    (error) => isRemoteError(error, "FORBIDDEN", 403)
  );
  await assert.rejects(
    dispatcher.dispatch(
      { method: "savePlaybackCheckpoint", args: [{ ...input, filePath: "C:\\secret.mkv" }] },
      context("library.write")
    ),
    (error) => isRemoteError(error, "INVALID_ARGUMENTS", 400)
  );
  assert.deepEqual(
    await dispatcher.dispatch({ method: "savePlaybackCheckpoint", args: [input] }, context("library.write")),
    {
      ...input,
      watchedReported: false,
      updatedAt: "2026-07-24T00:00:00.000Z"
    }
  );
});

test("下载、追番和首页返回值强制隐藏路径、哈希及订阅地址", async () => {
  const dispatcher = createDispatcher(createHandlers());
  const downloads = (await dispatcher.dispatch(
    { method: "listDownloads", args: [] },
    context("downloads.read")
  )) as Array<Record<string, unknown>>;
  assert.equal(downloads[0].savePath, "本机路径已隐藏");
  assert.equal("torrentHash" in downloads[0], false);
  assert.equal("correlationTag" in downloads[0], false);

  const animeItems = (await dispatcher.dispatch(
    { method: "listMyAnime", args: [] },
    context("library.read")
  )) as Array<Record<string, unknown>>;
  assert.equal("downloadDir" in animeItems[0], false);
  assert.equal("rssSubscriptions" in animeItems[0], false);

  const home = (await dispatcher.dispatch(
    { method: "getDashboard", args: [] },
    context("dashboard.read")
  )) as DashboardData;
  assert.equal(home.activeDownloads[0].savePath, "本机路径已隐藏");
  assert.equal(home.recentCompleted[0].filePath, "本机路径已隐藏");
});

test("通知自由文本隐藏 URL 和本机路径", async () => {
  const dispatcher = createDispatcher(createHandlers());
  const items = (await dispatcher.dispatch(
    { method: "listNotifications", args: [] },
    context("notifications.read")
  )) as NotificationRecord[];
  assert.equal(items[0].title.includes("private.example.test"), false);
  assert.equal(items[0].body.includes("/Users/test"), false);
});

test("handler 异常不会把内部错误消息返回远程端", async () => {
  const dispatcher = createDispatcher(
    createHandlers({
      pauseDownload: () => {
        throw new Error("数据库密码 secret-password");
      }
    })
  );

  await assert.rejects(
    dispatcher.dispatch({ method: "pauseDownload", args: ["task-1"] }, context("downloads.control")),
    (error) =>
      isRemoteError(error, "HANDLER_FAILED", 500) &&
      error instanceof Error &&
      !error.message.includes("secret-password")
  );
});

function createHandlers(overrides: Partial<RemoteRpcHandlers> = {}): RemoteRpcHandlers {
  return {
    getDashboard: () => dashboard,
    listNotifications: () => [notification],
    getUnreadNotificationCount: () => 1,
    markNotificationRead: () => [notification],
    markAllNotificationsRead: () => [notification],
    listMyAnime: () => [myAnime],
    listMyAnimeWatchProgress: () => [{ animeId: myAnime.anime.id, watchedEpisodeCount: 2, totalEpisodeCount: 12 }],
    setAnimeWatchProgress: (input) => ({ ...input, totalEpisodeCount: 12 }),
    reportPlaybackProgress: () => true,
    savePlaybackCheckpoint: (input) => ({
      ...input,
      completed: input.completed ?? false,
      watchedReported: false,
      updatedAt: "2026-07-24T00:00:00.000Z"
    }),
    listAnimeCatalog: () => [myAnime.anime],
    getAnimeDetail: () => ({
      anime: myAnime.anime,
      myAnime,
      episodes: [],
      fansubGroups: [],
      stale: false,
      partialErrors: []
    }),
    searchAnimeCatalog: () => ({
      keyword: "测试番",
      items: [myAnime.anime],
      source: "local+anilist",
      errors: []
    }),
    listFansubs: () => [],
    listEpisodes: () => [],
    listEpisodePreferences: () => [],
    listDownloads: () => [task],
    refreshDownloads: () => [task],
    pauseDownload: () => [task],
    resumeDownload: () => [task],
    ...overrides
  };
}

function createDispatcher(handlers: RemoteRpcHandlers): RemoteRpcDispatcher {
  return new RemoteRpcDispatcher(createRemoteMethodRegistry(handlers), {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined
  });
}

function context(...grantedScopes: RemoteRpcScope[]) {
  return {
    grantedScopes,
    clientId: "test-device",
    requestId: "test-request"
  };
}

function isRemoteError(error: unknown, code: RemoteRpcError["code"], statusCode: number): boolean {
  return error instanceof RemoteRpcError && error.code === code && error.statusCode === statusCode;
}
