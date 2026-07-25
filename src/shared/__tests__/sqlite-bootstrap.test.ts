import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { AppSettings } from "../domain";
import { APP_DATA_VERSION } from "../persistence/app-data";
import { bootstrapSqliteDatabase } from "../persistence/sqlite-bootstrap";
import { SQLITE_SCHEMA_VERSION } from "../persistence/sqlite-schema";
import type { SqliteDriver, SqliteValue } from "../platform/ports";

const defaults = { marker: "android-defaults" } as unknown as AppSettings;

test("Android SQLite 首次启动写入设置和当前版本", async () => {
  const driver = new MemoryBootstrapDriver();

  const result = await bootstrapSqliteDatabase(driver, defaults);

  assert.equal(result.seeded, true);
  assert.equal(driver.meta.get("schema_version"), String(SQLITE_SCHEMA_VERSION));
  assert.equal(driver.meta.get("app_data_version"), String(APP_DATA_VERSION));
  assert.deepEqual(JSON.parse(driver.settings.get("settings") ?? "null"), defaults);
});

test("Android SQLite 重启保留已有设置且不重复 seed", async () => {
  const driver = new MemoryBootstrapDriver();
  driver.meta.set("schema_version", String(SQLITE_SCHEMA_VERSION));
  driver.meta.set("app_data_version", String(APP_DATA_VERSION));
  driver.settings.set("settings", JSON.stringify({ marker: "existing" }));

  const result = await bootstrapSqliteDatabase(driver, defaults);

  assert.equal(result.seeded, false);
  assert.equal(JSON.parse(driver.settings.get("settings") ?? "null").marker, "existing");
});

test("Android SQLite 拒绝高于当前程序的结构版本", async () => {
  const driver = new MemoryBootstrapDriver();
  driver.meta.set("schema_version", String(SQLITE_SCHEMA_VERSION + 1));

  await assert.rejects(() => bootstrapSqliteDatabase(driver, defaults), /高于当前支持版本/);
});

/** 仅模拟引导 SQL 所需行为，验证版本与事务语义。 */
class MemoryBootstrapDriver implements SqliteDriver {
  readonly meta = new Map<string, string>();
  readonly settings = new Map<string, string>();

  async open(): Promise<void> {}
  async close(): Promise<void> {}
  async execute(): Promise<void> {}

  async query<Row extends Record<string, unknown>>(_statement: string, values: SqliteValue[] = []): Promise<Row[]> {
    const value = this.meta.get(String(values[0]));
    return (value === undefined ? [] : [{ value }]) as unknown as Row[];
  }

  async run(statement: string, values: SqliteValue[] = []): Promise<number> {
    if (statement.includes("app_settings")) {
      const key = String(values[0]);
      if (!this.settings.has(key)) this.settings.set(key, String(values[1]));
      return 1;
    }
    if (statement.includes("app_meta")) {
      this.meta.set(String(values[0]), String(values[1]));
      return 1;
    }
    return 0;
  }

  async transaction<T>(operation: () => Promise<T>): Promise<T> {
    return operation();
  }
}
