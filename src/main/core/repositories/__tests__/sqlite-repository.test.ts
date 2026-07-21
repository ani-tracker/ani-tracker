import { strict as assert } from "node:assert";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type Database from "better-sqlite3";
import * as BetterSqlite3Module from "better-sqlite3";
import type { ReleaseSearchResult } from "@shared/contracts";
import type { MyAnime } from "@shared/domain";
import { validateThemePack } from "@shared/theme";
import { GenericDefaultSettingsProvider } from "../../platform/default-settings-provider";
import { enrichReleaseFromTitle } from "../../releases/release-title-parser";
import { createSeedData } from "../../storage/seed-data";
import { SQLITE_SCHEMA_VERSION } from "../../storage/sqlite-schema";
import { buildPendingActions } from "../app-repository";
import { createRepositoryRuntime } from "../repository-runtime";

const DatabaseConstructor = (
  (BetterSqlite3Module as unknown as { default?: typeof BetterSqlite3Module }).default ?? BetterSqlite3Module
) as unknown as new (filename: string, options?: Database.Options) => Database.Database;

test("首次启动忽略旧 JSON 并直接初始化 SQLite", async () => {
  const fixture = await createFixture();
  await writeFile(join(fixture.userData, "ani-tracker.json"), "旧 JSON 不应被读取", "utf8");
  const runtime = createRepositoryRuntime(fixture.options);
  await runtime.initialize();

  assert.equal(runtime.getBackend(), "sqlite");
  assert.equal((await runtime.repository.listAnimeCatalog()).length, fixture.data.animeCatalog.length);
  assert.equal((await runtime.repository.listMyAnime()).length, fixture.data.myAnime.length);
  assert.equal((await runtime.repository.listDownloads()).length, fixture.data.downloads.length);
  assert.equal((await runtime.repository.listNotifications()).length, fixture.data.notifications.length);
  assert.equal((await runtime.repository.listMediaFiles()).length, fixture.data.mediaFiles.length);
  assert.equal((await runtime.repository.listFansubs()).length, fixture.data.fansubGroups.length);
  assert.ok((await runtime.repository.listFansubs()).every((group) => !group.aliases.includes(group.name)));
  assert.equal((await runtime.repository.listSources()).length, fixture.data.sources.length);
  assert.equal((await runtime.repository.getSettings()).storage.databasePath, fixture.databasePath);
  assert.deepEqual((await runtime.repository.getDashboard()).pendingActions, []);

  runtime.close();
  await access(fixture.databasePath);
  assertDatabaseIntegrity(fixture.databasePath);
});

test("SQLite 二次启动保留增量数据且不重复 seed", async () => {
  const fixture = await createFixture();
  const first = createRepositoryRuntime(fixture.options);
  await first.initialize();
  await first.repository.addNotifications([
    {
      id: "sqlite-only-notification",
      kind: "system",
      title: "SQLite persistence",
      body: "只存在于数据库",
      severity: "success",
      createdAt: new Date().toISOString()
    }
  ]);
  first.close();

  const second = createRepositoryRuntime(fixture.options);
  await second.initialize();
  const notifications = await second.repository.listNotifications();
  assert.equal(second.getBackend(), "sqlite");
  assert.equal(notifications.length, fixture.data.notifications.length + 1);
  assert.equal(notifications.some((item) => item.id === "sqlite-only-notification"), true);
  second.close();
});

test("SQLite 保存并恢复追番 RSS 订阅配置", async () => {
  const fixture = await createFixture();
  const first = createRepositoryRuntime(fixture.options);
  await first.initialize();
  const item = createTestMyAnime();
  await first.repository.upsertMyAnime({
    ...item,
    preferredBitDepth: 10,
    preferredSubtitleLanguages: ["chs", "cht"]
  });
  const timestamp = new Date().toISOString();
  await first.repository.upsertMyAnime({
    ...item,
    preferredBitDepth: 10,
    preferredSubtitleLanguages: ["chs", "cht"],
    rssSubscriptions: [
      {
        id: "rss-sqlite-test",
        myAnimeId: item.id,
        name: "蜜柑计划",
        url: "https://mikanani.me/RSS/Bangumi?bangumiId=3941",
        enabled: true,
        preferredSubtitleLanguages: ["cht", "jpn"],
        refreshIntervalMinutes: 20,
        lastFetchedAt: timestamp,
        createdAt: timestamp,
        updatedAt: timestamp
      }
    ]
  });
  first.close();

  const second = createRepositoryRuntime(fixture.options);
  await second.initialize();
  const restored = (await second.repository.listMyAnime()).find((entry) => entry.id === item.id);
  assert.equal(restored?.rssSubscriptions?.length, 1);
  assert.equal(restored?.rssSubscriptions?.[0].name, "蜜柑计划");
  assert.equal(restored?.rssSubscriptions?.[0].url, "https://mikanani.me/RSS/Bangumi?bangumiId=3941");
  assert.equal(restored?.rssSubscriptions?.[0].enabled, true);
  assert.deepEqual(restored?.preferredSubtitleLanguages, ["chs", "cht"]);
  assert.equal(restored?.preferredBitDepth, 10);
  assert.deepEqual(restored?.rssSubscriptions?.[0].preferredSubtitleLanguages, ["cht", "jpn"]);
  assert.equal(restored?.rssSubscriptions?.[0].refreshIntervalMinutes, 20);
  assert.equal(restored?.rssSubscriptions?.[0].lastFetchedAt, timestamp);
  second.close();
});

