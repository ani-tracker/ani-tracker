import type { AppSettings } from "../domain";
import type { SqliteDriver } from "../platform/ports";
import { APP_DATA_VERSION } from "./app-data";
import { SQLITE_SCHEMA, SQLITE_SCHEMA_VERSION } from "./sqlite-schema";

export interface SqliteBootstrapResult {
  seeded: boolean;
  schemaVersion: number;
  appDataVersion: number;
}

/** 幂等创建共享结构并在单事务内写入版本和默认设置。 */
export async function bootstrapSqliteDatabase(
  driver: SqliteDriver,
  defaults: AppSettings
): Promise<SqliteBootstrapResult> {
  await driver.execute("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  await driver.execute(SQLITE_SCHEMA);

  const schemaVersion = await readMetaVersion(driver, "schema_version");
  if (schemaVersion > SQLITE_SCHEMA_VERSION) {
    throw new Error(`SQLite 结构版本 ${schemaVersion} 高于当前支持版本 ${SQLITE_SCHEMA_VERSION}`);
  }
  const appDataVersion = await readMetaVersion(driver, "app_data_version");
  if (appDataVersion > APP_DATA_VERSION) {
    throw new Error(`应用数据版本 ${appDataVersion} 高于当前支持版本 ${APP_DATA_VERSION}`);
  }

  const seeded = appDataVersion === 0;
  await driver.transaction(async () => {
    const now = new Date().toISOString();
    if (seeded) {
      await driver.run(
        "INSERT OR IGNORE INTO app_settings (key, value_json, updated_at) VALUES (?, ?, ?)",
        ["settings", JSON.stringify(defaults), now]
      );
    }
    await writeMetaVersion(driver, "schema_version", SQLITE_SCHEMA_VERSION, now);
    await writeMetaVersion(driver, "app_data_version", APP_DATA_VERSION, now);
  });

  return {
    seeded,
    schemaVersion: SQLITE_SCHEMA_VERSION,
    appDataVersion: APP_DATA_VERSION
  };
}

/** 读取非负数据库版本；缺失版本按零处理。 */
async function readMetaVersion(driver: SqliteDriver, key: string): Promise<number> {
  const rows = await driver.query<{ value: string }>("SELECT value FROM app_meta WHERE key = ? LIMIT 1", [key]);
  const value = rows[0]?.value;
  if (value === undefined) {
    return 0;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`SQLite 元数据 ${key} 无效`);
  }
  return parsed;
}

/** 原子写入数据库版本元数据。 */
async function writeMetaVersion(
  driver: SqliteDriver,
  key: string,
  version: number,
  updatedAt: string
): Promise<void> {
  await driver.run(
    `INSERT INTO app_meta (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [key, String(version), updatedAt]
  );
}
