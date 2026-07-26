import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { logger } from "../logger";
import { createDefaultSettingsProvider, type DefaultSettingsProvider } from "../platform/default-settings-provider";
import { createSeedData } from "../storage/seed-data";
import type { AppRepository } from "./app-repository";
import { SqliteAppRepository } from "./sqlite-app-repository";

export interface RepositoryRuntimeOptions {
  databasePath?: string;
  settingsProvider?: DefaultSettingsProvider;
}

export interface RepositoryRuntime {
  repository: AppRepository;
  initialize(): Promise<void>;
  close(): void;
  getBackend(): "pending" | "sqlite";
}

/** 创建延迟初始化的 SQLite Repository，确保 Electron ready 后再读取平台路径。 */
export function createRepositoryRuntime(options: RepositoryRuntimeOptions = {}): RepositoryRuntime {
  let activeRepository: AppRepository | undefined;
  let sqliteRepository: SqliteAppRepository | undefined;
  let backend: "pending" | "sqlite" = "pending";
  const repository = new Proxy({} as AppRepository, {
    get(_target, property) {
      if (!activeRepository) {
        throw new Error("Repository 尚未初始化");
      }
      const value = Reflect.get(activeRepository, property);
      return typeof value === "function" ? value.bind(activeRepository) : value;
    }
  });

  return {
    repository,
    async initialize() {
      if (activeRepository) {
        return;
      }

      const settingsProvider = options.settingsProvider ?? createDefaultSettingsProvider();
      const databasePath = options.databasePath ?? settingsProvider.getSettings().storage.databasePath;
      await mkdir(dirname(databasePath), { recursive: true });

      try {
        const candidate = new SqliteAppRepository(databasePath, { settingsProvider });
        candidate.initializeWithSeed(createSeedData(settingsProvider));
        sqliteRepository = candidate;
        activeRepository = candidate;
        backend = "sqlite";
        logger.info("Application repository ready", { backend, databasePath });
      } catch (error) {
        logger.error("SQLite repository initialization failed", {
          databasePath,
          message: getErrorMessage(error)
        });
        throw error;
      }
    },
    close() {
      sqliteRepository?.close();
    },
    getBackend() {
      return backend;
    }
  };
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