test("SQLite 原子维护连续观看进度并按下载状态恢复取消已看的单集", async () => {
  const fixture = await createFixture();
  const runtime = createRepositoryRuntime(fixture.options);
  await runtime.initialize();
  const item = createTestMyAnime();
  item.anime.detail = { episodeCount: 12 };
  await runtime.repository.upsertMyAnime(item);
  await runtime.repository.upsertDownloadTask(createDownloadTask(item.anime.id, "watch-progress-episode-3", 3));

  const updated = await runtime.repository.setAnimeWatchProgress({
    animeId: item.anime.id,
    watchedEpisodeCount: 3
  });
  assert.deepEqual(updated, {
    animeId: item.anime.id,
    watchedEpisodeCount: 3,
    totalEpisodeCount: 12
  });
  assert.deepEqual(
    (await runtime.repository.listEpisodes(item.anime.id)).slice(0, 3).map((episode) => episode.status),
    ["watched", "watched", "watched"]
  );

  const reduced = await runtime.repository.setAnimeWatchProgress({
    animeId: item.anime.id,
    watchedEpisodeCount: 1
  });
  const episodes = await runtime.repository.listEpisodes(item.anime.id);
  assert.equal(reduced.watchedEpisodeCount, 1);
  assert.equal(episodes.find((episode) => episode.episodeNo === 2)?.status, "aired");
  assert.equal(episodes.find((episode) => episode.episodeNo === 3)?.status, "downloaded");
  assert.deepEqual(await runtime.repository.listMyAnimeWatchProgress(), [reduced]);
  runtime.close();
});

test("首页待关注项使用真实番剧名和集数并携带详情定位", async () => {
  const fixture = await createFixture();
  const item = {
    ...createTestMyAnime(),
    defaultFansubGroupId: "fansub-test"
  };
  const episode = {
    id: "episode-anime-sqlite-test-3",
    animeId: item.anime.id,
    episodeNo: 3,
    airTime: "2000-01-01T00:00:00.000Z",
    status: "aired" as const
  };
  fixture.data.myAnime = [item];
  fixture.data.episodes = [episode];

  assert.deepEqual(buildPendingActions(fixture.data), [{
    id: `pending-default-fansub-${episode.id}`,
    title: "《测试番》第 3 集",
    description: "《测试番》第 3 集已开播，但默认字幕组还没有发布资源。",
    severity: "warning",
    animeId: item.anime.id,
    episodeId: episode.id,
    episodeNo: 3
  }]);

  fixture.data.downloads = [{
    ...createDownloadTask(item.anime.id, "pending-action-download", 3),
    fansubGroupId: item.defaultFansubGroupId
  }];
  assert.deepEqual(buildPendingActions(fixture.data), []);
});

test("SQLite v13 保存并恢复番剧详情元数据", async () => {
  const fixture = await createFixture();
  const first = createRepositoryRuntime(fixture.options);
  await first.initialize();
  const item = createTestMyAnime();
  item.anime.detail = {
    bannerUrl: "https://example.test/banner.jpg",
    format: "tv",
    episodeCount: 12,
    airingStatus: "airing",
    genres: ["奇幻", "冒险"],
    studios: ["Test Studio"],
    staff: [{ name: "测试导演", role: "导演", source: "bangumi" }],
    ranking: { rank: 9, source: "anilist", category: "评分排行" },
    metadataSources: ["bangumi", "anilist"],
    refreshedAt: "2026-07-19T00:00:00.000Z"
  };
  await first.repository.upsertMyAnime(item);
  first.close();

  const second = createRepositoryRuntime(fixture.options);
  await second.initialize();
  const restored = await second.repository.getAnimeCatalogById(item.anime.id);
  assert.deepEqual(restored?.detail, item.anime.detail);
  second.close();
  assertDatabaseIntegrity(fixture.databasePath);
});

