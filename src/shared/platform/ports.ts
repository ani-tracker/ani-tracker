/** SQLite 可绑定的跨平台基础值。 */
export type SqliteValue = string | number | null;

/** 平台无关的异步 SQLite 访问契约。 */
export interface SqliteDriver {
  open(): Promise<void>;
  close(): Promise<void>;
  execute(statements: string): Promise<void>;
  query<Row extends Record<string, unknown>>(statement: string, values?: SqliteValue[]): Promise<Row[]>;
  run(statement: string, values?: SqliteValue[]): Promise<number>;
  transaction<T>(operation: () => Promise<T>): Promise<T>;
}

/** Android 应用各类私有目录的稳定位置。 */
export interface AppDirectories {
  userDataDir: string;
  databasePath: string;
  filesDir: string;
  downloadDir: string;
  cacheDir: string;
  imageCacheDir: string;
  logDir: string;
  backupDir: string;
}

/** 敏感凭据存储契约，具体平台负责加密与密钥保护。 */
export interface SecureStorePort {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}
