import { app } from "electron";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AppSettings } from "@shared/domain";
import type { AppDataFile } from "@shared/persistence/app-data";
import { APP_DATA_VERSION } from "@shared/persistence/app-data";
import { createSeedData } from "./seed-data";

export class AppDataStore {
  private data: AppDataFile | null = null;

  constructor(private readonly configuredFilePath?: string) {}

  async load(): Promise<AppDataFile> {
    if (this.data) {
      return this.data;
    }

    await ensureDir(dirname(this.filePath));

    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as AppDataFile;
      this.data = migrateAppData(parsed);
    } catch {
      this.data = createSeedData();
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

function migrateAppData(data: AppDataFile): AppDataFile {
  const defaults = createSeedData();

  return {
    ...defaults,
    ...data,
    version: APP_DATA_VERSION,
    settings: mergeSettings(defaults.settings, data.settings),
    dashboard: {
      ...defaults.dashboard,
      ...data.dashboard
    },
    updatedAt: data.version === APP_DATA_VERSION ? data.updatedAt : new Date().toISOString()
  };
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
        ...current.download?.qbittorrent
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
    players: current.players ?? defaults.players
  };
}
