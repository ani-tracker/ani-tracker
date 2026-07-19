import { strict as assert } from "node:assert";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type Database from "better-sqlite3";
import * as BetterSqlite3Module from "better-sqlite3";
import type { Anime, MyAnime } from "@shared/domain";
import { GenericDefaultSettingsProvider } from "../../platform/default-settings-provider";
import { createRepositoryRuntime } from "../repository-runtime";

const DatabaseConstructor = (
  (BetterSqlite3Module as unknown as { default?: typeof BetterSqlite3Module }).default ?? BetterSqlite3Module
) as unknown as new (filename: string, options?: Database.Options) => Database.Database;

test("SQLite 刷新番剧别名时重建冲突标识", async () => {
  const fixture = await createFixture();
  const runtime = createRepositoryRuntime(fixture.options);
  await runtime.initialize();
  const anime = createCatalogAnime("bangumi-alias-conflict", 2026, 7, "别名冲突测试番");
  const duplicateAliasId = `${anime.id}-alias-1`;

  await runtime.repository.upsertAnimeCatalog([{
    ...anime,
    aliases: [{
      id: duplicateAliasId,
      animeId: anime.id,
      alias: "旧别名",
      language: "zh",
      priority: 80
    }]
  }]);

  await assert.doesNotReject(() => runtime.repository.upsertAnimeCatalog([{
    ...anime,
    aliases: [{
      id: duplicateAliasId,
      animeId: anime.id,
      alias: "新别名",
      language: "zh",
      priority: 90
    }]
  }]));

  const restored = (await runtime.repository.listAnimeCatalog()).find((item) => item.id === anime.id);
  assert.ok(restored);
  assert.equal(restored.aliases.length, 2);
  assert.equal(new Set(restored.aliases.map((alias) => alias.id)).size, restored.aliases.length);
  assert.ok(restored.aliases.some((alias) => alias.alias === "旧别名"));
  assert.ok(restored.aliases.some((alias) => alias.alias === "新别名"));
  assert.ok(restored.aliases.every((alias) => alias.animeId === anime.id));
  runtime.close();
  assertDatabaseIntegrity(fixture.databasePath);
});

test("SQLite 按月替换目录时保留其他月份和已追番记录", async () => {
  const fixture = await createFixture();
  const runtime = createRepositoryRuntime(fixture.options);
  await runtime.initialize();
  const obsoleteJuly = createCatalogAnime("catalog-july-obsolete", 2096, 7, "待移除七月番");
  const followedJuly = createCatalogAnime("catalog-july-followed", 2096, 7, "已追七月番");
  const august = createCatalogAnime("catalog-august-preserved", 2096, 8, "八月番");
  await runtime.repository.upsertAnimeCatalog([obsoleteJuly, followedJuly, august]);
  await runtime.repository.upsertMyAnime(createTestMyAnime("my-anime-followed-july", followedJuly));

  const replacement = await runtime.repository.replaceAnimeCatalogMonth(2096, 7, [
    { ...followedJuly, title: "已追七月番（已更新）", summary: "刷新后的详情" },
    createCatalogAnime("catalog-july-new", 2096, 7, "新增七月番")
  ]);
  const ids = new Set(replacement.items.map((anime) => anime.id));

  assert.equal(replacement.addedCount, 1);
  assert.equal(replacement.existingCount, 1);
  assert.equal(ids.has(obsoleteJuly.id), false);
  assert.equal(ids.has(august.id), true);
  assert.equal(ids.has(followedJuly.id), true);
  assert.equal(ids.has("catalog-july-new"), true);
  assert.equal(replacement.items.find((anime) => anime.id === followedJuly.id)?.title, "已追七月番（已更新）");
  runtime.close();
  assertDatabaseIntegrity(fixture.databasePath);
});

test("SQLite 按月替换写入失败时回滚原缓存", async () => {
  const fixture = await createFixture();
  const runtime = createRepositoryRuntime(fixture.options);
  await runtime.initialize();
  const cachedJuly = createCatalogAnime("catalog-july-rollback", 2097, 7, "回滚前七月番");
  await runtime.repository.upsertAnimeCatalog([cachedJuly]);
  const invalidAnime = {
    ...createCatalogAnime("catalog-july-invalid", 2097, 7, "无效七月番"),
    title: null as unknown as string
  };

  await assert.rejects(
    runtime.repository.replaceAnimeCatalogMonth(2097, 7, [invalidAnime]),
    /NOT NULL constraint failed: anime_catalog\.title/
  );

  const restored = await runtime.repository.listAnimeCatalog();
  assert.equal(restored.find((anime) => anime.id === cachedJuly.id)?.title, cachedJuly.title);
  assert.equal(restored.some((anime) => anime.id === invalidAnime.id), false);
  runtime.close();
  assertDatabaseIntegrity(fixture.databasePath);
});

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "ani-catalog-repository-"));
  const userData = join(root, "user-data");
  const databasePath = join(userData, "ani-tracker.sqlite");
  const settingsProvider = new GenericDefaultSettingsProvider({
    downloads: join(root, "downloads"),
    userData,
    cache: join(root, "cache"),
    logs: join(root, "logs")
  });
  await mkdir(userData, { recursive: true });
  return { databasePath, options: { databasePath, settingsProvider } };
}

/** 创建用于目录刷新测试的番剧。 */
function createCatalogAnime(id: string, premiereYear: number, premiereMonth: number, title: string): Anime {
  return {
    id,
    title,
    aliases: [],
    premiereYear,
    premiereMonth,
    externalIds: {}
  };
}

/** 创建引用目录番剧的追番测试数据。 */
function createTestMyAnime(id: string, anime: Anime): MyAnime {
  const timestamp = new Date().toISOString();
  return {
    id,
    anime,
    status: "watching",
    autoDownload: false,
    rssSubscriptions: [],
    addedAt: timestamp,
    updatedAt: timestamp
  };
}

/** 校验事务测试结束后的数据库结构与外键。 */
function assertDatabaseIntegrity(databasePath: string): void {
  const database = new DatabaseConstructor(databasePath, { readonly: true });
  try {
    assert.equal(database.pragma("integrity_check", { simple: true }), "ok");
    assert.deepEqual(database.pragma("foreign_key_check"), []);
  } finally {
    database.close();
  }
}