test("SQLite v12 升级补齐详情列且损坏 JSON 安全回退", async () => {
  const fixture = await createFixture();
  const first = createRepositoryRuntime(fixture.options);
  await first.initialize();
  const item = createTestMyAnime();
  await first.repository.upsertMyAnime(item);
  first.close();

  const driftedDatabase = new DatabaseConstructor(fixture.databasePath);
  try {
    driftedDatabase.exec("ALTER TABLE anime_catalog DROP COLUMN detail_json");
    driftedDatabase.prepare("UPDATE app_meta SET value = '12' WHERE key = 'schema_version'").run();
  } finally {
    driftedDatabase.close();
  }

  const migrated = createRepositoryRuntime(fixture.options);
  await migrated.initialize();
  assert.equal((await migrated.repository.getAnimeCatalogById(item.anime.id))?.detail, undefined);
  migrated.close();

  const corruptedDatabase = new DatabaseConstructor(fixture.databasePath);
  try {
    corruptedDatabase.prepare("UPDATE anime_catalog SET detail_json = '{broken' WHERE id = ?").run(item.anime.id);
  } finally {
    corruptedDatabase.close();
  }

  const recovered = createRepositoryRuntime(fixture.options);
  await recovered.initialize();
  assert.equal((await recovered.repository.getAnimeCatalogById(item.anime.id))?.detail, undefined);
  recovered.close();
  assertDatabaseIntegrity(fixture.databasePath);
});

test("SQLite 保存图片取色主题后可在重启时恢复", async () => {
  const fixture = await createFixture();
  const first = createRepositoryRuntime(fixture.options);
  await first.initialize();
  const imported = validateThemePack(JSON.parse(
    await readFile("docs/自定义主题提示词/image-palette-example.ani-theme.json", "utf8")
  ));
  assert.ok(imported.pack);

  await first.repository.updateSettings({
    appearance: {
      themeMode: "dark",
      themePackId: imported.pack.id,
      customThemePacks: [imported.pack]
    }
  });
  first.close();

  const second = createRepositoryRuntime(fixture.options);
  await second.initialize();
  const restored = (await second.repository.getSettings()).appearance;
  assert.equal(restored.themeMode, "dark");
  assert.equal(restored.themePackId, imported.pack.id);
  assert.deepEqual(restored.customThemePacks, [imported.pack]);
  second.close();
});

test("SQLite 资源查询缓存可跨重启恢复并自动淘汰过期项", async () => {
  const fixture = await createFixture();
  const first = createRepositoryRuntime(fixture.options);
  await first.initialize();
  const result: ReleaseSearchResult = {
    query: { keyword: "完结缓存测试", limit: 10, cacheTtlMs: 7 * 24 * 60 * 60 * 1000 },
    releases: [{
      id: "anibt:completed-cache",
      title: "[测试组] 完结缓存测试 - 01 [1080p]",
      sourceId: "anibt",
      sourceName: "AniBT",
      publishedAt: "2026-07-18T00:00:00.000Z"
    }],
    searchedSourceIds: ["anibt"],
    errors: []
  };
  await first.repository.upsertReleaseSearchCache("completed-cache", {
    expiresAt: "2099-01-01T00:00:00.000Z",
    result
  });
  first.close();

  const second = createRepositoryRuntime(fixture.options);
  await second.initialize();
  const restored = await second.repository.getReleaseSearchCache("completed-cache");
  assert.deepEqual(restored?.result, result);

  await second.repository.upsertReleaseSearchCache("expired-cache", {
    expiresAt: "2000-01-01T00:00:00.000Z",
    result
  });
  assert.equal(await second.repository.getReleaseSearchCache("expired-cache"), undefined);
  second.close();
});

