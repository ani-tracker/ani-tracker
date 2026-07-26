import { bootstrapSqliteDatabase } from "@shared/persistence/sqlite-bootstrap";
import { createAndroidDefaultSettings } from "./android-default-settings";
import { AndroidSqliteDriver } from "./android-sqlite-driver";
import { getAndroidDirectories } from "./capacitor-plugins";

export interface AndroidBootstrapResult {
  driver: AndroidSqliteDriver;
  seeded: boolean;
}

/** 初始化 Android 目录、SQLite 结构和首次启动默认设置。 */
export async function bootstrapAndroidApplication(): Promise<AndroidBootstrapResult> {
  console.info("[android-bootstrap] 开始初始化本地数据");
  const directories = await getAndroidDirectories();
  const driver = new AndroidSqliteDriver();
  await driver.open();

  try {
    const result = await bootstrapSqliteDatabase(driver, createAndroidDefaultSettings(directories));
    console.info("[android-bootstrap] 本地数据初始化完成", {
      schemaVersion: result.schemaVersion,
      appDataVersion: result.appDataVersion,
      seeded: result.seeded
    });
    return { driver, seeded: result.seeded };
  } catch (error) {
    await driver.close().catch((closeError) => {
      console.error("[android-bootstrap] 初始化失败后关闭数据库失败", closeError);
    });
    throw error;
  }
}
