import { app } from "electron";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AppSettings, ReleaseSourceConfig } from "@shared/domain";
import type { AppDataFile } from "@shared/persistence/app-data";
import { APP_DATA_VERSION } from "@shared/persistence/app-data";
import { logger } from "../logger";
import { createSeedData } from "./seed-data";

const PLATFORM_DEFAULT_SETTINGS_VERSION = 11;
const QBITTORRENT_NOX_DEFAULT_SETTINGS_VERSION = 13;

export class AppDataStore {
  private data: AppDataFile | null = null;

  constructor(private readonly configuredFilePath?: string) {}

  async load(): Promise<AppDataFile> {
    if (this.data) {
      return this.data;
    }

    await ensureDir(dirname(this.filePath));

    let parsed: AppDataFile;
    try {
      const raw = await readFile(this.filePath, "utf8");
      parsed = JSON.parse(raw) as AppDataFile;
    } catch (error) {
      logger.warn("App data file unavailable; creating seed data", {
        path: this.filePath,
        message: getErrorMessage(error)
      });
      this.data = createSeedData();
      await this.save();
      return this.data;
    }

    const migration = migrateAppData(parsed);
    this.data = migration.data;
    if (migration.shouldSave) {
      logger.info("App data migrated", {
        path: this.filePath,
        fromVersion: parsed.version,
        toVersion: this.data.version,
        addedDefaultSourceIds: migration.addedDefaultSourceIds
      });
      await this.save();
    }

    return this.data;
  }

  async getData(): Promise<AppDataFile> {
    return this.load();
  }

  async update(mutator: (data: AppDataFile) => void | Promise<void>): Promise<AppDataFile> {
    const data = await this.load();
    await mutator(data);
    data.updatedAt = new Date().toISOString();
    await this.save();
    return data;
  }

  async save(): Promise<void> {
    if (!this.data) {
      return;
    }

    await ensureDir(dirname(this.filePath));
    const tempPath = `${this.filePath}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(this.data, null, 2)}\n`, "utf8");
    await rename(tempPath, this.filePath);
  }

  getPath(): string {
    return this.filePath;
  }

  private get filePath(): string {
    return this.configuredFilePath ?? getDefaultDataFilePath();
  }
}

function getDefaultDataFilePath(): string {
  return join(app.getPath("userData"), "ani-tracker.json");
}

async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

interface AppDataMigrationResult {
  data: AppDataFile;
  shouldSave: boolean;
  addedDefaultSourceIds: string[];
}

function migrateAppData(data: AppDataFile): AppDataMigrationResult {
  const defaults = createSeedData();
  const shouldResetSettingsToPlatformDefaults = (data.version ?? 0) < PLATFORM_DEFAULT_SETTINGS_VERSION;
  const shouldApplyQbittorrentNoxDefaults = (data.version ?? 0) < QBITTORRENT_NOX_DEFAULT_SETTINGS_VERSION;
  const addedDefaultSourceIds = getMissingDefaultSourceIds(defaults.sources, data.sources);

  if (shouldResetSettingsToPlatformDefaults) {
    logger.info("App settings reset to platform defaults", {
      fromVersion: data.version ?? 0,
      toVersion: APP_DATA_VERSION
    });
  }

  if (shouldApplyQbittorrentNoxDefaults) {
    logger.info("App download defaults migrated to bundled qBittorrent-nox", {
      fromVersion: data.version ?? 0,
      toVersion: APP_DATA_VERSION
    });
  }

  const settings = shouldResetSettingsToPlatformDefaults ? defaults.settings : mergeSettings(defaults.settings, data.settings);
  const migrated: AppDataFile = {
    ...defaults,
    ...data,
    version: APP_DATA_VERSION,
    settings: shouldApplyQbittorrentNoxDefaults
      ? applyQbittorrentNoxDefaults(settings, defaults.settings, data.settings)
      : settings,
    sources: mergeDefaultSources(defaults.sources, data.sources),
    dashboard: {
      ...defaults.dashboard,
      ...data.dashboard
    },
    updatedAt: data.version === APP_DATA_VERSION ? data.updatedAt : new Date().toISOString()
  };

  return {
    data: migrated,
    shouldSave:
      data.version !== APP_DATA_VERSION || shouldApplyQbittorrentNoxDefaults || addedDefaultSourceIds.length > 0,
    addedDefaultSourceIds
  };
}