test("SQLite 重启后保留下载源网络策略、退避状态和增量资源", async () => {
  const fixture = await createFixture();
  const first = createRepositoryRuntime(fixture.options);
  await first.initialize();
  const anibt = (await first.repository.listSources()).find((source) => source.id === "anibt");
  assert.ok(anibt);
  assert.equal(anibt.useProxy, true);
  assert.equal(anibt.requestIntervalMs, 3_000);
  await first.repository.upsertSource({ ...anibt, useProxy: false, requestIntervalMs: 2_750 });
  await first.repository.upsertSourceSyncState({
    sourceId: anibt.id,
    lastRequestAt: "2026-07-18T01:00:00.000Z",
    requestFailureCount: 2,
    backoffUntil: "2026-07-18T01:05:00.000Z",
    lastSuccessfulSyncAt: "2026-07-18T00:30:00.000Z"
  });
  await first.repository.upsertRequestCircuitState({
    key: "release-source:anibt",
    group: "release-source",
    requestHost: "anibt.net",
    lastRequestAt: "2026-07-18T01:00:00.000Z",
    failureCount: 2,
    backoffUntil: "2026-07-18T01:05:00.000Z"
  });
  const added = await first.repository.upsertCachedReleases([enrichReleaseFromTitle({
    id: "anibt:persisted-release",
    title: "[测试组] 测试番 - 01 [1080p][HEVC][10bit]",
    sourceId: anibt.id,
    sourceName: anibt.name,
    magnetUrl: "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567",
    publishedAt: "2026-07-18T00:20:00.000Z"
  })]);
  assert.equal(added, 1);
  first.close();

  const second = createRepositoryRuntime(fixture.options);
  await second.initialize();
  const restoredSource = (await second.repository.listSources()).find((source) => source.id === "anibt");
  const restoredState = (await second.repository.listSourceSyncStates()).find((state) => state.sourceId === "anibt");
  const restoredCircuit = (await second.repository.listRequestCircuitStates())
    .find((state) => state.key === "release-source:anibt");
  const restoredReleases = await second.repository.listCachedReleases(["anibt"]);
  assert.equal(restoredSource?.useProxy, false);
  assert.equal(restoredSource?.requestIntervalMs, 2_750);
  assert.equal(restoredState?.requestFailureCount, 2);
  assert.equal(restoredState?.backoffUntil, "2026-07-18T01:05:00.000Z");
  assert.equal(restoredCircuit?.failureCount, 2);
  assert.equal(restoredCircuit?.backoffUntil, "2026-07-18T01:05:00.000Z");
  assert.equal(restoredReleases[0]?.id, "anibt:persisted-release");
  assert.equal(restoredReleases[0]?.normalizedVideoCodec, "H.265/HEVC");
  assert.equal(restoredReleases[0]?.bitDepth, 10);
  second.close();
});

test("SQLite schema 13 将旧下载源熔断字段迁移到通用状态表", async () => {
  const fixture = await createFixture();
  const first = createRepositoryRuntime(fixture.options);
  await first.initialize();
  await first.repository.upsertSourceSyncState({
    sourceId: "anibt",
    requestHost: "anibt.net",
    lastRequestAt: "2026-07-18T01:00:00.000Z",
    requestFailureCount: 2,
    backoffUntil: "2026-07-18T01:05:00.000Z"
  });
  first.close();

  const legacyDatabase = new DatabaseConstructor(fixture.databasePath);
  try {
    legacyDatabase.prepare("DELETE FROM request_circuit_state").run();
    legacyDatabase.prepare("UPDATE app_meta SET value = '13' WHERE key = 'schema_version'").run();
  } finally {
    legacyDatabase.close();
  }

  const migrated = createRepositoryRuntime(fixture.options);
  await migrated.initialize();
  const circuit = (await migrated.repository.listRequestCircuitStates())
    .find((state) => state.key === "release-source:anibt");
  const legacy = (await migrated.repository.listSourceSyncStates()).find((state) => state.sourceId === "anibt");
  assert.equal(circuit?.requestHost, "anibt.net");
  assert.equal(circuit?.failureCount, 2);
  assert.equal(circuit?.backoffUntil, "2026-07-18T01:05:00.000Z");
  assert.equal(legacy?.requestFailureCount, 0);
  assert.equal(legacy?.backoffUntil, undefined);
  migrated.close();
});

test("SQLite 重启后恢复播放器选择和自定义路径", async () => {
  const fixture = await createFixture();
  const first = createRepositoryRuntime(fixture.options);
  await first.initialize();
  const settings = await first.repository.getSettings();
  await first.repository.updateSettings({
    defaultPlayerProfileId: "mpv",
    players: settings.players.map((player) => player.id === "mpv"
      ? { ...player, executablePath: "D:\\Players\\mpv.exe" }
      : player)
  });
  first.close();

  const second = createRepositoryRuntime(fixture.options);
  await second.initialize();
  const restored = await second.repository.getSettings();
  assert.equal(restored.defaultPlayerProfileId, "mpv");
  assert.equal(restored.players.find((player) => player.id === "mpv")?.executablePath, "D:\\Players\\mpv.exe");
  second.close();
});

