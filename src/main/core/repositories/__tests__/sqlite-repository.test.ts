import { strict as assert } from "node:assert";
import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type Database from "better-sqlite3";
import * as BetterSqlite3Module from "better-sqlite3";
import type { MyAnime } from "@shared/domain";
import { GenericDefaultSettingsProvider } from "../../platform/default-settings-provider";
import { enrichReleaseFromTitle } from "../../releases/release-title-parser";
import { createSeedData } from "../../storage/seed-data";
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
  await first.repository.upsertMyAnime(item);
  const timestamp = new Date().toISOString();
  await first.repository.upsertMyAnime({
    ...item,
    rssSubscriptions: [
      {
        id: "rss-sqlite-test",
        myAnimeId: item.id,
        name: "蜜柑计划",
        url: "https://mikanani.me/RSS/Bangumi?bangumiId=3941",
        enabled: true,
        preferredSubtitle: "cht",
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
  assert.equal(restored?.rssSubscriptions?.[0].preferredSubtitle, "cht");
  second.close();
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