function applyQbittorrentNoxDefaults(
  settings: AppSettings,
  defaults: AppSettings,
  current?: AppSettings
): AppSettings {
  const usedLegacyEmbeddedDefault =
    !current ||
    (current.download.defaultTorrentEngine === "embedded" &&
      current.download.embedded?.enabled !== false &&
      isDefaultQbittorrentEndpoint(current.download.qbittorrent));
  const usedManagedWithoutAutoStart =
    current?.download.defaultTorrentEngine === "qbittorrent" &&
    current.download.qbittorrent.managed?.enabled === true &&
    current.download.qbittorrent.autoConnect === false &&
    isDefaultQbittorrentEndpoint(current.download.qbittorrent);

  if (!usedLegacyEmbeddedDefault && !usedManagedWithoutAutoStart) {
    return settings;
  }

  return {
    ...settings,
    download: {
      ...settings.download,
      defaultTorrentEngine: defaults.download.defaultTorrentEngine,
      embedded: {
        ...settings.download.embedded,
        enabled: false
      },
      qbittorrent: {
        ...settings.download.qbittorrent,
        baseUrl: settings.download.qbittorrent.baseUrl || defaults.download.qbittorrent.baseUrl,
        username: settings.download.qbittorrent.username || defaults.download.qbittorrent.username,
        password: settings.download.qbittorrent.password || defaults.download.qbittorrent.password,
        autoConnect: true,
        managed: {
          ...settings.download.qbittorrent.managed,
          enabled: true
        }
      }
    }
  };
}

function isDefaultQbittorrentEndpoint(settings: AppSettings["download"]["qbittorrent"] | undefined): boolean {
  if (!settings) {
    return true;
  }

  return (
    normalizeBaseUrl(settings.baseUrl) === "http://127.0.0.1:18080/" &&
    settings.username === "admin" &&
    !settings.password
  );
}

function normalizeBaseUrl(value: string | undefined): string {
  try {
    return new URL(value || "http://127.0.0.1:18080").href;
  } catch {
    return value ?? "";
  }
}

function mergeDefaultSources(defaults: ReleaseSourceConfig[], current?: ReleaseSourceConfig[]): ReleaseSourceConfig[] {
  if (!current) {
    return defaults;
  }

  const sources = [...current];
  for (const source of defaults) {
    if (!sources.some((item) => item.id === source.id)) {
      sources.push(source);
    }
  }

  return sources;
}

function getMissingDefaultSourceIds(defaults: ReleaseSourceConfig[], current?: ReleaseSourceConfig[]): string[] {
  if (!current) {
    return defaults.map((source) => source.id);
  }

  return defaults.filter((source) => !current.some((item) => item.id === source.id)).map((source) => source.id);
}

function mergeSettings(defaults: AppSettings, current?: AppSettings): AppSettings {
  if (!current) {
    return defaults;
  }

  return {
    ...defaults,
    ...current,
    download: {
      ...defaults.download,
      ...current.download,
      embedded: {
        ...defaults.download.embedded,
        ...current.download?.embedded
      },
      qbittorrent: {
        ...defaults.download.qbittorrent,
        ...current.download?.qbittorrent,
        managed: {
          ...defaults.download.qbittorrent.managed,
          ...current.download?.qbittorrent?.managed
        }
      }
    },
    storage: {
      ...defaults.storage,
      ...current.storage
    },
    automation: {
      ...defaults.automation,
      ...current.automation
    },
    media: {
      ...defaults.media,
      ...current.media
    },
    desktop: {
      ...defaults.desktop,
      ...current.desktop
    },
    players: current.players ?? defaults.players
  };
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