test("SQLite 重启后恢复下载任务技术信息快照", async () => {
  const fixture = await createFixture();
  const first = createRepositoryRuntime(fixture.options);
  await first.initialize();
  const item = createTestMyAnime();
  await first.repository.upsertMyAnime(item);
  await first.repository.upsertDownloadTask({
    ...createDownloadTask(item.anime.id, "metadata-snapshot", 2),
    name: "[字幕组] 测试番 - 02 [1080p][HEVC][10bit][简繁]",
    resolution: "1080p",
    declaredVideoCodec: "HEVC",
    normalizedVideoCodec: "H.265/HEVC",
    bitDepth: 10,
    subtitleLanguages: ["chs", "cht"],
    subtitle: "multi"
  });
  first.close();

  const second = createRepositoryRuntime(fixture.options);
  await second.initialize();
  const restored = (await second.repository.listDownloads()).find((task) => task.id === "metadata-snapshot");
  assert.equal(restored?.resolution, "1080p");
  assert.equal(restored?.normalizedVideoCodec, "H.265/HEVC");
  assert.equal(restored?.bitDepth, 10);
  assert.deepEqual(restored?.subtitleLanguages, ["chs", "cht"]);
  assert.equal(restored?.subtitle, "multi");
  second.close();
});

test("SQLite schema 8 缺少下载字幕列时自动修复且保留任务", async () => {
  const fixture = await createFixture();
  const first = createRepositoryRuntime(fixture.options);
  await first.initialize();
  const item = createTestMyAnime();
  await first.repository.upsertMyAnime(item);
  await first.repository.upsertDownloadTask(createDownloadTask(item.anime.id, "schema-8-repair", 1));
  first.close();

  const driftedDatabase = new DatabaseConstructor(fixture.databasePath);
  try {
    driftedDatabase.exec("ALTER TABLE download_task DROP COLUMN subtitle");
    driftedDatabase.prepare("UPDATE app_meta SET value = '8' WHERE key = 'schema_version'").run();
    const columns = driftedDatabase.pragma("table_info(download_task)") as Array<{ name: string }>;
    assert.equal(columns.some((column) => column.name === "subtitle"), false);
  } finally {
    driftedDatabase.close();
  }

  const repaired = createRepositoryRuntime(fixture.options);
  await repaired.initialize();
  await repaired.repository.upsertDownloadTask({
    ...createDownloadTask(item.anime.id, "schema-8-repair", 1),
    subtitleLanguages: ["chs", "cht"],
    subtitle: "multi"
  });
  const restored = (await repaired.repository.listDownloads()).find((task) => task.id === "schema-8-repair");
  assert.equal(restored?.subtitle, "multi");
  assert.deepEqual(restored?.subtitleLanguages, ["chs", "cht"]);
  repaired.close();

  const verifiedDatabase = new DatabaseConstructor(fixture.databasePath, { readonly: true });
  try {
    const columns = verifiedDatabase.pragma("table_info(download_task)") as Array<{ name: string }>;
    const schemaVersion = verifiedDatabase.prepare("SELECT value FROM app_meta WHERE key = 'schema_version'").get() as { value: string };
    assert.equal(columns.some((column) => column.name === "subtitle"), true);
    assert.equal(Number(schemaVersion.value), SQLITE_SCHEMA_VERSION);
  } finally {
    verifiedDatabase.close();
  }
  assertDatabaseIntegrity(fixture.databasePath);
});

test("SQLite 保存、替换并恢复番剧来源绑定", async () => {
  const fixture = await createFixture();
  const first = createRepositoryRuntime(fixture.options);
  await first.initialize();
  const item = createTestMyAnime();
  await first.repository.upsertMyAnime(item);
  const timestamp = new Date().toISOString();
  await first.repository.upsertAnimeSourceBinding({
    id: "binding-test-mikan",
    animeId: item.anime.id,
    sourceId: "mikan-site",
    sourceAnimeId: "3941",
    sourceAnimeTitle: "测试番",
    sourceUrl: "https://mikanani.me/Home/Bangumi/3941",
    matchMethod: "manual",
    confidence: 0.92,
    confirmed: true,
    createdAt: timestamp,
    updatedAt: timestamp
  });
  await first.repository.upsertAnimeSourceBinding({
    id: "binding-test-mikan-replaced",
    animeId: item.anime.id,
    sourceId: "mikan-site",
    sourceAnimeId: "4007",
    sourceAnimeTitle: "测试番 修正版",
    matchMethod: "manual",
    confidence: 1,
    confirmed: true,
    createdAt: timestamp,
    updatedAt: timestamp
  });
  first.close();

  const second = createRepositoryRuntime(fixture.options);
  await second.initialize();
  const restored = await second.repository.listAnimeSourceBindings(item.anime.id);
  assert.equal(restored.length, 1);
  assert.equal(restored[0].sourceAnimeId, "4007");
  assert.equal(restored[0].sourceAnimeTitle, "测试番 修正版");
  assert.equal(restored[0].confirmed, true);
  second.close();
});

