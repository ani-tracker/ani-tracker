import {
  CapacitorSQLite,
  SQLiteConnection,
  type JsonSQLite,
  type SQLiteDBConnection
} from "@capacitor-community/sqlite";
import type { SqliteDriver, SqliteValue } from "@shared/platform/ports";

const DATABASE_NAME = "ani_tracker";

/** 将 Capacitor Community SQLite 适配为平台无关异步 Driver。 */
export class AndroidSqliteDriver implements SqliteDriver {
  private readonly sqlite = new SQLiteConnection(CapacitorSQLite);
  private connection?: SQLiteDBConnection;

  /** 打开或恢复 Android SQLite 连接。 */
  async open(): Promise<void> {
    if (this.connection && (await this.connection.isDBOpen()).result) {
      return;
    }

    const consistency = await this.sqlite.checkConnectionsConsistency();
    const existing = consistency.result
      ? await this.sqlite.isConnection(DATABASE_NAME, false)
      : { result: false };
    this.connection = existing.result
      ? await this.sqlite.retrieveConnection(DATABASE_NAME, false)
      : await this.sqlite.createConnection(DATABASE_NAME, false, "no-encryption", 1, false);

    if (!(await this.connection.isDBOpen()).result) {
      await this.connection.open();
    }
    console.info("[android-storage] SQLite 连接已打开", { database: DATABASE_NAME });
  }

  /** 关闭 SQLite 连接并释放原生资源。 */
  async close(): Promise<void> {
    if (!this.connection) {
      return;
    }
    if ((await this.connection.isDBOpen()).result) {
      await this.connection.close();
    }
    await this.sqlite.closeConnection(DATABASE_NAME, false);
    this.connection = undefined;
    console.info("[android-storage] SQLite 连接已关闭", { database: DATABASE_NAME });
  }

  /** 执行一组不返回结果的 SQL。 */
  async execute(statements: string): Promise<void> {
    await this.getConnection().execute(statements, false);
  }

  /** 查询并返回对象行。 */
  async query<Row extends Record<string, unknown>>(statement: string, values: SqliteValue[] = []): Promise<Row[]> {
    const result = await this.getConnection().query(statement, values);
    return (result.values ?? []) as Row[];
  }

  /** 执行带绑定参数的写入并返回影响行数。 */
  async run(statement: string, values: SqliteValue[] = []): Promise<number> {
    const result = await this.getConnection().run(statement, values, false);
    return result.changes?.changes ?? 0;
  }

  /** 在原生事务中执行操作，异常时自动回滚。 */
  async transaction<T>(operation: () => Promise<T>): Promise<T> {
    const connection = this.getConnection();
    await connection.beginTransaction();
    try {
      const result = await operation();
      await connection.commitTransaction();
      return result;
    } catch (error) {
      await connection.rollbackTransaction();
      throw error;
    }
  }

  /** 导出完整数据库 JSON，供后续文件备份适配器使用。 */
  async exportFullBackup(): Promise<JsonSQLite> {
    const result = await this.getConnection().exportToJson("full", false);
    if (!result.export) {
      throw new Error("Android SQLite 导出未返回数据");
    }
    return result.export;
  }

  /** 返回已打开连接，防止静默操作未初始化数据库。 */
  private getConnection(): SQLiteDBConnection {
    if (!this.connection) {
      throw new Error("Android SQLite 尚未打开");
    }
    return this.connection;
  }
}
