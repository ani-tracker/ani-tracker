import { strict as assert } from "node:assert";
import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type Database from "better-sqlite3";
import * as BetterSqlite3Module from "better-sqlite3";
import { GenericDefaultSettingsProvider } from "../../platform/default-settings-provider";
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
  assert.deepEqual((await runtime.repository.listAnimeCatalog())[0].rating, fixture.data.animeCatalog[0].rating);
  assert.equal((await runtime.repository.listMyAnime()).length, fixture.data.myAnime.length);
  assert.equal((await runtime.repository.listDownloads()).length, fixture.data.downloads.length);
  assert.equal((await runtime.repository.listNotifications()).length, fixture.data.notifications.length);
  assert.equal((await runtime.repository.listMediaFiles()).length, fixture.data.mediaFiles.length);
  assert.equal((await runtime.repository.listFansubs()).length, fixture.data.fansubGroups.length);
  assert.equal((await runtime.repository.listSources()).length, fixture.data.sources.length);
  assert.equal((await runtime.repository.getSettings()).storage.databasePath, fixture.databasePath);
  assert.deepEqual(
    (await runtime.repository.listDownloads())[0].files.map((file) => file.id),
    fixture.data.downloads[0].files.map((file) => file.id)
  );

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