test("SQLite 按番剧保存动态发现的字幕组", async () => {
  const fixture = await createFixture();
  const first = createRepositoryRuntime(fixture.options);
  await first.initialize();
  const item = createTestMyAnime();
  await first.repository.upsertMyAnime(item);
  const release = enrichReleaseFromTitle({
    id: "release-fansub-observed",
    title: "[Nix-Raws] 测试番 - 01 [1080p]",
    sourceId: "rss-test",
    sourceName: "测试 RSS",
    publishedAt: new Date().toISOString()
  });
  await first.repository.observeAnimeFansubs(item.anime.id, [release]);
  const observed = await first.repository.listFansubs(item.anime.id);
  assert.equal(observed.length, 1);
  assert.equal(observed[0].name, "Nix-Raws");
  assert.deepEqual(observed[0].sourceIds, ["rss-test"]);
  first.close();

  const second = createRepositoryRuntime(fixture.options);
  await second.initialize();
  assert.equal((await second.repository.listFansubs(item.anime.id))[0].id, release.fansubGroupId);
  second.close();
});

test("SQLite 启动时合并简繁异体字幕组并迁移业务引用", async () => {
  const fixture = await createFixture();
  const first = createRepositoryRuntime(fixture.options);
  await first.initialize();
  const item = createTestMyAnime();
  await first.repository.upsertMyAnime(item);
  await first.repository.upsertDownloadTask({
    id: "fansub-merge-download",
    animeId: item.anime.id,
    fansubGroupId: "fansub-auto-green-traditional",
    fansubName: "綠茶字幕組",
    engine: "qbittorrent",
    name: "字幕组迁移测试",
    status: "completed",
    progress: 1,
    downloadSpeed: 0,
    uploadSpeed: 0,
    savePath: "/downloads/anime",
    files: [],
    createdAt: "2026-07-16T00:00:00.000Z"
  });
  first.close();

  const database = new DatabaseConstructor(fixture.databasePath);
  try {
    const timestamp = "2026-07-16T00:00:00.000Z";
    const insertGroup = database.prepare(
      `INSERT INTO fansub_group (id, name, aliases_json, source_ids_json, created_at, updated_at)
       VALUES (@id, @name, '[]', @sourceIds, @timestamp, @timestamp)`
    );
    insertGroup.run({ id: "fansub-auto-green-simplified", name: "绿茶字幕组", sourceIds: '["mikan"]', timestamp });
    insertGroup.run({ id: "fansub-auto-green-traditional", name: "綠茶字幕組", sourceIds: '["anibt"]', timestamp });
    database.prepare(
      "UPDATE my_anime SET default_fansub_group_id = @fansubId WHERE id = @itemId"
    ).run({ fansubId: "fansub-auto-green-traditional", itemId: item.id });
    const insertLink = database.prepare(
      `INSERT INTO anime_fansub_group (anime_id, fansub_group_id, first_seen_at, last_seen_at)
       VALUES (@animeId, @fansubId, @timestamp, @timestamp)`
    );
    insertLink.run({ animeId: item.anime.id, fansubId: "fansub-auto-green-simplified", timestamp });
    insertLink.run({ animeId: item.anime.id, fansubId: "fansub-auto-green-traditional", timestamp });
  } finally {
    database.close();
  }

  const second = createRepositoryRuntime(fixture.options);
  await second.initialize();
  const groups = await second.repository.listFansubs(item.anime.id);
  const restoredItem = (await second.repository.listMyAnime()).find((entry) => entry.id === item.id);
  const restoredDownload = (await second.repository.listDownloads()).find((task) => task.id === "fansub-merge-download");

  assert.equal(groups.length, 1);
  assert.equal(groups[0].id, "fansub-auto-green-simplified");
  assert.ok(groups[0].aliases.includes("綠茶字幕組"));
  assert.ok(!groups[0].aliases.includes(groups[0].name));
  assert.deepEqual(groups[0].sourceIds.sort(), ["anibt", "mikan"]);
  assert.equal(restoredItem?.defaultFansubGroupId, groups[0].id);
  assert.equal(restoredDownload?.fansubGroupId, groups[0].id);
  assert.equal(restoredDownload?.fansubName, groups[0].name);
  second.close();
  assertDatabaseIntegrity(fixture.databasePath);
});

test("SQLite 启动时清理字幕组自别名并修正下载任务旧名称", async () => {
  const fixture = await createFixture();
  const first = createRepositoryRuntime(fixture.options);
  await first.initialize();
  const item = createTestMyAnime();
  await first.repository.upsertMyAnime(item);
  first.close();

  const database = new DatabaseConstructor(fixture.databasePath);
  try {
    const timestamp = "2026-07-16T00:00:00.000Z";
    database.prepare(
      `INSERT INTO fansub_group (id, name, aliases_json, source_ids_json, created_at, updated_at)
       VALUES (@id, @name, @aliases, '[]', @timestamp, @timestamp)`
    ).run({ id: "fansub-sakurato", name: "桜都字幕组", aliases: '["桜都字幕组"]', timestamp });
    database.prepare(
      `INSERT INTO download_task (
        id, anime_id, fansub_group_id, fansub_name, engine, name, status, progress,
        download_speed, upload_speed, save_path, created_at, updated_at
      ) VALUES (
        @id, @animeId, @fansubGroupId, @fansubName, 'qbittorrent', '字幕组名称修复测试',
        'completed', 1, 0, 0, '/downloads/anime', @timestamp, @timestamp
      )`
    ).run({
      id: "fansub-name-repair-download",
      animeId: item.anime.id,
      fansubGroupId: "fansub-sakurato",
      fansubName: "樱都字幕组",
      timestamp
    });
  } finally {
    database.close();
  }

  const second = createRepositoryRuntime(fixture.options);
  await second.initialize();
  const group = (await second.repository.listFansubs()).find((fansub) => fansub.id === "fansub-sakurato");
  const download = (await second.repository.listDownloads()).find((task) => task.id === "fansub-name-repair-download");

  assert.deepEqual(group?.aliases, []);
  assert.equal(download?.fansubName, "桜都字幕组");
  second.close();
  assertDatabaseIntegrity(fixture.databasePath);
});

test("SQLite 刷新时合并真实任务与已关联的 pending 任务", async () => {
  const fixture = await createFixture();
  const runtime = createRepositoryRuntime(fixture.options);
  await runtime.initialize();
  const item = createTestMyAnime();
  const correlationTag = "ani-tracker-396aba3c-a2e8-421a-896b-2a08536ce38e";
  await runtime.repository.upsertMyAnime(item);
  await runtime.repository.upsertEpisode({
    id: `episode-${item.anime.id}-1`,
    animeId: item.anime.id,
    episodeNo: 1,
    status: "downloading"
  });
  await runtime.repository.upsertDownloadTask({
    ...createDownloadTask(item.anime.id, "pending-task", 1),
    id: "pending-task",
    torrentHash: undefined,
    correlationTag,
    releaseId: "release-01"
  });
  await runtime.repository.upsertDownloadTask({
    ...createDownloadTask(item.anime.id, "real-hash"),
    animeId: undefined,
    episodeId: undefined,
    episodeNo: undefined,
    correlationTag: `${correlationTag}\r\n------formdata-undici-boundary--`
  });

  const refreshed = await runtime.repository.mergeDownloadTasksFromEngine([{
    ...createDownloadTask(item.anime.id, "real-hash"),
    animeId: undefined,
    episodeId: undefined,
    episodeNo: undefined,
    correlationTag
  }]);

  assert.equal(refreshed.length, 1);
  assert.equal(refreshed[0].id, "real-hash");
  assert.equal(refreshed[0].torrentHash, "real-hash");
  assert.equal(refreshed[0].releaseId, "release-01");
  assert.equal(refreshed[0].animeId, item.anime.id);
  assert.equal(refreshed[0].episodeId, `episode-${item.anime.id}-1`);
  assert.equal(refreshed[0].episodeNo, 1);
  assert.equal(refreshed[0].correlationTag, correlationTag);
  runtime.close();
  assertDatabaseIntegrity(fixture.databasePath);
});

test("SQLite 刷新及重启时按文件集数修复同名种子的单集关联", async () => {
  const fixture = await createFixture();
  const runtime = createRepositoryRuntime(fixture.options);
  await runtime.initialize();
  const item = createTestMyAnime();
  await runtime.repository.upsertMyAnime(item);
  for (const episodeNo of [1, 2, 3]) {
    await runtime.repository.upsertEpisode({
      id: `episode-${item.anime.id}-${episodeNo}`,
      animeId: item.anime.id,
      episodeNo,
      status: "aired"
    });
  }

  for (const hash of ["hash-01", "hash-02", "hash-03"]) {
    await runtime.repository.upsertDownloadTask(createDownloadTask(item.anime.id, hash, 1));
  }
  const refreshed = await runtime.repository.mergeDownloadTasksFromEngine(
    [1, 2, 3].map((episodeNo) => createDownloadTask(item.anime.id, `hash-0${episodeNo}`, undefined, episodeNo))
  );

  assert.deepEqual(
    refreshed
      .map((task) => ({ hash: task.torrentHash, episodeId: task.episodeId, episodeNo: task.episodeNo }))
      .sort((left, right) => (left.episodeNo ?? 0) - (right.episodeNo ?? 0)),
    [
      { hash: "hash-01", episodeId: `episode-${item.anime.id}-1`, episodeNo: 1 },
      { hash: "hash-02", episodeId: `episode-${item.anime.id}-2`, episodeNo: 2 },
      { hash: "hash-03", episodeId: `episode-${item.anime.id}-3`, episodeNo: 3 }
    ]
  );

  for (const episodeNo of [1, 2, 3]) {
    await runtime.repository.upsertDownloadTask(
      createDownloadTask(item.anime.id, `hash-0${episodeNo}`, 1, episodeNo)
    );
  }
  runtime.close();

  const reopened = createRepositoryRuntime(fixture.options);
  await reopened.initialize();
  assert.deepEqual(
    (await reopened.repository.listDownloads())
      .map((task) => ({ hash: task.torrentHash, episodeId: task.episodeId, episodeNo: task.episodeNo }))
      .sort((left, right) => (left.episodeNo ?? 0) - (right.episodeNo ?? 0)),
    [
      { hash: "hash-01", episodeId: `episode-${item.anime.id}-1`, episodeNo: 1 },
      { hash: "hash-02", episodeId: `episode-${item.anime.id}-2`, episodeNo: 2 },
      { hash: "hash-03", episodeId: `episode-${item.anime.id}-3`, episodeNo: 3 }
    ]
  );
  reopened.close();
});

test("损坏的 SQLite 会阻止启动且不会回退 JSON", async () => {
  const fixture = await createFixture();
  await writeFile(fixture.databasePath, "not a sqlite database", "utf8");
  const runtime = createRepositoryRuntime(fixture.options);

  await assert.rejects(runtime.initialize());
  assert.equal(runtime.getBackend(), "pending");
  assert.throws(() => runtime.repository.listMyAnime(), /Repository 尚未初始化/);
  runtime.close();
});

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "ani-sqlite-repository-"));
  const userData = join(root, "user-data");
  const databasePath = join(userData, "ani-tracker.sqlite");
  const settingsProvider = new GenericDefaultSettingsProvider({
    downloads: join(root, "downloads"),
    userData,
    cache: join(root, "cache"),
    logs: join(root, "logs")
  });
  const data = createSeedData(settingsProvider);
  await mkdir(userData, { recursive: true });

  return {
    root,
    userData,
    databasePath,
    data,
    options: { databasePath, settingsProvider }
  };
}

/** 创建不依赖生产 seed 的 SQLite 测试追番。 */
function createTestMyAnime(): MyAnime {
  const timestamp = new Date().toISOString();
  return {
    id: "my-anime-sqlite-test",
    anime: {
      id: "anime-sqlite-test",
      title: "测试番",
      originalTitle: "テストアニメ",
      aliases: [],
      premiereYear: 2026,
      premiereMonth: 7,
      externalIds: {}
    },
    status: "watching",
    autoDownload: false,
    rssSubscriptions: [],
    addedAt: timestamp,
    updatedAt: timestamp
  };
}

/** 创建同根目录名但文件集数不同的 qBittorrent 任务。 */
function createDownloadTask(
  animeId: string,
  hash: string,
  episodeNo?: number,
  fileEpisodeNo = episodeNo ?? 1
) {
  return {
    id: hash,
    animeId,
    episodeId: episodeNo === undefined ? undefined : `episode-${animeId}-${episodeNo}`,
    episodeNo,
    correlationTag: "ani-tracker-shared-tag",
    engine: "qbittorrent" as const,
    torrentHash: hash,
    name: "Same torrent root name",
    status: "seeding" as const,
    progress: 1,
    downloadSpeed: 0,
    uploadSpeed: 0,
    savePath: "/downloads/anime",
    files: [
      {
        id: `${hash}:0`,
        index: 0,
        name: `Same torrent root name/Series S03E0${fileEpisodeNo}.mkv`,
        size: 1024,
        progress: 1,
        priority: 1,
        selected: true
      }
    ],
    createdAt: "2026-07-16T00:00:00.000Z"
  };
}

/** 校验新建数据库的页结构和外键状态。 */
function assertDatabaseIntegrity(databasePath: string): void {
  const database = new DatabaseConstructor(databasePath, { readonly: true });
  try {
    assert.equal(database.pragma("integrity_check", { simple: true }), "ok");
    assert.deepEqual(database.pragma("foreign_key_check"), []);
  } finally {
    database.close();
  }
}
